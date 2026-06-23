"use strict";
/**
 * backend/server.ts
 * Health check HTTP server for container orchestration (Kubernetes, Docker Swarm).
 * Exposes GET /health — returns 200 when all dependencies are up, 503 otherwise.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHealthServer = createHealthServer;
const http = __importStar(require("http"));
const rpc_client_1 = require("./rpc_client");
const client_1 = require("./db/client");
const HEALTH_PATH = "/health";
async function checkRpc() {
    try {
        await rpc_client_1.horizonServer.fetchBaseFee();
        return "up";
    }
    catch {
        return "down";
    }
}
async function checkDatabase() {
    try {
        const ok = await client_1.db.healthCheck();
        return ok ? "up" : "down";
    }
    catch {
        return "down";
    }
}
function createHealthServer(port = 3001) {
    const server = http.createServer(async (req, res) => {
        // Exclude health endpoint from standard request logging to prevent log spam
        if (req.method !== "GET" || req.url !== HEALTH_PATH) {
            res.writeHead(404);
            res.end();
            return;
        }
        const [rpc, database] = await Promise.all([checkRpc(), checkDatabase()]);
        const allUp = rpc === "up" && database === "up";
        const statusCode = allUp ? 200 : 503;
        const body = {
            status: allUp ? "ok" : "degraded",
            components: { rpc, database },
        };
        const payload = JSON.stringify(body);
        res.writeHead(statusCode, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
        });
        res.end(payload);
    });
    server.listen(port, () => {
        console.log(`[HealthServer] Listening on :${port}${HEALTH_PATH}`);
    });
    return server;
}
//# sourceMappingURL=server.js.map