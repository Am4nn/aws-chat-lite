import { describe, expect, it } from "vitest";
import { createSseParser } from "./sse";

describe("createSseParser", () => {
  it("joins a frame split across chunks and skips comments", () => {
    const p = createSseParser();
    expect(p.push('id: 1\nevent: run\ndata: {"a"')).toEqual([]);
    expect(p.push(":1}\n\n: ka\n\n")).toEqual([{ id: "1", event: "run", data: '{"a":1}' }]);
  });

  it("parses CRLF the same", () => {
    expect(createSseParser().push('id: 2\r\nevent: run\r\ndata: {}\r\n\r\n')).toEqual([{ id: "2", event: "run", data: "{}" }]);
  });
});
