import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const api = vi.hoisted(() => ({ idToken: async () => "id-token", callApi: vi.fn<() => Promise<Response>>() }));
vi.mock("@/lib/server/api", () => api);

const { DELETE, GET } = await import("./route");

const call = (handler: typeof GET, method: string, path: string) =>
  handler(new NextRequest(`http://localhost/bff/api/${path}`, { method }), { params: Promise.resolve({ path: path.split("/") }) });

describe("/bff/api/*", () => {
  it("passes a 204 through with no body", async () => {
    api.callApi.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await call(DELETE, "DELETE", "rooms/r1/invite");
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("answers an empty body as {}", async () => {
    api.callApi.mockResolvedValueOnce(new Response("", { status: 200 }));
    expect(await (await call(GET, "GET", "rooms/r1/invite")).json()).toEqual({});
  });
});
