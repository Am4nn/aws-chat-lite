/**
 * Runs a command's `main` and exits 1 on a failure. A refusal prints only its message, so it reads as one line; a bug
 * (a TypeError and the like) prints its stack, since "can't read 'click' of null" alone doesn't say where.
 */
export function run(main: () => Promise<unknown>): void {
  main().catch((e) => {
    const bug = e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError;
    console.error(bug ? String(e.stack) : String(e.message ?? e));
    process.exit(1);
  });
}
