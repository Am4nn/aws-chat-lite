import { fileURLToPath } from "node:url";
import { useLocalEnv } from "./env.js";
import { STREAM_PORT } from "./ports.js";
import { startStreamServer } from "../../services/src/runs/stream-server.js";

/**
 * The run stream for the local stage, on localhost: Floci's Function URLs return no streamed body, so the
 * stream code runs here, in a Node server reading the Floci table.
 */
export function startLocalStreamServer() {
  useLocalEnv();
  process.env.TABLE_NAME = "cl-local-main";
  const server = startStreamServer(STREAM_PORT);
  server.once("listening", () => console.log(`Run stream: http://localhost:${STREAM_PORT}`));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) startLocalStreamServer();
