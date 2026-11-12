import { spawnSync } from "node:child_process";

/** The local stage's ports on this machine: Floci's, and those of the helpers `npm run dev` starts beside the web app. */
export const FLOCI_PORT = 4566;
export const STREAM_PORT = 4600;
export const TRANSCRIBE_PORT = 4601;
export const SANDBOX_PORT = 4700;
export const MCP_TEST_PORT = 4710;

/** Name of the container publishing `port` on the host, from `docker ps --format "{{.Names}}\t{{.Ports}}"`. */
export function portOwner(dockerPs: string, port: number): string | undefined {
  const published = new RegExp(`(0\.0\.0\.0|\[::\]):${port}->`);
  for (const line of dockerPs.split(/\r?\n/)) {
    const [name, ports = ""] = line.split("\t");
    if (name && published.test(ports)) return name;
  }
  return undefined;
}

export function dockerPs(): string {
  const res = spawnSync("docker", ["ps", "--format", "{{.Names}}\t{{.Ports}}"], { encoding: "utf8" });
  if (res.status !== 0) throw new Error("docker ps failed: is Docker Desktop running?");
  return res.stdout;
}

/** Only one project's Floci can run at a time: refuse when another container holds the port. */
export function assertPortFree(port: number, allowed: string, ps: string = dockerPs()): void {
  const owner = portOwner(ps, port);
  if (owner && owner !== allowed) {
    throw new Error(`Port ${port} is held by container ${owner}: stop that project's Floci first (npm run floci:down in its repo)`);
  }
}
