import { describe, expect, it } from "vitest";
import { gif, jpeg, png, webp } from "./image-fixtures.js";
import { imageSize, imageType } from "./image-header.js";

describe("imageType", () => {
  it("reads the type from the magic number", () => {
    expect(imageType(png(1, 1))).toBe("image/png");
    expect(imageType(jpeg(1, 1))).toBe("image/jpeg");
    expect(imageType(gif(1, 1))).toBe("image/gif");
    expect(imageType(webp("VP8X", 1, 1))).toBe("image/webp");
  });

  it("knows nothing else", () => {
    expect(imageType(new TextEncoder().encode("<html>"))).toBeUndefined();
    expect(imageType(new Uint8Array())).toBeUndefined();
  });
});

describe("imageSize", () => {
  it("reads the width and height from each type's header", () => {
    expect(imageSize(png(1440, 12000), "image/png")).toEqual({ width: 1440, height: 12000 });
    expect(imageSize(gif(320, 200), "image/gif")).toEqual({ width: 320, height: 200 });
    expect(imageSize(jpeg(4032, 3024), "image/jpeg")).toEqual({ width: 4032, height: 3024 });
    expect(imageSize(webp("VP8 ", 800, 600), "image/webp")).toEqual({ width: 800, height: 600 });
    expect(imageSize(webp("VP8L", 16383, 2), "image/webp")).toEqual({ width: 16383, height: 2 });
    expect(imageSize(webp("VP8X", 9000, 20000), "image/webp")).toEqual({ width: 9000, height: 20000 });
  });

  it("gives nothing for a header cut short", () => {
    expect(imageSize(png(10, 10).subarray(0, 20), "image/png")).toBeUndefined();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg")).toBeUndefined();
  });
});
