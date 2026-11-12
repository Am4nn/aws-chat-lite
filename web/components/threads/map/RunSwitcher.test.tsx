import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RunSwitcher } from "./RunSwitcher";

vi.mock("next/navigation", () => ({ usePathname: () => "/r/room/t/1" }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: unknown }) => <a href={href} {...rest}>{children as never}</a> }));

const runs = [{ runId: "r1", prompt: "check PR 41" }, { runId: "r2", prompt: "summarise the diff" }, { runId: "r3", prompt: "" }];

describe("RunSwitcher", () => {
  it("says which run is shown and links to the ones either side", () => {
    const out = renderToStaticMarkup(<RunSwitcher runs={runs} shown="r2" />);
    expect(out).toContain("Run 2 of 3");
    expect(out).toContain("summarise the diff");
    expect(out).toContain('href="/r/room/t/1?view=map&amp;run=r1"');
    expect(out).toContain('href="/r/room/t/1?view=map&amp;run=r3"');
  });

  it("has nothing to go to past either end", () => {
    const first = renderToStaticMarkup(<RunSwitcher runs={runs} shown="r1" />);
    expect(first).toMatch(/aria-label="Earlier run"[^>]*aria-disabled="true"/);
    const last = renderToStaticMarkup(<RunSwitcher runs={runs} shown="r3" />);
    expect(last).toMatch(/aria-label="Later run"[^>]*aria-disabled="true"/);
  });

  it("shows nothing for a thread with one run", () => {
    expect(renderToStaticMarkup(<RunSwitcher runs={runs.slice(0, 1)} shown="r1" />)).toBe("");
  });
});
