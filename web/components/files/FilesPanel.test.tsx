import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { applyFilesUpdate } from "@/lib/client/files";
import type { RoomFile } from "@/lib/types";
import { FilesPanel } from "./FilesPanel";
import type { RoomFiles } from "./useRoomFiles";

const file = (path: string, size = 10): RoomFile => ({
  path, size, contentType: "text/plain", v: 1, updatedAt: "2026-11-11T10:00:00Z", updatedBy: { kind: "member", userId: "u1", name: "aman" },
});
const store = (o: Partial<RoomFiles> = {}): RoomFiles => ({
  files: [], usedBytes: 0, fresh: new Set(), uploading: 0, state: "ready", reload: () => {},
  upload: async () => {}, remove: () => {}, download: async () => {}, ...o,
});
const html = (props: Partial<Parameters<typeof FilesPanel>[0]> = {}) => renderToStaticMarkup(
  <FilesPanel roomId="r1" store={store()} threads={[]} internet={false} canSwitch={false} canWrite {...props} />,
);

describe("FilesPanel", () => {
  it("shows the room's usage against its limit as text", () => {
    expect(html({ store: store({ files: [file("a.txt", 13_002_342)], usedBytes: 13_002_342 }) })).toContain("12.4 MB of 100 MB");
  });

  it("shows no usage until the list has loaded, nor while the room has no files", () => {
    expect(html({ store: store({ state: "loading" }) })).not.toContain("of 100 MB");
    expect(html()).not.toContain("of 100 MB");
  });

  it("invites a first file when there are none", () => {
    expect(html()).toContain("No files yet. Upload one, or ask an agent to make one.");
  });

  it("shows rows loading, not an empty room, until the list arrives", () => {
    const out = html({ store: store({ state: "loading" }) });
    expect(out).toContain('aria-busy="true"');
    expect(out).not.toContain("No files yet");
  });

  it("offers a retry, not an empty room, when the list didn't load", () => {
    const out = html({ store: store({ state: "failed" }) });
    expect(out).toContain("Couldn&#x27;t load");
    expect(out).not.toContain("No files yet");
  });

  it("shows a member the internet setting as text, with no switch", () => {
    const out = html({ canSwitch: false, internet: false });
    expect(out).toMatch(/>off</);
    expect(out).not.toContain('role="switch"');
  });

  it("gives an admin the internet switch", () => {
    expect(html({ canSwitch: true, internet: true })).toMatch(/role="switch"[^>]*aria-checked="true"|aria-checked="true"[^>]*role="switch"/);
  });

  it("marks a file that just arrived over the socket as fresh", () => {
    const files = applyFilesUpdate([file("a.txt")], { files: [file("n.txt")], deleted: [] });
    const rows = html({ store: store({ files, fresh: new Set(["n.txt"]) }) }).match(/<li[\s\S]*?<\/li>/g) ?? [];
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.includes("n.txt"))).toContain("data-fresh");
    expect(rows.find((r) => r.includes("a.txt"))).not.toContain("data-fresh");
  });

  it("offers download on every row, and upload and delete only while the room takes writes", () => {
    const writable = html({ store: store({ files: [file("a.txt")] }) });
    expect(writable).toContain('aria-label="Download a.txt"');
    expect(writable).toContain('aria-label="Delete a.txt"');
    expect(writable).toContain("Upload");
    const archived = html({ store: store({ files: [file("a.txt")] }), canWrite: false });
    expect(archived).toContain('aria-label="Download a.txt"');
    expect(archived).not.toContain('aria-label="Delete a.txt"');
    expect(archived).not.toContain("Upload");
  });
});
