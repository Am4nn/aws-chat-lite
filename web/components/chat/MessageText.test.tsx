import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageText } from "./MessageText";

const members = [{ userId: "u1", username: "alice" }];
const html = (text: string) => renderToStaticMarkup(<MessageText text={text} members={members} />);

describe("MessageText", () => {
  it("renders bold", () => expect(html("**b**")).toContain("<strong>b</strong>"));
  it("drops raw html", () => expect(html("<script>x</script>")).not.toContain("<script"));
  it("does not render headings", () => expect(html("# Title")).not.toContain("<h1"));
  it("refuses javascript: links", () => expect(html("[x](javascript:alert(1))")).not.toContain('href="javascript'));
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
