import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fakeGitHubFetch, fakeKeys, fakeSignInPage } from "./fake-github.js";
import { appJwt } from "./github/app.js";

const mint = (jwt: string) =>
  fakeGitHubFetch("https://api.github.com/app/installations/1/access_tokens", { method: "POST", headers: { Authorization: `Bearer ${jwt}` } });

describe("fakeGitHubFetch", () => {
  it("mints its token only for a JWT signed with the fake key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect((await mint(appJwt("1", other))).status).toBe(401);

    const res = await mint(appJwt("1", fakeKeys().githubPrivateKey!));
    expect(res.status).toBe(201);
    expect((await res.json()).token).toBe("ghs_fake");
  });

  it("wants that token on repo routes", async () => {
    const get = (token: string) => fakeGitHubFetch("https://api.github.com/repos/fake-org/playground", { headers: { Authorization: `Bearer ${token}` } });
    expect((await get("ghs_other")).status).toBe(401);
    expect(await (await get("ghs_fake")).json()).toEqual({ full_name: "fake-org/playground", default_branch: "main" });
  });

  it("hands its user token only for its own codes, and that token reaches only user routes", async () => {
    const exchange = (code: string) => fakeGitHubFetch("https://github.com/login/oauth/access_token", {
      method: "POST", body: JSON.stringify({ client_id: "fake-client-id", client_secret: "fake-client-secret", code, code_verifier: "v" }),
    });
    expect(await (await exchange("not-a-fake-code")).json()).toEqual({ error: "bad_verification_code" });
    const user = (token: string, path: string) => fakeGitHubFetch(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const installationToken = (await (await mint(appJwt("1", fakeKeys().githubPrivateKey!))).json()).token;
    expect((await user(installationToken, "/user/installations")).status).toBe(401);
    expect((await user("ghu_fake", "/repos/fake-org/playground")).status).toBe(401);
  });
});

describe("fakeSignInPage", () => {
  it("sends the browser straight back with the state and a code bound to the challenge", () => {
    const url = new URL(fakeSignInPage({ clientId: "fake-client-id", redirectUri: "http://localhost:3000/bff/github/callback", state: "s1", challenge: "c1" }));
    expect(url.origin + url.pathname).toBe("http://localhost:3000/bff/github/callback");
    expect(Object.fromEntries(url.searchParams)).toEqual({ code: "fake-code.c1", state: "s1" });
  });
});
