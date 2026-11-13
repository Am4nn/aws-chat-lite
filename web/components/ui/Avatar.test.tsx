// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar } from "./Avatar";

afterEach(cleanup);

const letters = (name: string) => render(<Avatar name={name} />).container.textContent;

describe("Avatar", () => {
  it("shows the initials of a name in parts, and the first letter of a one-word name", () => {
    expect(letters("aman_k")).toBe("ak");
    cleanup();
    expect(letters("bea-lee.x")).toBe("bl");
    cleanup();
    expect(letters("aman")).toBe("a");
  });

  it("gives each name one colour pair, a muted ground with its initials in a lighter shade of it", () => {
    const style = (name: string) => (render(<Avatar name={name} />).container.firstChild as HTMLElement).style;
    const kira = style("kira");
    expect(kira.background).not.toBe("");
    expect(kira.color).not.toBe("");
    expect(kira.color).not.toBe(kira.background);
    cleanup();
    const again = style("kira");
    expect([again.background, again.color]).toEqual([kira.background, kira.color]);
  });
});
