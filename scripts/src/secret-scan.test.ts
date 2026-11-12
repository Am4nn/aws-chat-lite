import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scanDiff = fileURLToPath(new URL("../../.githooks/scan-diff", import.meta.url));

/** A one-file `git diff -U0` that adds `lines` from line 7. */
const diff = (file: string, lines: string[]) =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -6,0 +7,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");

function scan(file: string, lines: string[]) {
  const res = spawnSync("sh", [scanDiff], { input: diff(file, lines), encoding: "utf8" });
  return { blocked: res.status === 1, output: res.stdout };
}

// Assembled at run time so this file never holds a key-shaped literal of its own.
const anthropicKey = "sk-" + "ant-" + "api03" + "Xy7Kq2Lm9Pw4".repeat(3) + "Ab3D";

describe("scan-diff", () => {
  it("blocks a real-looking Anthropic key, naming the file and line but not the value", () => {
    const { blocked, output } = scan("services/src/config.ts", ["const a = 1;", `const key = "${anthropicKey}";`]);
    expect(blocked).toBe(true);
    expect(output).toBe("services/src/config.ts:8: Anthropic key (value redacted)\n");
  });

  it("lets the tests' fake tokens and leak assertions through", () => {
    const lines = ['expect(token).toBe("ghs_fake");', "expect(out).not.toMatch(/BEGIN|ghs_|tvly-/);"];
    expect(scan("services/src/tools/github/app.test.ts", lines).blocked).toBe(false);
  });

  it("still blocks a real token on a line that also holds a fake one", () => {
    expect(scan("a.ts", [`send("ghs_fake", "${"gh" + "s_"}R3alT0ken")`]).blocked).toBe(true);
  });

  it("blocks a real email address but not an example or allow-listed one", () => {
    expect(scan("a.ts", [`mail jane.doe${"@"}gmail.com`]).output).toBe("a.ts:7: email address (value redacted)\n");
    expect(scan("a.ts", ["ops@example.com push@chat-lite.test noreply@anthropic.com"]).blocked).toBe(false);
  });
});
