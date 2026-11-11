import { fileURLToPath } from "node:url";
import { dockerSandbox, runDocker, SANDBOX_IMAGE } from "../../services/src/sandbox/docker.js";
import { startSandboxServer } from "../../services/src/sandbox/server.js";

/**
 * The sandbox for the local stage, on http://localhost:4700: Floci's Lambdas run in containers that can't start
 * containers themselves, so they call this server (at host.docker.internal), which drives Docker on this machine.
 */
export async function startLocalSandboxServer() {
  if ((await runDocker(["image", "inspect", SANDBOX_IMAGE])).code !== 0) {
    console.error("Build the sandbox image first: npm run sandbox:build");
    process.exit(1);
  }
  const server = startSandboxServer(dockerSandbox());
  server.once("listening", () => console.log("Sandbox: http://localhost:4700 (Docker)"));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await startLocalSandboxServer();
