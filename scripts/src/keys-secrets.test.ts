import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_KEY_NAMES, PUSH_KEY_NAMES, TOOL_KEY_NAMES, modelKeysSecret, pushKeysSecret, toolKeysSecret } from "./keys-secrets.js";

describe("modelKeysSecret", () => {
  it("keeps only the four model keys from .env, as the secret's JSON", () => {
    const env = "# models\nANTHROPIC_API_KEY=a\nDEEPSEEK_API_KEY=d\nDEEPSEEK_BASE_URL=https://api.deepseek.com\nGEMINI_API_KEY=g\nTAVILY_API_KEY=t\n";
    expect(JSON.parse(modelKeysSecret(env))).toEqual({
      ANTHROPIC_API_KEY: "a",
      DEEPSEEK_API_KEY: "d",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      GEMINI_API_KEY: "g",
    });
    expect(MODEL_KEY_NAMES).toEqual(["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "GEMINI_API_KEY"]);
  });

  it("names every missing or empty key", () => {
    expect(() => modelKeysSecret("ANTHROPIC_API_KEY=a\nDEEPSEEK_API_KEY=\n")).toThrow(
      ".env is missing DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, GEMINI_API_KEY",
    );
  });
});

describe("pushKeysSecret", () => {
  it("keeps only the VAPID key pair and subject from .env, as the secret's JSON", () => {
    const env = "VAPID_PUBLIC_KEY=pub\nVAPID_PRIVATE_KEY=priv\nVAPID_SUBJECT=mailto:a@example.com\nGEMINI_API_KEY=g\n";
    expect(JSON.parse(pushKeysSecret(env))).toEqual({
      VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "mailto:a@example.com",
    });
    expect(PUSH_KEY_NAMES).toEqual(["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]);
  });

  it("names a missing key without echoing the others", () => {
    const noSubject = "VAPID_PUBLIC_KEY=pub\nVAPID_PRIVATE_KEY=priv-c0ffee\n";
    expect(() => pushKeysSecret(noSubject)).toThrow(".env is missing VAPID_SUBJECT");
    expect(() => pushKeysSecret(noSubject)).not.toThrow(/c0ffee/);
  });
});

describe("toolKeysSecret", () => {
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pemFile = (text: string) => {
    const path = join(mkdtempSync(join(tmpdir(), "cl-keys-")), "app.pem");
    writeFileSync(path, text);
    return path;
  };
  const env = (path: string) => `TAVILY_API_KEY=t\nGITHUB_APP_ID=42\nGITHUB_APP_SLUG=my-app\nGITHUB_APP_PRIVATE_KEY_PATH=${path}\nOTHER=x\n`;
  const read = (path: string) => readFileSync(path, "utf8");

  it("takes the three keys from .env and the App's private key from the file it names", () => {
    expect(JSON.parse(toolKeysSecret(env(pemFile(pem)), read))).toEqual({
      TAVILY_API_KEY: "t", GITHUB_APP_ID: "42", GITHUB_APP_SLUG: "my-app", GITHUB_APP_PRIVATE_KEY: pem,
    });
    expect(TOOL_KEY_NAMES).toEqual(["TAVILY_API_KEY", "GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY"]);
  });

  it("names a missing key, a missing file, and a file that isn't a private key, without echoing it", () => {
    expect(() => toolKeysSecret("TAVILY_API_KEY=t\nGITHUB_APP_ID=42\n", read)).toThrow(
      ".env is missing GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY_PATH",
    );
    expect(() => toolKeysSecret(env(join(tmpdir(), "no-such-dir-cl", "app.pem")), read)).toThrow(/GITHUB_APP_PRIVATE_KEY_PATH/);
    const notAKey = "not-a-key-c0ffee";
    expect(() => toolKeysSecret(env(pemFile(notAKey)), read)).toThrow(/GITHUB_APP_PRIVATE_KEY_PATH/);
    expect(() => toolKeysSecret(env(pemFile(notAKey)), read)).not.toThrow(new RegExp(notAKey));
  });
});
