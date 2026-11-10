type Member = { userId: string; username: string };

const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
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
