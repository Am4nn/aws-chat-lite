import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentAvatar } from "./AgentAvatar";

describe("AgentAvatar", () => {
  it("is a square tile with a robot glyph, never a round avatar with initials like a person's", () => {
    const out = renderToStaticMarkup(<AgentAvatar size={22} />);
    expect(out).toContain("lucide-bot");
    expect(out).not.toContain("rounded-full");
    expect(out).toContain("width:22px");
  });
});
