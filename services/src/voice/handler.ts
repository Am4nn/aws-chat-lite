import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { idOf, seqNumber } from "../chat/model.js";
import { callerFromEvent, type User } from "../lib/auth.js";
import { ValidationError } from "../lib/errors.js";
import { errorResponse, json, parseBody } from "../lib/http.js";
import { MAX_DICTATION_SEC, voiceRepo, type VoiceRepo } from "./repo.js";
import { speaker } from "./speaker.js";
import { speak } from "./speech.js";
import { SAMPLE_RATE, transcribeUrl } from "./transcribe.js";

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

export interface Deps {
  voice: Pick<VoiceRepo, "mint" | "done">;
  transcribeUrl: (sessionId: string) => Promise<string>;
  speak: (user: User, roomId: string, ref: { chatId: string; seq: number }) => Promise<{ url: string; cached: boolean }>;
}

function secondsOf(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) throw new ValidationError("seconds must be a number of seconds.");
  return raw;
}

/** Dictation sessions and read-aloud over HTTP. */
export function makeHandler(deps: Deps) {
  return async (event: Event): Promise<APIGatewayProxyStructuredResultV2> => {
    const roomId = event.pathParameters?.roomId ?? "";
    const body = parseBody(event) as Record<string, unknown> | null;
    if (body === null) return json(400, { error: "Body must be JSON." });
    try {
      const user = callerFromEvent(event);
      switch (event.routeKey) {
        case "POST /rooms/{roomId}/voice/sessions": {
          // Signed before the reservation is charged: a session that never got a URL would never report back to refund it.
          const sessionId = randomUUID();
          const url = await deps.transcribeUrl(sessionId);
          await deps.voice.mint(user, roomId, sessionId);
          return json(200, { sessionId, url, maxSeconds: MAX_DICTATION_SEC, sampleRate: SAMPLE_RATE });
        }

        case "POST /rooms/{roomId}/voice/sessions/{sessionId}/done": {
          const sessionId = idOf(event.pathParameters?.sessionId, "sessionId");
          return json(200, await deps.voice.done(user, roomId, sessionId, secondsOf(body.seconds)));
        }

        case "POST /rooms/{roomId}/speech":
          return json(200, await deps.speak(user, roomId, { chatId: idOf(body.chatId, "chatId"), seq: seqNumber(body.seq) }));

        default:
          return json(404, { error: "No such route." });
      }
    } catch (e) {
      return errorResponse(e);
    }
  };
}

function liveDeps(): Deps {
  const mode = process.env.VOICE_MODE;
  const voice = speaker(mode);
  return {
    voice: voiceRepo(),
    transcribeUrl: (sessionId) => transcribeUrl(mode, { sessionId, region: process.env.AWS_REGION!, now: new Date() }),
    speak: (user, roomId, ref) => speak(user, roomId, ref, voice),
  };
}

// Built on first use, so tests can import makeHandler without a table configured.
let liveHandler: ReturnType<typeof makeHandler> | undefined;
export const handler = (event: Event) => (liveHandler ??= makeHandler(liveDeps()))(event);
