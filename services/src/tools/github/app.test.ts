import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fakeKeys, recordGitHub } from "../fake-github.js";
import { appJwt, githubCall, installationToken, listInstallations } from "./app.js";

describe("appJwt", () => {
  it("signs RS256 claims that verify with the public key and live for ten minutes", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const [header, payload, signature] = appJwt("42", pem, 1_000_000).split(".");

    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toEqual({ iat: 999_940, exp: 1_000_540, iss: "42" });
    expect(claims.exp - claims.iat).toBe(600);
  });
});

describe("installationToken", () => {
  it("mints a token for one repo with only the asked permissions, sending GitHub's API headers", async () => {
    const headers: Headers[] = [];
    const { calls, fetch } = recordGitHub();
    const env = {
      keys: fakeKeys(),
      fetch: ((input, init) => (headers.push(new Headers(init?.headers)), fetch(input, init))) as typeof globalThis.fetch,
    };

    expect(await installationToken(env, 1, "fake-org/playground", { issues: "write" })).toBe("ghs_fake");
    expect(calls).toEqual([
      { method: "POST", path: "/app/installations/1/access_tokens", body: { repositories: ["playground"], permissions: { issues: "write" } } },
    ]);
    expect(headers[0].get("Accept")).toBe("application/vnd.github+json");
    expect(headers[0].get("X-GitHub-Api-Version")).toBe("2022-11-28");
  });

  it("names the permission when GitHub refuses it", async () => {
    const { fetch } = recordGitHub((c) => (c.path.endsWith("/access_tokens") ? Response.json({ message: "nope" }, { status: 422 }) : undefined));
    await expect(installationToken({ keys: fakeKeys(), fetch }, 1, "fake-org/playground", { contents: "write" })).rejects.toThrow(
      "The GitHub App lacks contents:write permission.",
    );
  });

  it("says GitHub isn't set up when there is no App key", async () => {
    const { fetch, calls } = recordGitHub();
    await expect(installationToken({ keys: {}, fetch }, 1, "fake-org/playground", { issues: "read" })).rejects.toThrow(
      "GitHub isn't set up here (no GitHub App key).",
    );
    expect(calls).toEqual([]);
  });
});

describe("githubCall", () => {
  it("adds a refusal's reasons to GitHub's message", async () => {
    const body = { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "No commits between main and b" }, { field: "head", code: "invalid" }] };
    const env = { keys: {}, fetch: (async () => Response.json(body, { status: 422 })) as typeof fetch };
    await expect(githubCall(env, "t", "POST", "/repos/o/r/pulls", {})).rejects.toThrow(
      "GitHub said 422: Validation Failed (No commits between main and b; head invalid)",
    );
  });
});

describe("listInstallations", () => {
  it("lists each installation with the repos it can reach", async () => {
    const { fetch } = recordGitHub();
    expect(await listInstallations({ keys: fakeKeys(), fetch })).toEqual([{ id: 1, account: "fake-org", repos: ["fake-org/playground"] }]);
  });
});
