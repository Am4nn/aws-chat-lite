import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeAudio {
  static made: FakeAudio[] = [];
  src = "";
  paused = true;
  onended: (() => void) | null = null;
  constructor() {
    FakeAudio.made.push(this);
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

describe("speech player", () => {
  beforeEach(() => {
    vi.resetModules();
    FakeAudio.made = [];
    vi.stubGlobal("Audio", FakeAudio);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("plays one answer at a time on one element and tells subscribers which", async () => {
    const { play, playingKey, subscribe } = await import("./speech");
    const seen: (string | null)[] = [];
    subscribe(() => seen.push(playingKey()));

    await play("a", "https://s3/a.mp3");
    const audio = FakeAudio.made[0];
    const pause = vi.spyOn(audio, "pause");
    await play("b", "https://s3/b.mp3");

    expect(FakeAudio.made).toHaveLength(1);
    expect(pause).toHaveBeenCalled();
    expect(audio.src).toBe("https://s3/b.mp3");
    expect(seen).toEqual(["a", "b"]);
    expect(playingKey()).toBe("b");
  });

  it("prime() starts the shared element at once with silence, and the answer then plays on that same element", async () => {
    const { prime, play, playingKey } = await import("./speech");
    prime();
    const audio = FakeAudio.made[0];
    expect(audio.src).toMatch(/^data:audio\/wav;base64,/);
    expect(audio.paused).toBe(false);
    expect(playingKey()).toBeNull();

    await play("a", "https://s3/a.mp3");
    expect(FakeAudio.made).toHaveLength(1);
    expect(audio.src).toBe("https://s3/a.mp3");
  });

  it("a refused prime is quiet", async () => {
    const { prime } = await import("./speech");
    vi.spyOn(FakeAudio.prototype, "play").mockReturnValue(Promise.reject(new Error("blocked")));
    expect(() => prime()).not.toThrow();
  });

  it("stop() and the end of the audio leave nothing playing", async () => {
    const { play, playingKey, stop } = await import("./speech");
    await play("a", "https://s3/a.mp3");
    stop();
    expect(FakeAudio.made[0].paused).toBe(true);
    expect(playingKey()).toBeNull();

    await play("a", "https://s3/a.mp3");
    FakeAudio.made[0].onended?.();
    expect(playingKey()).toBeNull();
  });

  it("a refused play leaves nothing playing and says why; one cut short by the next play is quiet", async () => {
    const { play, playingKey } = await import("./speech");
    await play("a", "https://s3/a.mp3");
    const audio = FakeAudio.made[0];
    let reject!: (e: Error) => void;
    audio.play = () => new Promise((_, r) => (reject = r));

    const cut = play("a", "https://s3/a.mp3");
    audio.play = () => Promise.resolve();
    await play("b", "https://s3/b.mp3");
    reject(new Error("interrupted"));
    await expect(cut).resolves.toBeUndefined();
    expect(playingKey()).toBe("b");

    audio.play = () => Promise.reject(new Error("blocked"));
    await expect(play("c", "https://s3/c.mp3")).rejects.toThrow("blocked");
    expect(playingKey()).toBeNull();
  });
});
