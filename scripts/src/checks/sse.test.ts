import { describe, it, expect } from "vitest";
import { parseSse, classifyStream } from "./sse.js";

describe("parseSse", () => {
  it("parses id, event and data per frame", () => {
    const ev = parseSse('id: 1\nevent: tick\ndata: {"n":1}\n\nid: 2\nevent: tick\ndata: {"n":2}\n\n');
    expect(ev).toEqual([
      { id: "1", event: "tick", data: '{"n":1}' },
      { id: "2", event: "tick", data: '{"n":2}' },
    ]);
  });
  it("handles CRLF and a trailing partial frame", () => {
    expect(parseSse("id: 3\r\nevent: tick\r\ndata: x\r\n\r\nid: 4\ndata: y").map((e) => e.id)).toEqual(["3"]);
  });
});

describe("classifyStream", () => {
  it("classifies buffered vs streamed", () => {
    expect(classifyStream(100, 1500)).toBe("streamed");
    expect(classifyStream(1450, 1500)).toBe("buffered");
  });
});
