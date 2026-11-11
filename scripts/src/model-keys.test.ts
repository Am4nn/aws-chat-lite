import { describe, expect, it } from "vitest";
import { MODEL_KEY_NAMES, modelKeysSecret } from "./model-keys.js";

describe("modelKeysSecret", () => {
  it("keeps only the three model keys from .env, as the secret's JSON", () => {
    const env = "# models\nANTHROPIC_API_KEY=a\nDEEPSEEK_API_KEY=d\nDEEPSEEK_BASE_URL=https://api.deepseek.com\nGEMINI_API_KEY=g\n";
    expect(JSON.parse(modelKeysSecret(env))).toEqual({
      ANTHROPIC_API_KEY: "a",
      DEEPSEEK_API_KEY: "d",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    });
    expect(MODEL_KEY_NAMES).toEqual(["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"]);
  });

  it("names every missing or empty key", () => {
    expect(() => modelKeysSecret("ANTHROPIC_API_KEY=a\nDEEPSEEK_API_KEY=\n")).toThrow(
      ".env is missing DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL",
    );
  });
});
