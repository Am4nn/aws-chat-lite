import { describe, it, expect } from "vitest";
import { gate, checkMutation } from "./gate";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const NOW = 1_700_000_000_000;
const fresh = `${b64({})}.${b64({ sub: "u1", exp: NOW / 1000 + 3600 })}.s`;
const stale = `${b64({})}.${b64({ sub: "u1", exp: NOW / 1000 + 10 })}.s`;
const SITE = "http://localhost:3000";

function req(o: {
  method?: string; path?: string; search?: string; headers?: Record<string, string>; idToken?: string; originSecret?: string;
}) {
  return gate({
    method: o.method ?? "GET", pathname: o.path ?? "/r/abc", search: o.search ?? "",
    headers: new Headers({ host: "localhost:3000", ...o.headers }), idToken: o.idToken, originSecret: o.originSecret,
    extraOrigins: [], now: NOW,
  });
}

describe("gate (what proxy.ts does with each request)", () => {
  it("refuses a request without CloudFront's secret, before any CSRF or token check", () => {
    const forbidden = { type: "error", status: 403, error: "Forbidden." };
    expect(req({ path: "/login", originSecret: "s3cret" })).toEqual(forbidden);
    expect(req({ method: "POST", path: "/bff/x", originSecret: "s3cret", headers: { "x-origin-verify": "wrong" } })).toEqual(forbidden);
  });

  it("with CloudFront's secret, decides as it does without one", () => {
    const viaCloudFront = { originSecret: "s3cret", headers: { "x-origin-verify": "s3cret" } };
    expect(req({ ...viaCloudFront, idToken: fresh })).toEqual({ type: "next" });
    expect(req({ ...viaCloudFront, path: "/login" })).toEqual({ type: "next" });
    expect(req(viaCloudFront)).toEqual({ type: "redirect", location: "/bff/auth/refresh?next=%2Fr%2Fabc" });
    expect(req({ ...viaCloudFront, method: "POST", path: "/bff/x", headers: { ...viaCloudFront.headers, origin: SITE } }))
      .toMatchObject({ type: "error", status: 415 });
  });

  it("a page with a fresh token renders", () => {
    expect(req({ idToken: fresh })).toEqual({ type: "next" });
  });

  it("a page with a missing or expiring token goes to the refresh endpoint and back", () => {
    expect(req({ idToken: stale })).toEqual({ type: "redirect", location: "/bff/auth/refresh?next=%2Fr%2Fabc" });
    expect(req({ path: "/r/abc/c/def", search: "?x=1" }))
      .toEqual({ type: "redirect", location: "/bff/auth/refresh?next=%2Fr%2Fabc%2Fc%2Fdef%3Fx%3D1" });
  });

  it("login, invite previews and /bff/* are public (no redirect loops)", () => {
    expect(req({ path: "/login" })).toEqual({ type: "next" });
    expect(req({ path: "/invite/AbC_123" })).toEqual({ type: "next" });
    expect(req({ path: "/bff/auth/refresh", search: "?next=/" })).toEqual({ type: "next" });
  });

  it("the service worker, the manifest, the icons and the audio worklet load without a token", () => {
    for (const path of ["/sw.js", "/manifest.webmanifest", "/icon", "/apple-icon", "/pcm-worklet.js"]) {
      expect(req({ path })).toEqual({ type: "next" });
    }
    expect(req({ path: "/sw.js.map" })).toMatchObject({ type: "redirect" });
  });

  it("BFF mutations need our Origin and a JSON body", () => {
    const json = { "content-type": "application/json" };
    expect(req({ method: "POST", path: "/bff/api/rooms", headers: { ...json, origin: SITE } })).toEqual({ type: "next" });
    expect(req({ method: "POST", path: "/bff/api/rooms", headers: { ...json, origin: "https://evil.example.com" } }))
      .toMatchObject({ type: "error", status: 403 });
    expect(req({ method: "POST", path: "/bff/auth/signin", headers: { origin: SITE, "content-type": "text/plain" } }))
      .toMatchObject({ type: "error", status: 415 });
  });
});

describe("checkMutation (CSRF: Origin + JSON)", () => {
  const allowed = [SITE];
  const check = (method: string, origin: string | null, contentType: string | null = "application/json") =>
    checkMutation({ method, origin, contentType, allowed });

  it("lets same-site JSON through, with or without a charset", () => {
    expect(check("POST", SITE)).toBeNull();
    expect(check("PATCH", SITE, "application/json; charset=utf-8")).toBeNull();
  });
  it("rejects a missing, foreign or opaque Origin with 403", () => {
    for (const origin of [null, "https://evil.example.com", "null"]) expect(check("POST", origin)?.status).toBe(403);
    expect(check("DELETE", "https://evil.example.com")?.status).toBe(403);
  });
  it("rejects bodies a cross-site form can send with 415", () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", null]) expect(check("POST", SITE, type)?.status).toBe(415);
  });
  it("leaves safe methods alone", () => {
    expect(check("GET", null, null)).toBeNull();
  });
});
