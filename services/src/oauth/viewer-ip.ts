import { timingSafeEqual } from "node:crypto";

type Event = { headers?: Record<string, string | undefined>; requestContext: { http: { sourceIp: string } } };

/**
 * The address a request came from. Through CloudFront the API only sees an edge server, so the viewer's own address
 * comes from the CloudFront-Viewer-Address header (`ip:port`, the port after the last colon, IPv6 included). The API
 * also answers on its own execute-api host, where anyone could send that header, so it only counts when the request
 * also carries the origin secret only CloudFront knows.
 */
export function viewerIp(event: Event, originSecret: string | undefined): string {
  const address = event.headers?.["cloudfront-viewer-address"];
  const sent = Buffer.from(event.headers?.["x-origin-verify"] ?? "");
  const fromCloudFront = !!originSecret && sent.length === Buffer.byteLength(originSecret) && timingSafeEqual(sent, Buffer.from(originSecret));
  return fromCloudFront && address ? address.slice(0, address.lastIndexOf(":")) : event.requestContext.http.sourceIp;
}
