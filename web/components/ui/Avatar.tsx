const TINTS = ["#2b3530", "#3d3326", "#26313e", "#3a2a33", "#2e2f3d", "#33302a"];

/** Initial on a muted tint picked from the name, so the same person always gets the same colour. */
const SIZE = 26;

export function Avatar({ name, ring = false }: { name: string; ring?: boolean }) {
  const hash = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return (
    <span
      aria-hidden="true"
      style={{ width: SIZE, height: SIZE, background: TINTS[hash % TINTS.length], fontSize: SIZE * 0.42 }}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold uppercase text-text ${ring ? "ring-2 ring-ink" : ""}`}
    >
      {name.slice(0, 1)}
    </span>
  );
}
