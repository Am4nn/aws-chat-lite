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

export function parseMentions(text: string, members: Mentionable[]) {
  const prose = text.replace(CODE, (code) => " ".repeat(code.length));
  const found = findMentions(prose, members);
  const ids = new Set<string>();
  for (const { name } of found) {
    const member = members.find((m) => m.username.toLowerCase() === name);
    if (member) ids.add(member.userId);
  }
  return { mentions: [...ids], everyone: found.some((f) => f.name === "everyone") };
}
