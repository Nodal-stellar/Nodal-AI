/**
 * backend/index.ts
 * Library entry point: re-exports the agent for programmatic use.
 *
 * Importing this module must not start anything (issue #833). Running the
 * service — awaiting config, migrating the database, opening the health
 * server, installing SIGTERM/SIGINT handlers and exiting the process — lives
 * in `backend/main.ts`, which the Dockerfile's CMD executes. Keeping the two
 * entry points separate is what makes `import { PayFiAgent } from 'nodal-ai'`
 * usable from a test, a script or another process without booting a server as
 * a side effect.
 */

export { PayFiAgent } from './agent';
