type Removal<T> = { list: T[]; item: T; key: (x: T) => string; set: (change: (list: T[]) => T[]) => void };

/**
 * Takes `item` out of the list on the tap, then asks the server. A refusal puts it back at the place it held (unless
 * a refetch already has) and rethrows, so the caller can say why.
 */
export async function removeOptimistically<T>({ list, item, key, set }: Removal<T>, request: () => Promise<unknown>): Promise<void> {
  const id = key(item);
  const index = list.findIndex((x) => key(x) === id);
  set((l) => l.filter((x) => key(x) !== id));
  try {
    await request();
  } catch (e) {
    set((l) => (l.some((x) => key(x) === id) ? l : l.toSpliced(index, 0, item)));
    throw e;
  }
}
