import { describe, expect, it, vi } from "vitest";
import { makeHandler, type Deps } from "./handler.js";

function fakes() {
  const deps = {
    voice: {
      mint: vi.fn(async () => {}),
      done: vi.fn(async () => ({ billedSeconds: 7 })),
    },
    transcribeUrl: vi.fn(async (sessionId: string) => `ws://localhost:4601/x?session=${sessionId}`),
    speak: vi.fn(async () => ({ url: "http://s3/speech.mp3", cached: false })),
  };
  return { deps, handle: makeHandler(deps as unknown as Deps) };
}

const ev = (routeKey: string, body?: unknown, sessionId?: string) => ({
  routeKey,
  body: body === undefined ? undefined : JSON.stringify(body),
  pathParameters: { roomId: "r", sessionId },
  requestContext: { authorizer: { jwt: { claims: { sub: "u1", "cognito:username": "aman" } } } },
}) as any;

const result = (res: { statusCode?: number; body?: string }) => ({ status: res.statusCode, body: res.body && JSON.parse(res.body) });
const me = { userId: "u1", username: "aman" };

describe("voice handler", () => {
  it("starts a dictation: a session and the socket to stream it on", async () => {
    const { deps, handle } = fakes();
    const { status, body } = result(await handle(ev("POST /rooms/{roomId}/voice/sessions")));
    expect(status).toBe(200);
    expect(body).toEqual({ sessionId: expect.any(String), url: `ws://localhost:4601/x?session=${body.sessionId}`, maxSeconds: 60, sampleRate: 16000 });
    expect(deps.voice.mint).toHaveBeenCalledWith(me, "r", body.sessionId);
  });

  it("signs the socket before reserving the dictation, so a signing failure charges the room nothing", async () => {
    const { deps, handle } = fakes();
    deps.transcribeUrl.mockRejectedValueOnce(new Error("TRANSCRIBE_LOCAL_URL not set"));
    expect((await handle(ev("POST /rooms/{roomId}/voice/sessions"))).statusCode).toBe(500);
    expect(deps.voice.mint).not.toHaveBeenCalled();
  });

  it("ends a dictation with the seconds it ran", async () => {
    const { deps, handle } = fakes();
    expect(result(await handle(ev("POST /rooms/{roomId}/voice/sessions/{sessionId}/done", { seconds: 6.5 }, "s1")))).toEqual({
      status: 200, body: { billedSeconds: 7 },
    });
    expect(deps.voice.done).toHaveBeenCalledWith(me, "r", "s1", 6.5);
  });

  it.each([[{}], [{ seconds: -1 }], [{ seconds: "7" }], [{ seconds: null }]])("refuses done with %j", async (body) => {
    const { deps, handle } = fakes();
    expect((await handle(ev("POST /rooms/{roomId}/voice/sessions/{sessionId}/done", body, "s1"))).statusCode).toBe(400);
    expect(deps.voice.done).not.toHaveBeenCalled();
  });

  it("refuses a session id that can't be a key", async () => {
    const { deps, handle } = fakes();
    expect((await handle(ev("POST /rooms/{roomId}/voice/sessions/{sessionId}/done", { seconds: 1 }, "a#b"))).statusCode).toBe(400);
    expect(deps.voice.done).not.toHaveBeenCalled();
  });

  it("reads an answer aloud", async () => {
    const { deps, handle } = fakes();
    expect(result(await handle(ev("POST /rooms/{roomId}/speech", { chatId: "c1", seq: 4 })))).toEqual({
      status: 200, body: { url: "http://s3/speech.mp3", cached: false },
    });
    expect(deps.speak).toHaveBeenCalledWith(me, "r", { chatId: "c1", seq: 4 });
  });

  it("refuses speech without a chat id or a message number", async () => {
    const { deps, handle } = fakes();
    expect((await handle(ev("POST /rooms/{roomId}/speech", { seq: 4 }))).statusCode).toBe(400);
    expect((await handle(ev("POST /rooms/{roomId}/speech", { chatId: "c1", seq: 1.5 }))).statusCode).toBe(400);
    expect(deps.speak).not.toHaveBeenCalled();
  });
});
