/**
 * backend/mcp/server.ts - Add npx nodal-ai mcp command entry
 */

import { PayFiAgent } from '../agent';
import { startMCPServer, startMCPHTTPServer } from './server';

if (require.main === module) {
  const agent = new PayFiAgent();
  const transport = process.env.MCP_TRANSPORT || 'stdio';

  if (transport === 'http') {
    const port = parseInt(process.env.MCP_PORT || '3001', 10);
    startMCPHTTPServer(agent, port);
  } else {
    startMCPServer(agent);
  }
}
