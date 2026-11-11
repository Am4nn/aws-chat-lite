import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startLocalMcpTestServer } from "./mcp-test-local.js";
import { startLocalSandboxServer } from "./sandbox-local.js";
import { startLocalStreamServer } from "./stream-local.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

// npm sets npm_execpath to its own CLI script; running it with node needs no shell, so the space in the path is safe.
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this through npm: npm run dev");

const sandbox = await startLocalSandboxServer();
const mcp = await startLocalMcpTestServer();
const stream = startLocalStreamServer();
const web = spawn(process.execPath, [npmCli, "-w", "web", "run", "dev"], { cwd: root, stdio: "inherit" });

function stopServers() {
  for (const server of [stream, sandbox]) {
    server.closeAllConnections();
    server.close();
  }
  void mcp.close();
}

// Ctrl+C reaches both processes; once the web server has gone, open streams, sandbox and MCP calls are cut and this process exits too.
web.on("exit", (code) => {
  stopServers();
  process.exit(code ?? 0);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => web.kill(signal));
