import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnswerText } from "./AnswerText";

const html = (text: string, streaming = false) =>
  renderToStaticMarkup(<AnswerText text={text} streaming={streaming} members={[{ userId: "u1", username: "aman" }]} />);

describe("AnswerText", () => {
  it("reads like a chat reply: the first line stays a paragraph, its markdown rendered", () => {
    const out = html("Yo @aman! Here's the rating for **chat-lite**:\n\n- fast");
    expect(out).not.toContain("<h2");
    expect(out).toContain("<strong>chat-lite</strong>");
    expect(out).toContain('<span class="mention text-lime">@aman</span>');
    expect(out).toMatch(/<li[^>]*>fast<\/li>/);
  });
  it("renders markdown while streaming, holding back only the word still arriving", () => {
    const out = html("Some **x** and a parti", true);
    expect(out).toContain("<strong>x</strong>");
    expect(out).not.toContain("**");
    expect(out).not.toContain("parti");
    expect(html("Some **x** and a parti")).toContain("parti");
  });
});
