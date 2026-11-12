// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { clickTarget, placeOf, skeletonKind } from "./navTarget";

const HERE = "http://localhost:3000/r/r1/c/c1";

function link(href: string, attrs: Record<string, string> = {}) {
  const a = document.createElement("a");
  a.href = href;
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  const icon = document.createElement("span");
  a.append(icon);
  return { a, icon };
}

const click = (target: EventTarget | null, change: Partial<Parameters<typeof clickTarget>[0]> = {}) =>
  ({ defaultPrevented: true, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target, ...change });

describe("clickTarget", () => {
  it("is where a link Next took over leads, path and search, even from a child of the link", () => {
    expect(clickTarget(click(link("/r/r1/c/c2").icon), HERE)).toBe("/r/r1/c/c2");
    expect(clickTarget(click(link("/r/r1/t/4?view=map").a), HERE)).toBe("/r/r1/t/4?view=map");
  });

  it("ignores a click Next didn't take (it isn't an in-app navigation)", () => {
    expect(clickTarget(click(link("/r/r1/c/c2").a, { defaultPrevented: false }), HERE)).toBeNull();
  });

  it("ignores anything but a plain left click, which opens a tab or a window instead", () => {
    const { a } = link("/r/r1/c/c2");
    for (const change of [{ button: 1 }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }]) {
      expect(clickTarget(click(a, change), HERE), JSON.stringify(change)).toBeNull();
    }
  });

  it("ignores links that open elsewhere, download, or leave the site", () => {
    expect(clickTarget(click(link("/r/r1/c/c2", { target: "_blank" }).a), HERE)).toBeNull();
    expect(clickTarget(click(link("/files/a.txt", { download: "" }).a), HERE)).toBeNull();
    expect(clickTarget(click(link("https://example.com/r/r1").a), HERE)).toBeNull();
  });

  it("ignores a link to the page already shown, and a click that isn't on a link", () => {
    expect(clickTarget(click(link("/r/r1/c/c1").a), HERE)).toBeNull();
    expect(clickTarget(click(document.createElement("button")), HERE)).toBeNull();
    expect(clickTarget(click(null), HERE)).toBeNull();
  });

  it("counts the search as part of the place, so Timeline to Map is a navigation", () => {
    expect(clickTarget(click(link("/r/r1/t/4?view=map").a), "http://localhost:3000/r/r1/t/4")).toBe("/r/r1/t/4?view=map");
    expect(clickTarget(click(link("/r/r1/t/4").a), "http://localhost:3000/r/r1/t/4?view=map")).toBe("/r/r1/t/4");
  });
});

describe("placeOf", () => {
  it("reads a chat, a thread, a thread's Map, a new thread and a bare room", () => {
    expect(placeOf("/r/r1/c/c2?m=40")).toEqual({ roomId: "r1", chatId: "c2", map: false, newThread: false });
    expect(placeOf("/r/r1/t/4")).toEqual({ roomId: "r1", threadNumber: 4, map: false, newThread: false });
    expect(placeOf("/r/r1/t/4?view=map&run=x")).toEqual({ roomId: "r1", threadNumber: 4, map: true, newThread: false });
    expect(placeOf("/r/r1/t/new")).toEqual({ roomId: "r1", map: false, newThread: true });
    expect(placeOf("/r/r2")).toEqual({ roomId: "r2", map: false, newThread: false });
  });

  it("is null outside the rooms", () => {
    expect(placeOf("/apps")).toBeNull();
    expect(placeOf("/")).toBeNull();
  });
});

describe("skeletonKind", () => {
  it("names the skeleton each room page loads behind; a bare room opens a chat", () => {
    expect(skeletonKind("/r/r1/c/c2")).toBe("chat");
    expect(skeletonKind("/r/r2")).toBe("chat");
    expect(skeletonKind("/r/r1/t/4")).toBe("thread");
    expect(skeletonKind("/r/r1/t/4?view=map")).toBe("map");
    expect(skeletonKind("/r/r1/t/new")).toBe("new-thread");
  });

  it("has none for pages outside the rooms", () => {
    expect(skeletonKind("/apps")).toBeNull();
  });
});
