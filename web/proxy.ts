import { NextResponse, type NextRequest } from "next/server";
import { ID_COOKIE } from "./lib/server/cookies";
import { serverEnv } from "./lib/server/env";
import { gate } from "./lib/server/gate";
import { PATH_HEADER } from "./lib/server/next-path";

export function proxy(req: NextRequest) {
  const env = serverEnv();
  const r = gate({
    method: req.method, pathname: req.nextUrl.pathname, search: req.nextUrl.search, headers: req.headers,
    idToken: req.cookies.get(ID_COOKIE)?.value, originSecret: env.originSecret, extraOrigins: env.siteOrigins,
  });
  if (r.type === "error") return NextResponse.json({ error: r.error }, { status: r.status });
  if (r.type === "redirect") return NextResponse.redirect(new URL(r.location, req.url), 307);
  // Server components can't see the URL they render for; this header lets them send the user back here after sign-in.
  const headers = new Headers(req.headers);
  headers.set(PATH_HEADER, req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
