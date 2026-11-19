/**
 * backend/mcp/server.ts - Add npx nodal-ai mcp command entry
 */

import { PayFiAgent } from '../agent';
import { config } from '../config';
import { startMCPServer, startMCPHTTPServer } from './server';

if (require.main === module) {
  const agent = new PayFiAgent();

  if (config.MCP_TRANSPORT === 'http') {
    startMCPHTTPServer(agent, config.MCP_PORT);
  } else {
    startMCPServer(agent);
  }
}
