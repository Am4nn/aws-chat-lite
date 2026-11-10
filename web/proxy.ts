import { NextResponse, type NextRequest } from "next/server";
import { ID_COOKIE } from "./lib/server/cookies";
import { serverEnv } from "./lib/server/env";
import { gate } from "./lib/server/gate";

export function proxy(req: NextRequest) {
  const r = gate({
    method: req.method, pathname: req.nextUrl.pathname, search: req.nextUrl.search, headers: req.headers,
    idToken: req.cookies.get(ID_COOKIE)?.value, extraOrigins: serverEnv().siteOrigins,
  });
  if (r.type === "error") return NextResponse.json({ error: r.error }, { status: r.status });
  if (r.type === "redirect") return NextResponse.redirect(new URL(r.location, req.url), 307);
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
