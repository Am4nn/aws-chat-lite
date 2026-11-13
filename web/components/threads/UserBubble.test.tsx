import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UserBubble } from "./UserBubble";

const bubble = (authorName?: string) => renderToStaticMarkup(
  <UserBubble text="ship it" attachments={[]} members={[]} authorName={authorName} enter={false} />,
);

describe("UserBubble", () => {
  it("tints my own message faintly lime, with no name or avatar", () => {
    const out = bubble();
    expect(out).toContain("bg-me-bubble");
    expect(out).not.toContain("rounded-full");
  });

  it("gives someone else's message their avatar and name, and no tint", () => {
    const out = bubble("kira");
    expect(out).toContain(">kira</span>");
    expect(out).toContain("rounded-full");
    expect(out).not.toContain("bg-me-bubble");
  });
});
