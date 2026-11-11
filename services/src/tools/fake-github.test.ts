import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fakeGitHubFetch, fakeKeys } from "./fake-github.js";
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
});
