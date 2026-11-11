import dns from "node:dns";
import net from "node:net";
import { ValidationError } from "../../lib/errors.js";

const PORTS = ["80", "443"];

const inV4 = (ip: number[], base: number[], bits: number) => {
  const a = ((ip[0]! << 24) | (ip[1]! << 16) | (ip[2]! << 8) | ip[3]!) >>> 0;
  const b = ((base[0]! << 24) | (base[1]! << 16) | (base[2]! << 8) | base[3]!) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
};

const PRIVATE_V4: [number[], number][] = [
  [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16], [[172, 16, 0, 0], 12], [[192, 0, 0, 0], 24], [[192, 168, 0, 0], 16], [[198, 18, 0, 0], 15],
  [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4],
];

const v4Of = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

/** Expands any IPv6 text form (`::`, a dotted IPv4 tail) to eight 16-bit groups. */
function v6Groups(ip: string): number[] {
  let text = ip;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[1]!.split(".").map(Number);
    text = text.slice(0, -dotted[1]!.length) + ((a! << 8) | b!).toString(16) + ":" + ((c! << 8) | d!).toString(16);
  }
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].map((g) => parseInt(g, 16));
}

/**
 * False for anything that could reach inside a network or isn't one host: private, loopback, link-local, metadata,
 * unspecified, benchmarking, multicast and reserved.
 */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const parts = ip.split(".").map(Number);
    return !PRIVATE_V4.some(([base, bits]) => inV4(parts, base, bits));
  }
  if (family !== 6) return false;
  const g = v6Groups(ip) as [number, number, number, number, number, number, number, number];
  // IPv4-mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::a.b.c.d) and 6to4 (2002:aabb:ccdd::) addresses reach the IPv4 host
  // they embed, so that host is judged. The unspecified and loopback addresses fall in the first range and are refused.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return g[5] === 0xffff && isPublicAddress(v4Of(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicAddress(v4Of(g[6], g[7]));
  if (g[0] === 0x2002) return isPublicAddress(v4Of(g[1], g[2]));
  // Teredo hides its host in obfuscated bits, and the rest of 64::/16 is local-use NAT64 or unassigned.
  if ((g[0] === 0x2001 && g[1] === 0) || g[0] === 0x64) return false;
  return (g[0] & 0xfe00) !== 0xfc00 && (g[0] & 0xffc0) !== 0xfe80 && (g[0] & 0xff00) !== 0xff00;
}

/** Throws a plain reason unless the URL is http(s) on 80/443 and not an IP literal inside a network. */
export function checkUrl(raw: string, ports: string[] = PORTS): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError("That isn't a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ValidationError("Only http and https links can be fetched.");
  if (url.username || url.password) throw new ValidationError("Links with a username or password aren't allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !isPublicAddress(host)) throw new ValidationError("That address is private.");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (!ports.includes(port)) throw new ValidationError("Only ports 80 and 443 can be fetched.");
  return url;
}

type Lookup = typeof dns.lookup;

/** A socket `lookup` that checks the addresses the connection will actually use, so DNS rebinding can't slip past. */
export function guardedLookup(lookup: Lookup = dns.lookup): net.LookupFunction {
  return (hostname, options, callback) => {
    (lookup as unknown as (h: string, o: object, cb: (e: Error | null, a: dns.LookupAddress[]) => void) => void)(
      hostname,
      { ...options, all: true },
      (err, addresses) => {
        if (err) return callback(err, "", 4);
        if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
          return callback(new ValidationError(`${hostname} points to a private address.`), "", 4);
        }
        if (options.all) return callback(null, addresses as never);
        callback(null, addresses[0]!.address, addresses[0]!.family);
      },
    );
  };
}
