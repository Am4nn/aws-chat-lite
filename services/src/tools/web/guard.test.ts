import { describe, expect, it } from "vitest";
import { ValidationError } from "../../lib/errors.js";
import { checkUrl, guardedLookup, isPublicAddress } from "./guard.js";

describe("isPublicAddress", () => {
  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"])("allows %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
  it.each([
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "100.127.255.255", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "not an ip",
    "192.0.0.8", "198.18.0.1", "198.19.255.255", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::10.0.0.1", "64:ff9b:1::1", "2002:7f00:1::1", "2002:a00:1::", "2001:0:4136:e378::1", "ff02::1",
  ])("refuses %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

describe("checkUrl", () => {
  it.each([
    "http://169.254.169.254/", "http://127.0.0.1:9001/", "http://[::1]/", "http://10.0.0.1/", "http://2130706433/", "http://0x7f.1/",
    "http://[::ffff:127.0.0.1]/", "file:///etc/passwd", "https://x.com:8443/", "ftp://example.com/", "http://user:pw@example.com/", "nonsense",
  ])("refuses %s", (raw) => {
    expect(() => checkUrl(raw)).toThrow(ValidationError);
  });
  it("accepts public http and https on the default ports", () => {
    expect(checkUrl("https://example.com/a?b=1").href).toBe("https://example.com/a?b=1");
    expect(checkUrl("http://example.com:80/").hostname).toBe("example.com");
  });
});

describe("guardedLookup", () => {
  const resolver = (address: string, family = 4) =>
    ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => cb(null, [{ address, family }])) as never;
  const call = (lookup: ReturnType<typeof guardedLookup>, host: string, all = false) =>
    new Promise<unknown>((resolve) => lookup(host, { all }, (err: unknown, a: unknown) => resolve(err ?? a)));

  it("refuses a public-looking name that resolves to a private address", async () => {
    const err = await call(guardedLookup(resolver("127.0.0.1")), "evil.example");
    expect((err as Error).message).toBe("evil.example points to a private address.");
  });
  it("refuses when any answer is private", async () => {
    const mixed = ((_h: string, _o: unknown, cb: (e: null, a: unknown[]) => void) =>
      cb(null, [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }])) as never;
    expect(((await call(guardedLookup(mixed), "x.example", true)) as Error).message).toContain("points to a private address");
  });
  it("passes public answers through", async () => {
    expect(await call(guardedLookup(resolver("8.8.8.8")), "ok.example", true)).toEqual([{ address: "8.8.8.8", family: 4 }]);
  });
});
