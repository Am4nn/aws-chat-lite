import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const fresh = (secondsLeft: number) =>
  `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsLeft })).toString("base64url")}.s`;
const api = vi.hoisted(() => ({ idToken: vi.fn<() => Promise<string | undefined>>(), callApi: vi.fn<() => Promise<Response>>() }));
vi.mock("@/lib/server/api", () => api);

const { GET } = await import("./route");

const open = (query: string) => GET(new NextRequest(`http://localhost/bff/github/callback?${query}`));

describe("/bff/github/callback", () => {
  it("finishes the sign-in as the signed-in user and returns to the room to pick repos", async () => {
    api.idToken.mockResolvedValueOnce(fresh(600));
    api.callApi.mockResolvedValueOnce(Response.json({ roomId: "r1" }));
    const res = await open("state=s1&code=c1");
    expect(api.callApi).toHaveBeenCalledWith("/github-flows/finish", expect.any(String), { method: "POST", body: '{"state":"s1","code":"c1"}' });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/r/r1?github=pick");
  });

  it("passes GitHub's refusal on, and lands in the room with the API's error", async () => {
    api.idToken.mockResolvedValueOnce(fresh(600));
    api.callApi.mockResolvedValueOnce(Response.json({ roomId: "r1", error: "GitHub didn't allow access (access_denied)." }, { status: 502 }));
    const res = await open("state=s1&error=access_denied");
    expect(api.callApi).toHaveBeenLastCalledWith("/github-flows/finish", expect.any(String), { method: "POST", body: '{"state":"s1","error":"access_denied"}' });
    expect(res.headers.get("location")).toBe("/r/r1?githubError=GitHub+didn%27t+allow+access+%28access_denied%29.");
  });

  it("sends a user without a fresh session to sign in, without finishing", async () => {
    api.callApi.mockClear();
    api.idToken.mockResolvedValueOnce(fresh(30));
    const res = await open("state=s1&code=c1");
    expect(api.callApi).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("/login");
  });
});
