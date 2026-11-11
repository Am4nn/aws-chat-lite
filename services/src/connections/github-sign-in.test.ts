import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fakeKeys, fakeSignInPage, recordGitHub } from "../tools/fake-github.js";
import { GitHubError } from "../tools/github/app.js";
import { githubSignInPage, pkce, userInstallations } from "./github-sign-in.js";

const REDIRECT = "http://localhost:3000/bff/github/callback";

/** Plays GitHub's sign-in page in fake mode: the code it hands back carries the challenge. */
const codeFor = (challenge: string) =>
  new URL(fakeSignInPage({ clientId: "fake-client-id", redirectUri: REDIRECT, state: "s", challenge })).searchParams.get("code")!;

describe("pkce", () => {
  it("makes a fresh verifier whose S256 challenge GitHub can check", () => {
    const { verifier, challenge } = pkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(pkce().verifier).not.toBe(verifier);
  });
});

describe("githubSignInPage", () => {
  it("is GitHub's authorize page for the App, with the state, return address and challenge", () => {
    const url = new URL(githubSignInPage({ clientId: "Iv1.abc", redirectUri: REDIRECT, state: "s1", challenge: "c1" }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "Iv1.abc", redirect_uri: REDIRECT, state: "s1", code_challenge: "c1", code_challenge_method: "S256",
    });
  });
});

describe("userInstallations", () => {
  it("trades the code for a user token and lists the installations and repos that user can reach", async () => {
    const { verifier, challenge } = pkce();
    const { calls, fetch } = recordGitHub();
    expect(await userInstallations({ fetch, keys: fakeKeys() }, codeFor(challenge), verifier, REDIRECT))
      .toEqual([{ id: 1, account: "fake-org", repos: ["fake-org/playground"] }]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /login/oauth/access_token", "GET /user/installations?per_page=100", "GET /user/installations/1/repositories?per_page=100",
    ]);
    expect(calls[0]!.body).toEqual({
      client_id: "fake-client-id", client_secret: "fake-client-secret", code: codeFor(challenge), code_verifier: verifier, redirect_uri: REDIRECT,
    });
  });

  it("names GitHub's refusal of a code, as for a verifier that doesn't match its challenge", async () => {
    const { challenge } = pkce();
    const { fetch } = recordGitHub();
    const refused = userInstallations({ fetch, keys: fakeKeys() }, codeFor(challenge), pkce().verifier, REDIRECT);
    await expect(refused).rejects.toThrow(new GitHubError("GitHub refused the sign-in (bad_verification_code)."));
  });

  it("needs the App's client id and secret", async () => {
    const { calls, fetch } = recordGitHub();
    const { githubClientSecret: _, ...keys } = fakeKeys();
    await expect(userInstallations({ fetch, keys }, "code", "v", REDIRECT)).rejects.toThrow("GitHub sign-in isn't set up here");
    expect(calls).toEqual([]);
  });
});
