import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { Request, Response } from 'express';
import { EventEmitter } from 'events';
import { logger } from './logger';
import { randomUUID } from 'crypto';

interface MCPConfig {
  command: string;
  args: string[];
}

interface JSONRPCMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

interface Session {
  id: string;
  process: ChildProcessWithoutNullStreams;
  messageBuffer: string;
  sseResponse?: Response;
  pendingRequests: Map<string | number, (response: JSONRPCMessage) => void>;
  connected: boolean;
}

export class StreamableMCPGateway extends EventEmitter {
  private config: MCPConfig;
  private sessions = new Map<string, Session>();
  private defaultSessionId: string = 'default-session';

  constructor(config: MCPConfig) {
    super();
    this.config = config;
  }

  private async createSession(sessionId: string): Promise<Session> {
    logger.debug('Creating new MCP session:', { sessionId });

    let childProcess;
    try {
      childProcess = spawn(this.config.command, this.config.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      });
    } catch (spawnError) {
      logger.error('Failed to spawn process:', spawnError);
      throw new Error(`Failed to spawn MCP server process: ${spawnError}`);
    }

    const session: Session = {
      id: sessionId,
      process: childProcess,
      messageBuffer: '',
      pendingRequests: new Map(),
      connected: false
    };

    childProcess.stdout.on('data', (data: Buffer) => {
      this.handleStdioData(session, data);
    });

    childProcess.stderr.on('data', (data: Buffer) => {
      const stderr = data.toString();
      logger.error(`Session ${sessionId} stderr:`, stderr);

      // Check for common Java errors
      if (stderr.includes('Error: Unable to access jarfile') ||
          stderr.includes('Could not find or load main class')) {
        logger.error('Java MCP server failed to start - check command and jar path');
      }

      // Also log to console for immediate visibility
      console.error(`[STDERR ${sessionId}]:`, stderr);
    });

    childProcess.on('error', (error) => {
      logger.error(`Session ${sessionId} process error:`, error);
      logger.error('Error details:', {
        code: (error as any).code,
        errno: (error as any).errno,
        syscall: (error as any).syscall,
        path: (error as any).path
      });
      if (session) {
        session.connected = false;
      }
    });

    childProcess.on('exit', (code, signal) => {
      logger.info(`Session ${sessionId} process exited:`, { code, signal });
      session.connected = false;
      this.sessions.delete(sessionId);
    });

    // Mark session as connected immediately - the client will send initialize
    session.connected = true;
    this.sessions.set(sessionId, session);

    return session;
  }

  private handleStdioData(session: Session, data: Buffer) {
    session.messageBuffer += data.toString();

    const lines = session.messageBuffer.split('\n');
    session.messageBuffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line) as JSONRPCMessage;
          this.handleStdioMessage(session, message);
        } catch (error) {
          logger.error('Failed to parse JSON-RPC message:', error, { line });
        }
      }
    }
  }

  private handleStdioMessage(session: Session, message: JSONRPCMessage) {
    if (message.id !== undefined && session.pendingRequests.has(message.id)) {
      const callback = session.pendingRequests.get(message.id)!;
      session.pendingRequests.delete(message.id);
      callback(message);
    }

    if (session.sseResponse) {
      const sseData = `data: ${JSON.stringify(message)}\n\n`;
      session.sseResponse.write(sseData);
    }
  }

  private sendToStdio(session: Session, message: JSONRPCMessage) {
    const data = JSON.stringify(message) + '\n';
    logger.debug(`Sending to stdio for session ${session.id}:`, { method: message.method, id: message.id });
    session.process.stdin.write(data, (error) => {
      if (error) {
        logger.error(`Failed to write to stdin for session ${session.id}:`, error);
      }
    });
  }

  async handleSSE(req: Request, res: Response) {
    // Use default session for inspector connections
    let sessionId = req.query.sessionId as string || req.headers['x-session-id'] as string;

    if (!sessionId) {
      sessionId = this.defaultSessionId;
    }

    logger.debug('SSE connection request', { sessionId });

    let session = this.sessions.get(sessionId);
    if (!session) {
      try {
        session = await this.createSession(sessionId);
        this.sessions.set(sessionId, session);
      } catch (error) {
        logger.error('Failed to create session:', error);
        res.status(500).json({ error: 'Failed to create session' });
        return;
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    session.sseResponse = res;

    res.write(':ok\n\n');

    req.on('close', () => {
      logger.info(`SSE connection closed for session ${sessionId}`);
      if (session && session.sseResponse === res) {
        session.sseResponse = undefined;
      }
    });
  }

  async handleMessage(req: Request, res: Response) {
    // Use default session for inspector connections
    let sessionId = req.query.sessionId as string || req.headers['x-session-id'] as string || req.body.sessionId;

    if (!sessionId) {
      sessionId = this.defaultSessionId;
    }

    let session = this.sessions.get(sessionId);
    if (!session || !session.connected) {
      try {
        session = await this.createSession(sessionId);
        this.sessions.set(sessionId, session);
      } catch (error) {
        logger.error('Failed to create session:', error);
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Failed to create session'
          }
        });
        return;
      }
    }

    if (!session) {
      logger.error('Session is null after creation');
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Session initialization failed'
        }
      });
      return;
    }

    try {
      const message = req.body as JSONRPCMessage;

      logger.debug('POST request received', {
      sessionId,
      method: message.method,
      id: message.id
    });

      if (message.id !== undefined) {
        // Special handling for unsupported methods
        if (message.method === 'logging/setLevel') {
          res.json({
            jsonrpc: '2.0',
            id: message.id,
            result: {}
          });
          return;
        }

        if (message.method === 'resources/list') {
          res.json({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              resources: []
            }
          });
          return;
        }

        const responsePromise = new Promise<JSONRPCMessage>((resolve) => {
          // Add to pending requests BEFORE sending to stdio
          session!.pendingRequests.set(message.id!, resolve);

          // Send to stdio AFTER adding to pending requests
          this.sendToStdio(session, message);

          setTimeout(() => {
            if (session!.pendingRequests.has(message.id!)) {
              session!.pendingRequests.delete(message.id!);
              resolve({
                jsonrpc: '2.0',
                id: message.id,
                error: {
                  code: -32603,
                  message: 'Request timeout'
                }
              });
            }
          }, 30000);
        });

        const response = await responsePromise;
        res.json(response);
      } else {
        // For notifications (no id), we send to stdio but don't wait for response
        this.sendToStdio(session, message);
        // For HTTP transport, we need to return something, but without an ID
        // Return minimal valid JSON that won't trigger validation errors
        res.status(202).json({});
      }
    } catch (error) {
      logger.error('Failed to process message:', error, { body: req.body });
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal error'
        }
      });
    }
  }

  generateSessionId(): string {
    return randomUUID();
  }

  async close() {
    for (const session of this.sessions.values()) {
      session.process.kill('SIGTERM');
    }
    this.sessions.clear();
  }
}