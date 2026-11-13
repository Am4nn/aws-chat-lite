/** Muted grounds, each with a lighter shade of its hue for the initials, so a person's colour reads at any size. */
const TINTS = [
  { background: "#2b3530", color: "#a9d6bf" },
  { background: "#3d3326", color: "#e8c592" },
  { background: "#233240", color: "#8fc7e8" },
  { background: "#3a2834", color: "#eaa6c1" },
  { background: "#2e2f3d", color: "#b7b9ee" },
  { background: "#33302a", color: "#d6cba9" },
];

/**
 * Initials on a colour pair picked from the name, so the same person always gets the same colour. A username has no
 * spaces, so its parts are what separators split ("aman_k" is AK); a one-word name shows its first letter. `online`
 * adds a static dot; presence never pulses.
 */
export function Avatar({ name, ring = false, size = 26, online = false }: { name: string; ring?: boolean; size?: number; online?: boolean }) {
  const hash = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const parts = name.split(/[-_.]+/).filter(Boolean);
  const initials = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 1);
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, ...TINTS[hash % TINTS.length], fontSize: size * 0.42 }}
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full font-bold uppercase ${ring ? "ring-2 ring-ink" : ""}`}
    >
      {initials}
      {online && <span className="absolute -bottom-px -right-px size-2.5 rounded-full bg-lime ring-2 ring-ink" />}
    </span>
  );
}
