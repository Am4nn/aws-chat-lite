const USAGE = "usage: npm run grant -- <username> <group> [--stage=aws]";

/** Arguments of `npm run grant`: who joins which Cognito group, on which stage. */
export function grantArgs(argv: string[]): { username: string; group: string; stage: "local" | "aws" } {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const stageFlag = argv.find((a) => a.startsWith("--stage="))?.slice("--stage=".length) ?? "local";
  const [username, group] = positional;
  if (!username || !group) throw new Error(USAGE);
  if (stageFlag !== "local" && stageFlag !== "aws") throw new Error(`--stage must be local or aws. ${USAGE}`);
  return { username, group, stage: stageFlag };
}
