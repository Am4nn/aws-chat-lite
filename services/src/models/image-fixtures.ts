/** The first bytes of an image of each type, enough of the header to read its size. */

function bytes(length: number, write: (v: DataView, b: Uint8Array) => void): Uint8Array {
  const b = new Uint8Array(length);
  write(new DataView(b.buffer), b);
  return b;
}
const text = (b: Uint8Array, at: number, s: string) => b.set(new TextEncoder().encode(s), at);

export const png = (width: number, height: number) =>
  bytes(24, (v, b) => {
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    text(b, 12, "IHDR");
    v.setUint32(16, width);
    v.setUint32(20, height);
  });

export const gif = (width: number, height: number) =>
  bytes(10, (v, b) => {
    text(b, 0, "GIF89a");
    v.setUint16(6, width, true);
    v.setUint16(8, height, true);
  });

/** A JFIF segment, then the baseline frame header that holds the size. */
export const jpeg = (width: number, height: number) =>
  bytes(2 + 18 + 11, (v, b) => {
    b.set([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
    text(b, 6, "JFIF");
    b.set([0xff, 0xc0, 0, 17, 8], 20);
    v.setUint16(25, height);
    v.setUint16(27, width);
  });

export const webp = (chunk: "VP8 " | "VP8L" | "VP8X", width: number, height: number) =>
  bytes(30, (v, b) => {
    text(b, 0, "RIFF");
    text(b, 8, "WEBP");
    text(b, 12, chunk);
    if (chunk === "VP8 ") {
      b.set([0x9d, 0x01, 0x2a], 23);
      v.setUint16(26, width, true);
      v.setUint16(28, height, true);
    } else if (chunk === "VP8L") {
      b[20] = 0x2f;
      v.setUint32(21, (width - 1) | ((height - 1) << 14), true);
    } else {
      v.setUint16(24, (width - 1) & 0xffff, true);
      b[26] = (width - 1) >> 16;
      v.setUint16(27, (height - 1) & 0xffff, true);
      b[29] = (height - 1) >> 16;
    }
  });
