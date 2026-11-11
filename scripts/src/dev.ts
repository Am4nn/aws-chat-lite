import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startLocalStreamServer } from "./stream-local.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

// npm sets npm_execpath to its own CLI script; running it with node needs no shell, so the space in the path is safe.
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this through npm: npm run dev");

const stream = startLocalStreamServer();
const web = spawn(process.execPath, [npmCli, "-w", "web", "run", "dev"], { cwd: root, stdio: "inherit" });

function stopStream() {
  stream.closeAllConnections();
  stream.close();
}

// Ctrl+C reaches both processes; once the web server has gone, open streams are cut and this process exits too.
web.on("exit", (code) => {
  stopStream();
  process.exit(code ?? 0);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => web.kill(signal));
