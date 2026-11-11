// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bffOrNull } from "@/lib/client/bff";
import { GeneratedImage } from "./GeneratedImage";

vi.mock("@/lib/client/bff", () => ({ bffOrNull: vi.fn(), errorText: String }));

const image = { path: "images/7-12-1-fox.png", aspect: "1:1" as const };
const signed = vi.mocked(bffOrNull);

afterEach(() => {
  cleanup();
  signed.mockReset();
  vi.useRealTimers();
});

describe("GeneratedImage", () => {
  it("a picture that fails to load says so instead of leaving an empty box", async () => {
    signed.mockResolvedValue({ url: "https://s3/fox.png?sig=1" });
    render(<GeneratedImage roomId="r1" image={image} />);
    fireEvent.error(await screen.findByRole("img"));
    expect(screen.getByText("This image couldn't load.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  // A signed link lasts an hour, and a thread can stay open far longer.
  it("signs the full-size link again before it expires, without reloading the picture", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    signed.mockResolvedValueOnce({ url: "https://s3/fox.png?sig=1" }).mockResolvedValue({ url: "https://s3/fox.png?sig=2" });
    render(<GeneratedImage roomId="r1" image={image} />);
    const link = await screen.findByRole("link", { name: `Open ${image.path}` });
    expect(link.getAttribute("href")).toBe("https://s3/fox.png?sig=1");

    await act(async () => vi.advanceTimersByTime(50 * 60_000));
    expect(link.getAttribute("href")).toBe("https://s3/fox.png?sig=2");
    expect(screen.getByRole("img").getAttribute("src")).toBe("https://s3/fox.png?sig=1");
  });
});
