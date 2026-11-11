type Member = { userId: string; username: string };

/** Inline code and fenced blocks, where an `@name` or a `#tag` is just text. */
export const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** An `@` right after a word character is an email address, not a mention. */
function mentioned(text: string, username: string): boolean {
  return new RegExp(`(?<!\\w)@${escapeRegExp(username)}(?!\\w)`, "i").test(text);
}

export function parseMentions(text: string, members: Member[]): { mentions: string[]; everyone: boolean } {
  const plain = text.replace(CODE, " ");
  return {
    mentions: [...new Set(members.filter((m) => mentioned(plain, m.username)).map((m) => m.userId))],
    everyone: mentioned(plain, "everyone"),
  };
}

/** Who a message's mentions reach: the whole room for @everyone, otherwise the members it names; never its author. */
export function notified(m: { mentions: string[]; everyone: boolean }, members: Member[], authorId: string): string[] {
  const ids = m.everyone ? members.map((x) => x.userId) : m.mentions;
  return ids.filter((id) => id !== authorId);
}
