import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localSandboxToken } from "./sandbox-token.js";

describe("localSandboxToken", () => {
  it("makes a random token once and keeps returning it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cl-token-")), "nested", "sandbox-token");
    const token = localSandboxToken(path);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(localSandboxToken(path)).toBe(token);
    expect(readFileSync(path, "utf8")).toBe(token);
    expect(localSandboxToken(join(tmpdir(), `cl-token-other-${process.pid}-${Date.now()}`))).not.toBe(token);
  });

  it("makes a new token when the file is empty", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cl-token-")), "sandbox-token");
    writeFileSync(path, " \n");
    expect(localSandboxToken(path)).toMatch(/^[0-9a-f]{64}$/);
  });
});
