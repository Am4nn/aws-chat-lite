import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";

export const SAMPLE_RATE = 16_000;
/** The longest a presigned Transcribe socket URL may live; the browser connects within seconds. */
const URL_EXPIRY_SEC = 300;
const PATH = "/stream-transcription-websocket";
const QUERY = { "language-code": "en-US", "media-encoding": "pcm", "sample-rate": String(SAMPLE_RATE) };

type Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

/**
 * Where the browser streams a dictation. Live, it is Transcribe's own WebSocket, presigned with this Lambda's role, so
 * the audio never passes through a Lambda and the browser never holds a credential: the URL carries a signature, the
 * access key id and the session token, not the secret key. Fake, it is the local server that speaks the same frames.
 */
export async function transcribeUrl(
  mode: string | undefined, o: { sessionId: string; region: string; now: Date; credentials?: Credentials },
): Promise<string> {
  if (mode !== "live") {
    const local = process.env.TRANSCRIBE_LOCAL_URL;
    if (!local) throw new Error("TRANSCRIBE_LOCAL_URL not set");
    return `${local}${PATH}?${new URLSearchParams({ ...QUERY, session: o.sessionId })}`;
  }
  const hostname = `transcribestreaming.${o.region}.amazonaws.com`;
  const signer = new SignatureV4({
    service: "transcribe", region: o.region, sha256: Hash.bind(null, "sha256"), credentials: o.credentials ?? defaultProvider(),
  });
  const signed = await signer.presign(
    { method: "GET", protocol: "wss:", hostname, port: 8443, path: PATH, query: QUERY, headers: { host: `${hostname}:8443` } },
    { expiresIn: URL_EXPIRY_SEC, signingDate: o.now },
  );
  return `wss://${hostname}:8443${PATH}?${new URLSearchParams(signed.query as Record<string, string>)}`;
}
