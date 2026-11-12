// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button, buttonClass } from "./Button";

afterEach(cleanup);

describe("Button", () => {
  it("while busy is disabled and marked busy, with one spinner over the label it keeps", () => {
    render(<Button busy>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toBe("Save");
    expect(button.querySelectorAll("svg")).toHaveLength(1);
  });

  it("keeps the label in the same element whether busy or not, so the width can't change", () => {
    const { rerender } = render(<Button>Save</Button>);
    const label = screen.getByText("Save");
    expect(screen.getByRole("button").querySelector("svg")).toBeNull();
    expect(screen.getByRole("button").hasAttribute("aria-busy")).toBe(false);
    rerender(<Button busy>Save</Button>);
    expect(screen.getByText("Save")).toBe(label);
    expect(label.className).toContain("opacity-0");
  });

  it("stays disabled when told to, busy or not", () => {
    render(<Button disabled>Save</Button>);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("dims every variant the same way when disabled, and lights up on hover only when enabled", () => {
    for (const variant of ["primary", "ghost", "danger", "amber"] as const) {
      const cls = buttonClass({ variant });
      expect(cls).toContain("disabled:not-aria-busy:opacity-50");
      expect(cls).not.toMatch(/(^|\s)hover:/);
    }
  });

  it("takes its height from size, not from className", () => {
    render(<Button size="sm" className="ml-auto">New</Button>);
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("h-8");
    expect(cls).not.toContain("h-9");
    expect(cls).toContain("ml-auto");
  });
});
