import { beforeEach, describe, expect, it, vi } from "vitest";

const cognito = vi.hoisted(() => ({
  signUp: vi.fn(async () => ({ confirmed: false, sentTo: "" })),
  signIn: vi.fn(),
  authErrorMessage: () => "error",
}));
vi.mock("@/lib/server/cognito", () => cognito);

const { POST } = await import("./route");

const signup = (username: string) =>
  POST(new Request("http://localhost/bff/auth/signup", { method: "POST", body: JSON.stringify({ username, password: "pw-123456" }) }));

describe("POST /bff/auth/signup", () => {
  beforeEach(() => cognito.signUp.mockClear());

  it.each(["agent", "everyone", "Agent"])("refuses the reserved username %s", async (username) => {
    const res = await signup(username);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That username is reserved." });
    expect(cognito.signUp).not.toHaveBeenCalled();
  });

  it("passes any other username to Cognito", async () => {
    const res = await signup("ann");
    expect(res.status).toBe(200);
    expect(cognito.signUp).toHaveBeenCalledOnce();
  });
});
