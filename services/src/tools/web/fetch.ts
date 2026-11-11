import http from "node:http";
import https from "node:https";
import type net from "node:net";
import { UserError } from "../../lib/errors.js";
import type { Page, Tool } from "../types.js";
import { checkUrl, guardedLookup } from "./guard.js";

const MAX_OUTPUT = 20_000;
const TEXT_TYPES = /^(text\/|application\/(json|xml|[\w.+-]+\+(json|xml)))/;

type FetchOptions = { lookup?: net.LookupFunction; ports?: string[]; maxRedirects?: number; timeoutMs?: number; maxBytes?: number };

/** Every tool's output is cut at the same length so one result can't fill the model's context. */
export const cut = (text: string) => (text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…(cut)` : text);

function get(url: URL, lookup: net.LookupFunction, timeoutMs: number, maxBytes: number): Promise<Page & { location?: string }> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      { lookup, method: "GET", headers: { "user-agent": "chat-lite/1.0", accept: "text/html,text/plain,application/json,application/xml;q=0.9" } },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = (res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        const location = res.headers.location;
        if ((status >= 300 && status < 400 && location) || !TEXT_TYPES.test(contentType)) {
          res.destroy();
          return resolve({ url: url.href, status, contentType, body: "", location });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) return request.destroy(new UserError(`The page is over ${maxBytes / 1_000_000} MB.`));
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ url: url.href, status, contentType, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new UserError("The page took too long to answer.")));
    request.on("error", reject);
    request.end();
  });
}

/** Fetches a page, following up to `maxRedirects` redirects and re-checking the address of every hop. */
export async function fetchPage(
  raw: string,
  { lookup = guardedLookup(), ports, maxRedirects = 3, timeoutMs = 10_000, maxBytes = 2_000_000 }: FetchOptions = {},
): Promise<Page> {
  let target = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const page = await get(checkUrl(target, ports), lookup, timeoutMs, maxBytes);
    if (!page.location) return page;
    target = new URL(page.location, page.url).href;
  }
  throw new UserError("Too many redirects.");
}

const decode = (text: string) =>
  text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]!.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[entity.toLowerCase()] ?? whole;
  });

export function htmlText(html: string): { title: string; text: string } {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const text = decode(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
  return { title, text };
}

export const webFetch: Tool = {
  spec: {
    name: "web_fetch",
    description: "Fetches a public web page (http or https) and returns its text. Use it to read a link or a search result.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  kind: "web",
  write: false,
  detail: (input) => String(input.url ?? ""),
  check: (input) => (typeof input.url === "string" && input.url ? null : "A url is required."),
  async run(input, env) {
    let page: Page;
    try {
      page = await env.fetchPage(String(input.url));
    } catch (err) {
      return { ok: false, output: err instanceof UserError ? err.message : "The page couldn't be fetched." };
    }
    if (!TEXT_TYPES.test(page.contentType)) return { ok: false, output: `Not a text page (${page.contentType || "unknown type"}).` };
    const { title, text } = page.contentType === "text/html" ? htmlText(page.body) : { title: "", text: page.body.trim() };
    const name = title || page.url;
    return { ok: page.status < 400, output: cut(`${name}\n${page.url}\n\n${text}`), sources: [{ title: name, url: page.url }] };
  },
};
