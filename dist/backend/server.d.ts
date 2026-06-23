/**
 * backend/server.ts
 * Health check HTTP server for container orchestration (Kubernetes, Docker Swarm).
 * Exposes GET /health — returns 200 when all dependencies are up, 503 otherwise.
 */
import * as http from "http";
export declare function createHealthServer(port?: number): http.Server;
//# sourceMappingURL=server.d.ts.map