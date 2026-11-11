import { fileURLToPath } from "node:url";
import { dockerSandbox, prepareDocker, reapSandboxes } from "../../services/src/sandbox/docker.js";
import { startSandboxServer } from "../../services/src/sandbox/server.js";
import { localSandboxToken } from "./sandbox-token.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * The sandbox for the local stage, on http://127.0.0.1:4700: Floci's Lambdas run in containers that can't start
 * containers themselves, so they call this server (at host.docker.internal), which drives Docker on this machine.
 */
export async function startLocalSandboxServer() {
  await prepareDocker().catch((e: Error) => fail(e.message));
  const server = startSandboxServer(dockerSandbox(), { token: localSandboxToken() });
  server.once("error", (e) => fail(`Sandbox server: ${e.message}`));
  // Reaped only once the port is ours, so a second copy that can't listen never removes the first one's sessions.
  server.once("listening", async () => {
    const reaped = await reapSandboxes();
    console.log(`Sandbox: http://127.0.0.1:4700 (Docker)${reaped ? `, removed ${reaped} leftover sessions` : ""}`);
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await startLocalSandboxServer();
