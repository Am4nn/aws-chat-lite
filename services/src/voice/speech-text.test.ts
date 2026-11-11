import { describe, expect, it } from "vitest";
import { speechChunks, speechText } from "./speech-text.js";

const CUT = " The rest of the answer isn't read aloud.";
const sentences = (n: number) => Array.from({ length: n }, (_, i) => `This is sentence number ${String(i).padStart(4, "0")}.`).join(" ");

describe("speechText", () => {
  it("reads markdown as plain words: markers dropped, link text kept, code blocks skipped", () => {
    expect(speechText("# Hi\n**bold** [docs](https://x.y) `a`\n```js\nx()\n```")).toBe("Hi bold docs a (code block skipped)");
  });

  it("says a bare URL is a link, drops list and quote markers, and keeps underscores inside words", () => {
    expect(speechText("> see https://example.com/a?b=1\n- one_two\n2. _three_ ~~four~~")).toBe("see a link one_two three four");
  });

  it("an answer over 10,000 characters stops at a sentence end and says the rest isn't read", () => {
    const text = speechText(sentences(400));
    expect(text.endsWith(`.${CUT}`)).toBe(true);
    expect(text.length - CUT.length).toBeLessThanOrEqual(10_000);
    expect(text.length - CUT.length).toBeGreaterThan(9_900);
  });

  it("a short answer is never cut", () => {
    expect(speechText(sentences(3))).toBe(sentences(3));
  });
});

describe("speechChunks", () => {
  it("splits 7,000 characters of sentences into 3 chunks of at most 2,800, each ending a sentence", () => {
    const text = sentences(7000 / 30);
    const chunks = speechChunks(text);
    expect(chunks).toHaveLength(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(2800);
      expect(c.endsWith(".")).toBe(true);
    }
    expect(chunks.join(" ")).toBe(text);
  });

  it("without a sentence end it splits at a space, and without a space it cuts hard", () => {
    expect(speechChunks("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
    expect(speechChunks("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
});
