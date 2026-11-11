/** Polly bills every character it reads, so a long answer is read only up to here. */
const MAX_SPEECH_CHARS = 10_000;
/** Polly takes at most 3,000 characters a request; the margin leaves room for its own counting of entities. */
const POLLY_CHUNK_CHARS = 2_800;

const CUT_NOTE = " The rest of the answer isn't read aloud.";

/** Where to cut `text` so the first part has at most `max` characters: after a sentence end, else at a space, else at `max`. */
function cutAt(text: string, max: number): number {
  const head = text.slice(0, max + 1);
  const sentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (sentenceEnd >= 0) return sentenceEnd + 1;
  const space = head.lastIndexOf(" ");
  return space > 0 ? space : max;
}

/**
 * An answer's markdown as the words a listener should hear. Code read out symbol by symbol is noise, so a code block
 * is only announced; a URL is just "a link".
 */
export function speechText(markdown: string): string {
  const text = markdown
    .replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, " (code block skipped) ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/\*+|~~|(?<!\w)_+|_+(?!\w)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= MAX_SPEECH_CHARS) return text;
  return text.slice(0, cutAt(text, MAX_SPEECH_CHARS)) + CUT_NOTE;
}

/** The text in pieces Polly accepts, split where a reader would pause. */
export function speechChunks(text: string, max = POLLY_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const at = cutAt(rest, max);
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
