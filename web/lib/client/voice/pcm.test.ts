import { describe, expect, it } from "vitest";
import { chunker, downsample } from "./pcm";

describe("downsample", () => {
  it("averages 48 kHz down to 16 kHz", () => {
    const out = downsample(new Float32Array(4800).fill(0.5), 48000);
    expect(out).toHaveLength(1600);
    expect(out[0]).toBe(Math.round(0.5 * 32767));
  });

  it("clamps samples past full scale", () => {
    expect([...downsample(new Float32Array([1.5, 1.5, 1.5, -1.5, -1.5, -1.5]), 48000)]).toEqual([32767, -32767]);
  });
});

describe("chunker", () => {
  it("cuts the stream into whole chunks and keeps the rest for later", () => {
    const chunks: Uint8Array[] = [];
    const feed = chunker(3200, (b) => chunks.push(b));
    feed(new Int16Array(2000));
    feed(new Int16Array(3000));
    expect(chunks.map((c) => c.length)).toEqual([3200, 3200, 3200]);
    feed(new Int16Array(1400));
    expect(chunks).toHaveLength(4);
  });

  it("writes samples little-endian, the byte order Transcribe expects", () => {
    const chunks: Uint8Array[] = [];
    chunker(4, (b) => chunks.push(b))(new Int16Array([1, -2]));
    expect([...chunks[0]]).toEqual([1, 0, 0xfe, 0xff]);
  });
});
