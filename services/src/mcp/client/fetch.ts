import type dns from "node:dns";
import http from "node:http";
import type net from "node:net";
import https from "node:https";
import { pipeline, Transform } from "node:stream";
import { ReadableStream } from "node:stream/web";
import { UserError } from "../../lib/errors.js";
import { guardedLookup } from "../../tools/web/guard.js";
import { MAX_ANSWER_BYTES, REQUEST_TIMEOUT_MS } from "./limits.js";
import { browserUrl } from "./url.js";

type Options = { localHosts?: string[]; lookup?: typeof dns.lookup; timeoutMs?: number; maxBytes?: number };

const BODILESS = [204, 205, 304];

/**
 * A `fetch` for talking to remote MCP and OAuth servers, which are chosen by admins and point us at further URLs.
 * Every address it connects to must be public (except `localHosts`, which `lookup` still resolves), checked in the
 * socket lookup so DNS rebinding can't slip past. It never follows a redirect: a 3xx goes back to the caller, so a
 * server can't bounce us to a private address. `timeoutMs` is a deadline for the whole exchange, answer included,
 * so a server that drips bytes can't hold the caller either.
 */
export function guardedFetch({ localHosts = [], lookup, timeoutMs = REQUEST_TIMEOUT_MS, maxBytes = MAX_ANSWER_BYTES }: Options = {}): typeof fetch {
  const checkedLookup = guardedLookup(lookup);
  return async (input, init) => {
    const url = browserUrl(input instanceof Request ? input.url : String(input), localHosts);
    const request = new Request(input, init);
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    const headers = Object.fromEntries(request.headers);
    if (body) headers["content-length"] = String(body.length);

    return new Promise<Response>((resolve, reject) => {
      let answered: http.IncomingMessage | undefined;
      let size = 0;
      const limited = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          done(size > maxBytes ? new UserError(`The server's answer is over ${maxBytes / 1_000_000} MB.`) : null, chunk);
        },
      });
      const out = (url.protocol === "https:" ? https : http).request(
        url,
        { method: request.method, headers, signal: request.signal, lookup: localHosts.includes(url.hostname) ? (lookup as net.LookupFunction | undefined) : checkedLookup },
        (res) => {
          answered = res;
          const status = res.statusCode ?? 0;
          // Node parses any three digits, but a Response past 599 throws, and here that would be uncaught.
          if (status > 599) return res.destroy(new UserError(`${url.hostname} answered with status ${status}.`));
          const answer = new Headers();
          for (let i = 0; i < res.rawHeaders.length; i += 2) answer.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
          // Errors reach the caller through `limited`, as an error on the body they're reading.
          pipeline(res, limited, () => {});
          const empty = request.method === "HEAD" || BODILESS.includes(status);
          if (empty) limited.resume();
          // Not Readable.toWeb: once a reader cancels, it can still enqueue a late chunk, which throws uncaught. Node's
          // web stream type differs from the DOM one Response is typed with, hence the cast.
          const stream = empty ? null : (ReadableStream.from(limited) as BodyInit);
          resolve(new Response(stream, { status, statusText: res.statusMessage, headers: answer }));
        },
      );
      const timer = setTimeout(() => (answered ?? out).destroy(new UserError(`${url.hostname} took too long to answer.`)), timeoutMs);
      limited.on("close", () => clearTimeout(timer));
      out.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      out.end(body);
    });
  };
}
