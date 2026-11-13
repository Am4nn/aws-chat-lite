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
  it("shows a thread tag as a sky pill, apart from a chat's plain sky link and a lime @mention", () => {
    const threadClass = /<a [^>]*class="([^"]*)"[^>]*>#pr-check</.exec(tagged("see #4"))![1]!.split(" ");
    expect(threadClass).toEqual(expect.arrayContaining(["rounded-full", "text-sky", "bg-sky/10", "px-1.5"]));
    expect(threadClass.some((c) => c.startsWith("font-mono") || c === "border")).toBe(false);
    const chatClass = /<a [^>]*class="([^"]*)"[^>]*>#general</.exec(tagged("over in #general"))![1]!.split(" ");
    expect(chatClass).toContain("text-sky");
    expect(chatClass).not.toContain("rounded-full");
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

describe("MessageText agent mentions", () => {
  const agents = ["scout", "critic"];
  const out = (text: string, lead?: string) => renderToStaticMarkup(<MessageText text={text} members={members} agents={agents} lead={lead} />);
  it("highlights the agent that leads the thread the message started, and the others as mentions", () => {
    const html = out("@scout @critic review this", "scout");
    expect(html).toContain('<span class="mention-lead rounded-full bg-lime/15 px-1.5 py-px font-medium text-lime" title="Leads the thread">@scout</span>');
    expect(html).toContain('<span class="mention text-lime">@critic</span>');
  });
  it("marks the thread's agent as lead wherever the text names it", () =>
    expect(out("@scout then @critic", "critic")).toContain('title="Leads the thread">@critic</span>'));
  it("takes no longer name for an agent's", () => expect(out("@scout-team, @critic go", "scout")).not.toContain("@scout</span>"));
  it("shows no lead for a message that started no thread", () => expect(out("@scout @critic")).not.toContain("mention-lead"));
});

describe("MessageText rich, for agent answers", () => {
  const tags: RoomTags = { roomId: "r1", threads: [{ number: 4, name: "pr-check" }], chats: [] };
  const rich = (text: string) => renderToStaticMarkup(
    <RoomTagsContext value={tags}><MessageText rich text={text} members={members} agents={["scout"]} /></RoomTagsContext>,
  ).replace(/\n/g, "");

  it("renders lists, nested ones and an ordered list's start", () => {
    const out = rich("- one\n  - inner\n- two\n\n3. third");
    expect(out).toMatch(/<ul[^>]*><li[^>]*>one<ul[^>]*><li[^>]*>inner<\/li><\/ul><\/li><li[^>]*>two<\/li><\/ul>/);
    expect(out).toMatch(/<ol start="3"[^>]*><li[^>]*>third<\/li><\/ol>/);
  });
  it("keeps a single line break", () => expect(rich("**Threads:** yes\n**Tools:** too")).toMatch(/yes<br\/><strong/));
  it("renders headings as modest tags", () => {
    const out = rich("# Big\n## Mid\n### Small");
    expect(out).toMatch(/<h1 class="[^"]*text-\[19px\][^"]*">Big<\/h1>/);
    expect(out).toMatch(/<h2 class="[^"]*text-\[17px\][^"]*">Mid<\/h2>/);
    expect(out).toContain(">Small</h3>");
  });
  it("renders quotes, rules and code blocks", () => {
    const out = rich("> quoted\n\n---\n\n```ts\nconst a = 1;\n```");
    expect(out).toContain("<blockquote");
    expect(out).toContain("<hr");
    expect(out).toMatch(/<pre class="[^"]*overflow-x-auto[^"]*"><code/);
  });
  it("renders a GFM table that scrolls on its own when wide", () => {
    const out = rich("| a | b |\n|---|--:|\n| 1 | 2 |");
    expect(out).toMatch(/<div class="[^"]*overflow-x-auto[^"]*"><table/);
    expect(out).toMatch(/<th[^>]*>a<\/th>/);
    expect(out).toMatch(/<td [^>]*style="text-align:right">2<\/td>/);
  });
  it("decorates mentions and tags inside list items, headings, cells and bold", () => {
    expect(rich("- hi @alice see #4")).toMatch(/<li[^>]*>hi <span class="mention[^"]*">@alice<\/span> see <a [^>]*>#pr-check<\/a><\/li>/);
    expect(rich("## @scout")).toContain('<span class="mention text-lime">@scout</span></h2>');
    expect(rich("| @alice |\n|---|\n| #4 |")).toMatch(/<td[^>]*><a [^>]*>#pr-check<\/a><\/td>/);
    expect(rich("**@alice**")).toContain('<strong><span class="mention text-lime">@alice</span></strong>');
  });
  it("refuses javascript: links and raw html", () => {
    expect(rich("[x](javascript:alert(1))")).not.toContain('href="javascript');
    expect(rich("<script>x</script>")).not.toContain("<script");
  });
});
