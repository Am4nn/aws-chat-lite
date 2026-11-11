// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bff } from "@/lib/client/bff";
import { ReadAloudButton } from "./ReadAloudButton";

vi.mock("@/lib/client/bff", () => ({ bff: vi.fn(), errorText: String }));
vi.mock("@/components/overlays/Toast", () => ({ useToast: () => vi.fn() }));

const played: string[] = [];
class FakeAudio {
  src = "";
  onended: (() => void) | null = null;
  play() {
    played.push(this.src);
    return Promise.resolve();
  }
  pause() {}
}
vi.stubGlobal("Audio", FakeAudio);

afterEach(cleanup);

describe("ReadAloudButton", () => {
  // Safari and iPhone let audio with sound start only inside the click, and the speech can take seconds to make.
  it("starts the audio inside the click, before the speech arrives, then plays the answer", async () => {
    let answer!: (v: { url: string; cached: boolean }) => void;
    vi.mocked(bff).mockReturnValue(new Promise((r) => (answer = r)));
    render(<ReadAloudButton roomId="r1" chatId="c1" seq={4} />);

    fireEvent.click(screen.getByRole("button", { name: "Read aloud" }));
    expect(played).toHaveLength(1);
    expect(played[0]).toMatch(/^data:audio\/wav/);

    answer({ url: "https://s3/c1-4.mp3", cached: false });
    expect(await screen.findByRole("button", { name: "Stop reading" })).toBeTruthy();
    expect(played).toEqual([played[0], "https://s3/c1-4.mp3"]);
  });
});
