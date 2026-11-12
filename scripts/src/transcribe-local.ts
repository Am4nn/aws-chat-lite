import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { WebSocketServer, type WebSocket } from "ws";
import { TRANSCRIBE_PORT } from "./ports.js";

const WORDS = "this is a fake transcript of what you said".split(" ");
/** Half a second of 16 kHz, 16-bit mono PCM. */
const BYTES_PER_WORD = 16_000;
const REQUIRED = { "language-code": "en-US", "media-encoding": "pcm", "sample-rate": "16000" };

const codec = new EventStreamCodec(toUtf8, fromUtf8);
const header = (value: string) => ({ type: "string" as const, value });
const json = (body: unknown) => fromUtf8(JSON.stringify(body));

function sendTranscript(ws: WebSocket, resultId: string, words: number, partial: boolean) {
  const text = Array.from({ length: words }, (_, i) => WORDS[i % WORDS.length]).join(" ");
  ws.send(codec.encode({
    headers: { ":message-type": header("event"), ":event-type": header("TranscriptEvent"), ":content-type": header("application/json") },
    body: json({
      Transcript: {
        Results: [{ ResultId: resultId, StartTime: 0, EndTime: words / 2, IsPartial: partial, Alternatives: [{ Transcript: text, Items: [] }] }],
      },
    }),
  }));
}

function refuse(ws: WebSocket, message: string) {
  ws.send(codec.encode({
    headers: { ":message-type": header("exception"), ":exception-type": header("BadRequestException"), ":content-type": header("application/json") },
    body: json({ Message: message }),
  }));
  ws.close();
}

/**
 * Amazon Transcribe streaming for the local stage, on localhost: the same URL query and the same AWS
 * event-stream frames, so the browser's dictation code runs unchanged. It hears nothing; every half second of audio
 * adds the next word of a fixed sentence, and the empty audio event that ends a stream gets the final text.
 */
export function startLocalTranscribeServer(port = TRANSCRIBE_PORT) {
  const server = createServer((_req, res) => res.writeHead(426).end());
  new WebSocketServer({ server }).on("connection", (ws, req) => {
    const query = new URL(req.url ?? "/", "ws://localhost").searchParams;
    const wrong = Object.entries(REQUIRED).find(([k, v]) => query.get(k) !== v);
    if (wrong) return refuse(ws, `${wrong[0]} must be ${wrong[1]}.`);

    const resultId = randomUUID();
    let bytes = 0;
    let words = 0;
    ws.on("message", (data: Buffer) => {
      let frame;
      try {
        frame = codec.decode(data);
      } catch {
        return refuse(ws, "Each message must be one event-stream frame.");
      }
      const { headers, body } = frame;
      if (headers[":event-type"]?.value !== "AudioEvent") return;
      if (!body.length) {
        if (words) sendTranscript(ws, resultId, words, false);
        return ws.close(1000);
      }
      bytes += body.length;
      for (; bytes >= BYTES_PER_WORD; bytes -= BYTES_PER_WORD) sendTranscript(ws, resultId, ++words, true);
    });
  });
  server.once("listening", () => console.log(`Transcribe (fake): ws://localhost:${(server.address() as AddressInfo).port}`));
  return server.listen(port);
}
