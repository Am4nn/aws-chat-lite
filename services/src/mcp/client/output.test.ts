import { describe, expect, it } from "vitest";
import { toolOutput } from "./output.js";

describe("toolOutput", () => {
  it("joins text blocks", () => {
    expect(toolOutput({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] })).toEqual({ ok: true, output: "one\n\ntwo" });
  });

  it("names images and audio by type", () => {
    const r = toolOutput({
      content: [
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "audio", data: "aGk=", mimeType: "audio/wav" },
      ],
    });
    expect(r.output).toBe("[image: image/png]\n\n[audio: audio/wav]");
  });

  it("shows a resource link, and an embedded resource's text", () => {
    const r = toolOutput({
      content: [
        { type: "resource_link", name: "report", uri: "https://x.example/r/1" },
        { type: "resource", resource: { uri: "file:///a.txt", text: "inside" } },
        { type: "resource", resource: { uri: "file:///b.bin", mimeType: "application/pdf", blob: "aGk=" } },
      ],
    });
    expect(r.output).toBe("[link] report https://x.example/r/1\n\ninside\n\n[resource: application/pdf]");
  });

  it("falls back to structured content when there is no content", () => {
    expect(toolOutput({ content: [], structuredContent: { a: 1, b: ["x"] } })).toEqual({ ok: true, output: '{"a":1,"b":["x"]}' });
  });

  it("marks an error result as not ok", () => {
    expect(toolOutput({ content: [{ type: "text", text: "it failed" }], isError: true })).toEqual({ ok: false, output: "it failed" });
  });

  it("cuts long output", () => {
    const r = toolOutput({ content: [{ type: "text", text: "a".repeat(30_000) }] });
    expect(r.output).toBe(`${"a".repeat(20_000)}\n…(cut)`);
  });
});
