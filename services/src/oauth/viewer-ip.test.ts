import { describe, expect, it } from "vitest";
import { viewerIp } from "./viewer-ip.js";

const ev = (headers: Record<string, string>) => ({ headers, requestContext: { http: { sourceIp: "130.176.0.1" } } }) as any;

describe("viewerIp (who an OAuth rate limit counts)", () => {
  it("behind CloudFront, is the viewer's address without its port", () => {
    expect(viewerIp(ev({ "x-origin-verify": "s3cret", "cloudfront-viewer-address": "198.51.100.10:46532" }), "s3cret")).toBe("198.51.100.10");
    expect(viewerIp(ev({ "x-origin-verify": "s3cret", "cloudfront-viewer-address": "2001:db8::1:46532" }), "s3cret")).toBe("2001:db8::1");
  });

  it("ignores a viewer address that didn't come with CloudFront's secret, which anyone calling the API could forge", () => {
    expect(viewerIp(ev({ "cloudfront-viewer-address": "203.0.113.9:1" }), "s3cret")).toBe("130.176.0.1");
    expect(viewerIp(ev({ "x-origin-verify": "wrong!", "cloudfront-viewer-address": "203.0.113.9:1" }), "s3cret")).toBe("130.176.0.1");
    expect(viewerIp(ev({ "x-origin-verify": "s3cret", "cloudfront-viewer-address": "203.0.113.9:1" }), undefined)).toBe("130.176.0.1");
  });

  it("is the caller's own address when the request has no viewer address", () => {
    expect(viewerIp(ev({ "x-origin-verify": "s3cret" }), "s3cret")).toBe("130.176.0.1");
    expect(viewerIp({ requestContext: { http: { sourceIp: "1.2.3.4" } } } as any, "s3cret")).toBe("1.2.3.4");
  });
});
