/** Splits `items` into runs whose sizes add up to at most `max`, in order; an item bigger than `max` goes alone. */
export function bySize<T>(items: T[], sizeOf: (item: T) => number, max: number): T[][] {
  const out: T[][] = [];
  let size = Infinity;
  for (const item of items) {
    if (size + sizeOf(item) > max) {
      out.push([]);
      size = 0;
    }
    out.at(-1)!.push(item);
    size += sizeOf(item);
  }
  return out;
}
