import { fileURLToPath } from "node:url";
import { dockerSandbox, prepareDocker, reapSandboxes } from "../../services/src/sandbox/docker.js";
import { startSandboxServer } from "../../services/src/sandbox/server.js";
import { SANDBOX_PORT } from "./ports.js";
import { localSandboxToken } from "./sandbox-token.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * The sandbox for the local stage, on 127.0.0.1: Floci's Lambdas run in containers that can't start
 * containers themselves, so they call this server (at host.docker.internal), which drives Docker on this machine.
 *
 * Rooms with internet on still run offline here unless SANDBOX_LOCAL_INTERNET=1: an online container can reach this
 * machine's own services, Floci among them, and through Floci the run Lambda's sandbox token and any model keys.
 */
export async function startLocalSandboxServer() {
  await prepareDocker().catch((e: Error) => fail(e.message));
  const allowInternet = process.env.SANDBOX_LOCAL_INTERNET === "1";
  const server = startSandboxServer(dockerSandbox({ allowInternet }), { token: localSandboxToken(), port: SANDBOX_PORT });
  server.once("error", (e) => fail(`Sandbox server: ${e.message}`));
  // Reaped only once the port is ours, so a second copy that can't listen never removes the first one's sessions.
  server.once("listening", async () => {
    const reaped = await reapSandboxes().catch((e: Error) => {
      console.error(`Sandbox: couldn't remove leftover sessions: ${e.message}`);
      return 0;
    });
    const internet = allowInternet ? "internet on for rooms that allow it" : "offline (SANDBOX_LOCAL_INTERNET=1 lets rooms go online)";
    console.log(`Sandbox: http://127.0.0.1:${SANDBOX_PORT} (Docker, ${internet})${reaped ? `, removed ${reaped} leftover sessions` : ""}`);
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await startLocalSandboxServer();
