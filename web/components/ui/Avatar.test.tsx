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
});
