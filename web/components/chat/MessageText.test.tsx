import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RoomTagsContext, type RoomTags } from "@/lib/client/roomTags";
import { MessageText } from "./MessageText";

const members = [{ userId: "u1", username: "alice" }];
const html = (text: string) => renderToStaticMarkup(<MessageText text={text} members={members} />);

describe("MessageText", () => {
  it("renders bold", () => expect(html("**b**")).toContain("<strong>b</strong>"));
  it("drops raw html", () => expect(html("<script>x</script>")).not.toContain("<script"));
  it("does not render headings", () => expect(html("# Title")).not.toContain("<h1"));
  it("refuses javascript: links", () => expect(html("[x](javascript:alert(1))")).not.toContain('href="javascript'));
  it("links http(s) only, not mailto:", () => expect(html("[x](mailto:a@b.co)")).not.toContain("href"));
  it("opens http links safely in a new tab", () => {
    const out = html("[x](https://example.com)");
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });
  it("highlights member mentions only", () => {
    expect(html("hi @alice")).toContain('class="mention');
    expect(html("hi @stranger")).not.toContain("mention");
    expect(html("@everyone")).toContain('class="mention');
  });
  it("leaves mentions inside code alone", () => expect(html("`@alice`")).not.toContain("mention"));
});

describe("MessageText #tags", () => {
  const tags: RoomTags = { roomId: "r1", threads: [{ number: 4, name: "pr-check" }], chats: [{ chatId: "c1", name: "general" }] };
  const tagged = (text: string) =>
    renderToStaticMarkup(<RoomTagsContext value={tags}><MessageText text={text} members={members} /></RoomTagsContext>);

  it("links a thread number under its current name", () => {
    const out = tagged("see #4");
    expect(out).toMatch(/<a [^>]*href="\/r\/r1\/t\/4"[^>]*>#pr-check<\/a>/);
  });
  it("leaves a number no thread has as text", () => expect(tagged("see #99")).not.toContain("<a"));
  it("links a chat by name", () => expect(tagged("over in #general")).toMatch(/href="\/r\/r1\/c\/c1"[^>]*>#general</));
  it("leaves unknown names and code alone", () => {
    expect(tagged("#nope")).not.toContain("<a");
    expect(tagged("`#4`")).not.toContain("<a");
  });
  it("keeps mentions next to tags", () => {
    const out = tagged("@alice see #4");
    expect(out).toContain('class="mention');
    expect(out).toContain(">#pr-check</a>");
  });
});
