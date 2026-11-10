const TINTS = ["#2b3530", "#3d3326", "#26313e", "#3a2a33", "#2e2f3d", "#33302a"];

/**
 * Initial on a muted tint picked from the name, so the same person always gets the same colour. `online` adds a
 * static dot; presence never pulses.
 */
export function Avatar({ name, ring = false, size = 26, online = false }: { name: string; ring?: boolean; size?: number; online?: boolean }) {
  const hash = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, background: TINTS[hash % TINTS.length], fontSize: size * 0.42 }}
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full font-bold uppercase text-text ${ring ? "ring-2 ring-ink" : ""}`}
    >
      {name.slice(0, 1)}
      {online && <span className="absolute -bottom-px -right-px size-2.5 rounded-full bg-lime ring-2 ring-ink" />}
    </span>
  );
}
