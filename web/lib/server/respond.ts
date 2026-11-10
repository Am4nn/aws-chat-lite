import { NextResponse } from "next/server";
import type { CookieSpec } from "./cookies";

export function withCookies<T extends NextResponse>(res: T, cookies: CookieSpec[]): T {
  for (const c of cookies) res.cookies.set(c.name, c.value, c.options);
  return res;
}

export const relativeRedirect = (location: string) =>
  new NextResponse(null, { status: 303, headers: { location, "cache-control": "no-store" } });

/** The request's JSON object, or {} when it has no body or the body isn't a JSON object. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

export const str = (v: unknown) => (typeof v === "string" ? v : "");

export const jsonError = (status: number, error: string) =>
  NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
