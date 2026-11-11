import type { InlineImageType } from "./gateway.js";

type Size = { width: number; height: number };

const ascii = (b: Uint8Array, start: number, end: number) => String.fromCharCode(...b.subarray(start, end));

/** The type an image's own bytes declare, from its magic number. A file name or a declared type can be wrong. */
export function imageType(b: Uint8Array): InlineImageType | undefined {
  if (b[0] === 0x89 && ascii(b, 1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(b, 0, 4) === "GIF8") return "image/gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** The width and height an image's header states, read without decoding it; undefined when the header is cut short. */
export function imageSize(b: Uint8Array, type: InlineImageType): Size | undefined {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    switch (type) {
      case "image/png": return { width: v.getUint32(16), height: v.getUint32(20) };
      case "image/gif": return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
      case "image/webp": return webpSize(b, v);
      case "image/jpeg": return jpegSize(v);
    }
  } catch (e) {
    if (e instanceof RangeError) return undefined;
    throw e;
  }
}

/** WebP has three headers: lossy (`VP8 `), lossless (`VP8L`) and extended (`VP8X`), each storing the size its own way. */
function webpSize(b: Uint8Array, v: DataView): Size | undefined {
  const uint24 = (at: number) => v.getUint16(at, true) + v.getUint8(at + 2) * 0x10000;
  switch (ascii(b, 12, 16)) {
    case "VP8 ": return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
    case "VP8L": {
      const bits = v.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case "VP8X": return { width: uint24(24) + 1, height: uint24(27) + 1 };
    default: return undefined;
  }
}

/** A JPEG's size is in its frame header (an SOF marker), after any number of other segments. */
function jpegSize(v: DataView): Size | undefined {
  for (let at = 2; ;) {
    if (v.getUint8(at) !== 0xff) return undefined;
    const marker = v.getUint8(at + 1);
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // C4, C8 and CC sit in the SOF range but are other segments.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: v.getUint16(at + 7), height: v.getUint16(at + 5) };
    }
    if (marker === 0xda) return undefined;
    at += 2 + v.getUint16(at + 2);
  }
}
