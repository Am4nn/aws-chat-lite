import { describe, expect, it } from "vitest";
import {
  OAuthError, authServerMetadata, grantIdOf, hashOf, newSecret, parseScope, redirectMatches, resourceMetadata, validRedirectUri, verifyPkce,
} from "./model.js";

describe("validRedirectUri", () => {
  it.each([
    ["https://claude.ai/api/mcp/auth_callback", true],
    ["http://127.0.0.1:33418/callback", true],
    ["http://localhost/cb", true],
    ["http://[::1]:8080/cb", true],
    ["http://example.com/cb", false],
    ["myapp://cb", false],
    ["https://x.com/cb#f", false],
    ["https://user:pw@x.com/cb", false],
    ["not a url", false],
  ])("%s → %s", (uri, ok) => expect(validRedirectUri(uri)).toBe(ok));

  it("refuses anything that isn't a string", () => expect(validRedirectUri(42)).toBe(false));
});

describe("redirectMatches", () => {
  it("a loopback http URI matches on any port", () => {
    expect(redirectMatches(["http://localhost:1/cb"], "http://localhost:5555/cb")).toBe(true);
    expect(redirectMatches(["http://127.0.0.1/cb"], "http://127.0.0.1:33418/cb")).toBe(true);
  });

  it("everything else must match exactly", () => {
    expect(redirectMatches(["https://x.com:8443/cb"], "https://x.com:9443/cb")).toBe(false);
    expect(redirectMatches(["https://x.com/cb"], "https://x.com/cb")).toBe(true);
    expect(redirectMatches(["https://x.com/cb"], "https://x.com/cb/")).toBe(false);
    expect(redirectMatches(["http://localhost:1/cb"], "http://localhost:5555/other")).toBe(false);
    expect(redirectMatches(["http://localhost:1/cb"], "http://127.0.0.1:1/cb")).toBe(false);
  });
});

describe("verifyPkce", () => {
  // RFC 7636, appendix B.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("accepts the RFC's pair and refuses one changed character", () => {
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce(`${verifier.slice(0, -1)}l`, challenge)).toBe(false);
  });

  it("refuses a verifier that is too short or has other characters", () => {
    expect(verifyPkce("short", challenge)).toBe(false);
    expect(verifyPkce(`${verifier.slice(0, -1)}+`, challenge)).toBe(false);
  });
});

describe("parseScope", () => {
  it("none requested means both, and duplicates collapse in a fixed order", () => {
    expect(parseScope(undefined)).toEqual(["rooms:read", "rooms:write"]);
    expect(parseScope(" ")).toEqual(["rooms:read", "rooms:write"]);
    expect(parseScope("rooms:write rooms:read rooms:write")).toEqual(["rooms:read", "rooms:write"]);
    expect(parseScope("rooms:read")).toEqual(["rooms:read"]);
  });

  it("an unknown scope is invalid_scope", () => {
    expect(() => parseScope("admin")).toThrow(expect.objectContaining({ code: "invalid_scope" }));
    expect(() => parseScope("rooms:read admin")).toThrow(OAuthError);
  });
});

describe("secrets", () => {
  it("tokens carry their grant id; codes don't", () => {
    const at = newSecret("at", "0e4a6f3c-2b1d-4c5e-9f8a-7b6c5d4e3f2a");
    expect(at.token).toMatch(/^cl_at_0e4a6f3c-2b1d-4c5e-9f8a-7b6c5d4e3f2a_[A-Za-z0-9_-]{43}$/);
    expect(grantIdOf(at.token)).toBe("0e4a6f3c-2b1d-4c5e-9f8a-7b6c5d4e3f2a");
    expect(grantIdOf(newSecret("rt", "0e4a6f3c-2b1d-4c5e-9f8a-7b6c5d4e3f2a").token)).toBe("0e4a6f3c-2b1d-4c5e-9f8a-7b6c5d4e3f2a");
    const code = newSecret("code");
    expect(code.token).toMatch(/^cl_code_[A-Za-z0-9_-]{43}$/);
    expect(grantIdOf(code.token)).toBeNull();
    expect(grantIdOf("cl_at_nope")).toBeNull();
  });

  it("only the sha256 hex is kept", () => {
    const { token, hash } = newSecret("code");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashOf(token));
    expect(newSecret("code").token).not.toBe(token);
  });
});

describe("metadata", () => {
  const base = "https://chat.example";

  it("the authorization server offers code + PKCE S256 to public clients only", () => {
    expect(authServerMetadata(base)).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["rooms:read", "rooms:write"],
    });
  });

  it("the protected resource is /mcp, served by this issuer", () => {
    expect(resourceMetadata(base)).toMatchObject({
      resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["rooms:read", "rooms:write"],
    });
  });
});
