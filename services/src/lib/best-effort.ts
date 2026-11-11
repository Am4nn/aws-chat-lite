/** Once the write that matters has happened, a failed cleanup or broadcast is logged rather than failing the caller. */
export async function bestEffort(what: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (e) {
    console.error(`${what} failed`, e);
  }
}
