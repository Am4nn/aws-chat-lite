import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const SOURCES = ["services/src", "web/app", "web/components", "web/lib"];

/**
 * A user may only see error text we wrote. Code here names a caught error `e`, `err` or `error`, so reading its text
 * (`e.message`, `String(e)`, `${e}`, `JSON.stringify(e)`) is where foreign text (an AWS SDK error with an ARN in it, a
 * remote server's answer) gets into a response, an event or a toast. Such a read passes only on a line that also checks
 * the error is one of ours, or that logs it. A line-level check is crude, but it stays quiet on the code as written
 * and fails loudly on the pattern that leaked.
 */
const READS_TEXT = /\b(e|err|error)\.message\b|\((e|err|error) as \w+\)\.message|String\((e|err|error)\)|\$\{(e|err|error)\}|JSON\.stringify\((e|err|error)\)/;
// Classes whose messages are written by us: the services' UserError family, the web's (BffError), and the refusals
// GitHub and OAuth code build from fixed sentences.
const OURS = /instanceof (UserError|ValidationError|Forbidden|NotFound|Conflict|Gone|Upstream|Unavailable|QuotaError|GitHubError|OAuthError|BffError)\b/;
const LOGS = /\bconsole\.(error|warn|log)\(/;
// The sandbox's own HTTP server answers only our Lambda, which never shows its error text.
const INTERNAL = new Set(["services/src/sandbox/server.ts"]);

const isSource = (path: string) => /\.tsx?$/.test(path) && !/\.(test|int\.test|live\.test|load\.test)\.tsx?$/.test(path) && !path.includes("/testing/");

function offenders(): string[] {
  return SOURCES.flatMap((dir) =>
    readdirSync(root + dir, { recursive: true, encoding: "utf8" })
      .map((rel) => `${dir}/${rel.replaceAll("\\", "/")}`)
      .filter((path) => isSource(path) && !INTERNAL.has(path))
      .flatMap((path) =>
        readFileSync(root + path, "utf8").split("\n").flatMap((line, i) =>
          READS_TEXT.test(line) && !OURS.test(line) && !LOGS.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [],
        ),
      ),
  );
}

describe("user-visible errors", () => {
  it("no source passes a caught error's own text on unless it checked the error is ours", () => {
    expect(offenders()).toEqual([]);
  });

  it("the check catches the shapes that leak", () => {
    for (const line of ["toast(e.message)", "setError((err as Error).message);", "json(500, { error: String(e) })", "`failed: ${error}`"]) {
      expect(READS_TEXT.test(line) && !OURS.test(line)).toBe(true);
    }
    expect(OURS.test("if (e instanceof UserError) return e.message;")).toBe(true);
  });
});
