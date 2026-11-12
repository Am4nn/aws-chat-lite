import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FLOCI_PORT, assertPortFree } from "./ports.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

try {
  assertPortFree(FLOCI_PORT, "floci-chat");
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
// Floci runs each Lambda in a container of its own and leaves them behind, stopped, when it is reset; clear this
// app's before starting so they don't pile up. Stopped containers of anything else are left alone.
const leftovers = spawnSync("docker", ["ps", "-aq", "--filter", "name=floci-aws-cl-local-", "--filter", "status=exited"], { encoding: "utf8" })
  .stdout.split("\n").filter(Boolean);
if (leftovers.length) spawnSync("docker", ["rm", ...leftovers], { stdio: "ignore" });

const res = spawnSync("docker", ["compose", "up", "-d", "--wait"], { cwd: root, stdio: "inherit" });
process.exit(res.status ?? 1);
