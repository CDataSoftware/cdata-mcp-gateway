import express from 'express';
import cors from 'cors';
import { StreamableMCPGateway } from './gateway';
import { logger } from './logger';
import * as dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const gateway = new StreamableMCPGateway({
  command: process.env.MCP_COMMAND!,
  args: process.env.MCP_ARGS ? process.env.MCP_ARGS.split(',') : []
});

app.get('/mcp', async (req, res) => {
  try {
    await gateway.handleSSE(req, res);
  } catch (error) {
    logger.error('Error handling SSE request:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

app.post('/mcp', async (req, res) => {
  try {
    await gateway.handleMessage(req, res);
  } catch (error) {
    logger.error('Error handling message request:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

app.post('/mcp/session', (req, res) => {
  const sessionId = gateway.generateSessionId();
  res.json({ sessionId });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    transport: 'streamable-http'
  });
});

async function start() {
  app.listen(PORT, () => {
    logger.info(`Streamable MCP Gateway listening on port ${PORT}`);
    logger.info(`HTTP endpoint: http://localhost:${PORT}/mcp`);
  });
}

process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  await gateway.close();
  process.exit(0);
});

start();