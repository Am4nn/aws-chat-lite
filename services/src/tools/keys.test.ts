import { describe, expect, it, vi } from "vitest";
import { toolKeys } from "./keys.js";

const keys = {
  TAVILY_API_KEY: "t", GITHUB_APP_ID: "1", GITHUB_APP_SLUG: "chat-lite", GITHUB_APP_PRIVATE_KEY: "pem",
  GITHUB_APP_CLIENT_ID: "Iv1.c", GITHUB_APP_CLIENT_SECRET: "cs",
};
const expected = { tavilyKey: "t", githubAppId: "1", githubAppSlug: "chat-lite", githubPrivateKey: "pem", githubClientId: "Iv1.c", githubClientSecret: "cs" };

describe("toolKeys", () => {
  it("reads the keys from the environment when there is no secret", async () => {
    expect(await toolKeys(keys, vi.fn())).toEqual(expected);
  });

  it("reads the secret once across calls", async () => {
    const read = vi.fn(async () => JSON.stringify(keys));
    const env = { TOOL_KEYS_SECRET: "cl-local-tool-keys", TAVILY_API_KEY: "ignored" };
    expect(await toolKeys(env, read)).toEqual(expected);
    expect(await toolKeys(env, read)).toEqual(expected);
    expect(read.mock.calls).toEqual([["cl-local-tool-keys"]]);
  });
});
