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
const res = spawnSync("docker", ["compose", "up", "-d", "--wait"], { cwd: root, stdio: "inherit" });
process.exit(res.status ?? 1);
