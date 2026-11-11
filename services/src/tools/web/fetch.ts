import http from "node:http";
import https from "node:https";
import type net from "node:net";
import { UserError } from "../../lib/errors.js";
import { cut } from "../cut.js";
import type { Page, Tool } from "../types.js";
import { checkUrl, guardedLookup } from "./guard.js";

const TEXT_TYPES = /^(text\/|application\/(json|xml|[\w.+-]+\+(json|xml)))/;

type FetchOptions = { lookup?: net.LookupFunction; ports?: string[]; maxRedirects?: number; timeoutMs?: number; maxBytes?: number };

function get(url: URL, lookup: net.LookupFunction, deadline: number, maxBytes: number): Promise<Page & { location?: string }> {
  let timer: NodeJS.Timeout | undefined;
  return new Promise<Page & { location?: string }>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      { lookup, method: "GET", headers: { "user-agent": "chat-lite/1.0", accept: "text/html,text/plain,application/json,application/xml;q=0.9" } },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = (res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        const location = status >= 300 && status < 400 ? res.headers.location : undefined;
        if (location || !TEXT_TYPES.test(contentType)) {
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
    // A deadline, not an idle timeout: a server that drips a byte at a time would keep resetting an idle one.
    timer = setTimeout(() => request.destroy(new UserError("The page took too long to answer.")), deadline - Date.now());
    request.on("error", reject);
    request.end();
  }).finally(() => clearTimeout(timer));
}

/**
 * Fetches a page, following up to `maxRedirects` redirects and re-checking the address of every hop, all within one
 * `timeoutMs`.
 */
export async function fetchPage(
  raw: string,
  { lookup = guardedLookup(), ports, maxRedirects = 3, timeoutMs = 10_000, maxBytes = 2_000_000 }: FetchOptions = {},
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  let target = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const page = await get(checkUrl(target, ports), lookup, deadline, maxBytes);
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

const MAX_HTML = 500_000;
const clean = (text: string) => decode(text).replace(/\s+/g, " ").trim();

/**
 * A page's title and visible text, in one forward pass. Patterns such as `<[^>]*>` or a lazy `[\s\S]*?` scan to the
 * end of the page from every start they fail at, which is quadratic on hostile input like a page of `<`. Only the
 * first 500 KB is read, since the output is cut far shorter.
 */
export function htmlText(page: string): { title: string; text: string } {
  const html = page.slice(0, MAX_HTML);
  const block = /<!--|<(script|style|noscript|svg|title)\b/gi;
  const kept: string[] = [];
  let title = "";
  let at = 0;
  for (let open = block.exec(html); open; open = block.exec(html)) {
    kept.push(html.slice(at, open.index));
    const close = open[1] ? new RegExp(`</${open[1]}[^<>]*>`, "gi") : /-->/g;
    close.lastIndex = block.lastIndex;
    const end = close.exec(html);
    const inner = html.slice(block.lastIndex, end?.index ?? html.length);
    if (open[1]?.toLowerCase() === "title" && !title) title = inner.slice(inner.indexOf(">") + 1);
    // An unclosed block runs to the end of the page, as it does in a browser.
    at = end ? close.lastIndex : html.length;
    block.lastIndex = at;
    if (!end) break;
  }
  kept.push(html.slice(at));
  return { title: clean(title), text: clean(kept.join(" ").replace(/<[^<>]*>/g, " ")) };
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
