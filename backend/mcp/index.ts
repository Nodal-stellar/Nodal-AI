#!/usr/bin/env node
/* eslint-disable no-restricted-properties */
/**
 * backend/mcp/server.ts - Add npx nodal-ai mcp command entry
 *
 * Compiled to dist/backend/mcp/index.js and exposed as the `nodal-mcp` bin.
 */

// Normalise MCP_TRANSPORT before any module import so logger.ts picks up the
// canonical value.  Treat missing / empty as 'stdio' (the default transport).
if (!process.env.MCP_TRANSPORT) {
  process.env.MCP_TRANSPORT = 'stdio';
}

import { PayFiAgent } from '../agent';
import { config } from '../config';
import { startMCPServer, startMCPHTTPServer } from './server';

if (require.main === module) {
  const agent = new PayFiAgent();
  const transport = config.MCP_TRANSPORT;

  if (transport === 'http') {
    startMCPHTTPServer(agent, config.MCP_PORT);
  } else {
    startMCPServer(agent);
  }
}
