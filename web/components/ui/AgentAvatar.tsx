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

/** A quiet tag after an agent's name, so its words never pass for a person's. */
export function AiTag() {
  return <span className="shrink-0 self-center rounded bg-surface-3 px-[5px] font-mono text-[10px] font-normal leading-4 text-text-2">AI</span>;
}
