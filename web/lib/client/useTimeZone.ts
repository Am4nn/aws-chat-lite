"use client";

import { useEffect, useState } from "react";
import { TZ_COOKIE } from "./format";

/**
 * Starts with the zone the server rendered with, so hydration matches, then switches to the browser's own. The cookie
 * lets the server render the right zone next time; only a first visit ever re-renders its times.
 */
export function useTimeZone(serverTimeZone: string): string {
  const [timeZone, setTimeZone] = useState(serverTimeZone);
  useEffect(() => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    document.cookie = `${TZ_COOKIE}=${encodeURIComponent(local)}; path=/; max-age=31536000; samesite=lax`;
    setTimeZone(local);
  }, []);
  return timeZone;
}
