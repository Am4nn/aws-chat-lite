import { fileURLToPath } from "node:url";
import { startMcpTestServer } from "../../services/src/mcp/testing/server.js";

/**
 * The OAuth MCP test server for the local stage, on port 4710. Floci's Lambdas reach it at host.docker.internal, so
 * that is its origin; the admin's browser can't resolve that name, so the authorize page is sent to localhost.
 */
export async function startLocalMcpTestServer() {
  const server = await startMcpTestServer({ port: 4710, origin: "http://host.docker.internal:4710", publicOrigin: "http://localhost:4710" });
  console.log(`MCP test server: ${server.url} (add it in a room's Connections)`);
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await startLocalMcpTestServer();
