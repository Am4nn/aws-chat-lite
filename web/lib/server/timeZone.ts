import { cookies } from "next/headers";
import { TZ_COOKIE } from "../client/format";

/** The reader's zone, which the browser leaves in a cookie, so server-rendered times match what the browser renders. */
export async function readerTimeZone(): Promise<string> {
  const tz = (await cookies()).get(TZ_COOKIE)?.value;
  try {
    return tz ? new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone : "UTC";
  } catch {
    return "UTC";
  }
}
