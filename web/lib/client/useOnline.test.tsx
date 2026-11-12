// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOnline } from "./useOnline";

function setOnline(online: boolean) {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(online);
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useOnline", () => {
  it("follows the browser's online flag as it changes", () => {
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(true);
    act(() => setOnline(false));
    expect(result.current).toBe(false);
    act(() => setOnline(true));
    expect(result.current).toBe(true);
  });

  it("assumes online on the server, so the page hydrates without a mismatch", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    function Probe() {
      return <>{String(useOnline())}</>;
    }
    expect(renderToString(<Probe />)).toBe("true");
  });
});
