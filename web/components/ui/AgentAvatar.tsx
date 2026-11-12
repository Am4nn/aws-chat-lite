import { Bot } from "lucide-react";

/** An agent's mark: a square tile with a robot glyph, so it never reads as a person (people are round, with initials). */
export function AgentAvatar({ size = 26 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }}
      className="grid shrink-0 place-items-center bg-lime-wash text-lime"
    >
      <Bot size={Math.round(size * 0.5)} />
    </span>
  );
}
