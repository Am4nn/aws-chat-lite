import type { Member } from "../types";

export type Mentionable = Pick<Member, "userId" | "username">;

const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Finds `@name` and `@everyone` in plain text. A preceding word character means an email, not a mention. */
export function findMentions(text: string, members: Mentionable[]) {
  const names = ["everyone", ...members.map((m) => m.username)].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<!\\w)@(${names.map(escape).join("|")})(?!\\w)`, "gi");
  return [...text.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length, name: m[1].toLowerCase() }));
}

/** Finds `@agent` in plain text the way the server routes it: the name ends where the mention does, so `@scout-team` never names `@scout`. */
export function findAgentMentions(text: string, agents: string[]) {
  if (!agents.length) return [];
  const re = new RegExp(`(?<!\\w)@(${agents.map(escape).join("|")})(?![\\w-])`, "gi");
  return [...text.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length, name: m[1].toLowerCase() }));
}

/** The text with its code blanked out, so what's found in it is where it is in the text. */
export const outsideCode = (text: string) => text.replace(CODE, (code) => " ".repeat(code.length));

export function parseMentions(text: string, members: Mentionable[]) {
  const found = findMentions(outsideCode(text), members);
  const ids = new Set<string>();
  for (const { name } of found) {
    const member = members.find((m) => m.username.toLowerCase() === name);
    if (member) ids.add(member.userId);
  }
  return { mentions: [...ids], everyone: found.some((f) => f.name === "everyone") };
}

/** A row of the `@` or `#` list; a thread's carries its number, and a `#` row the `tag` a pick puts in after the `#`. */
export type MentionOption = { name: string; kind: "agent" | "everyone" | "member" | "thread" | "chat"; number?: number; tag?: string };

const MENTION_OPTIONS = 6;

/** The `@` list for what was typed: the room's agents first, then everyone, then the other people. */
export function mentionOptions(query: string, { agents, members, meId }: {
  agents: { name: string }[]; members: Mentionable[]; meId: string;
}): MentionOption[] {
  const all: MentionOption[] = [
    ...agents.map((a) => ({ name: a.name, kind: "agent" as const })),
    { name: "everyone", kind: "everyone" },
    ...members.filter((m) => m.userId !== meId).map((m) => ({ name: m.username, kind: "member" as const })),
  ];
  return all.filter((o) => o.name.toLowerCase().startsWith(query.toLowerCase())).slice(0, MENTION_OPTIONS);
}

/**
 * The `@name` or `#tag` being typed just before the caret, for autocomplete: `start` is where the `trigger` sits.
 * Inside a code span, or right after a word character (an email), it is neither.
 */
export function mentionQuery(beforeCaret: string): { start: number; query: string; trigger: "@" | "#" } | null {
  const m = /(?<![\w`])([@#])([\w.-]*)$/.exec(beforeCaret);
  if (!m || (beforeCaret.match(/`/g)?.length ?? 0) % 2 === 1) return null;
  return { start: m.index, query: m[2], trigger: m[1] as "@" | "#" };
}
