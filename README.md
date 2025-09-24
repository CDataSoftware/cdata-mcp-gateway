# CData MCP Gateway

A lightweight HTTP streaming gateway that bridges CData's stdio-based MCP servers with HTTP-based MCP clients like the MCP Inspector.

## Overview

This gateway enables HTTP clients to communicate with CData MCP Servers (like Salesforce, SQL Server, etc.) that use stdio transport. It handles:

- Protocol translation between HTTP streaming and stdio
- Session management for multiple concurrent clients
- Interception of unsupported MCP methods

## Features

- **HTTP to stdio bridge**: Translates HTTP streaming requests to stdio communication
- **Session management**: Maintains a default shared session for all requests
- **Method interception**: Handles methods that CData servers don't implement (resources/list, logging/setLevel)
- **Environment-based configuration**: Uses .env file for configuration
- **Full tool support**: CData server properly returns all tools with connection name prefixes

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file:

```env
# Server Configuration
PORT=3000
LOG_LEVEL=info

# MCP Server Configuration
# For CData MCP Servers (Salesforce as an example)

# Windows
MCP_COMMAND=C:/Program Files/CData/CData MCP Server for Salesforce 2024/jre/bin/java.exe
MCP_ARGS=-jar,C:/Program Files/CData/CData MCP Server for Salesforce 2024/lib/cdata.mcp.salesforce.jar,salesforce_dev

# MacOS
MCP_COMMAND=/Applications/CData MCP Servers for Salesforce 2025.app/Contents/Payload/jre/Contents/Home/bin/java
MCP_ARGS=-Dfile.encoding=UTF-8,-jar,/Applications/CData MCP Servers for Salesforce 2025.app/Contents/Payload/lib/cdata.mcp.salesforce.jar,salesforce_dev
```

The last argument in `MCP_ARGS` is used as the connection name for tool prefixing.

## Usage

### Development
```bash
npm run dev
```

### Production
```bash
npm run build
npm start
```

### With MCP Inspector
```bash
# Start the gateway
npm run dev

# In another terminal, start the MCP Inspector
npx @modelcontextprotocol/inspector http://localhost:3000/mcp
```

## Available Tools

When connected to a CData Salesforce server with connection name `salesforce_dev`:

- `salesforce_dev_get_tables` - List all available tables
- `salesforce_dev_get_columns` - Get column information for a table
- `salesforce_dev_run_query` - Execute SQL SELECT queries
- `salesforce_dev_run_nonquery` - Execute INSERT/UPDATE/DELETE statements
- `salesforce_dev_add_row` - Add a new record to a table

## Architecture

```
MCP (HTTP) Client
         ↓
    HTTP/SSE Transport
         ↓
    MCP Gateway (this project)
         ↓
    stdio Transport
         ↓
CData MCP Server (Java process)
         ↓
    Salesforce/SQL/etc API
```

## File Structure

```
src/
├── gateway.ts    # Main gateway implementation
├── index.ts      # Express server setup
└── logger.ts     # Logging configuration
```

## License

MIT