/** Runs a command's `main`, so a failure prints only its message (a refusal reads as one line) and exits 1. */
export function run(main: () => Promise<unknown>): void {
  main().catch((e) => {
    console.error(String(e.message ?? e));
    process.exit(1);
  });
}
