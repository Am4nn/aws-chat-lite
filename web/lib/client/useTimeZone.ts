"use client";

import { useEffect, useState } from "react";
import { TZ_COOKIE } from "./format";

/** Leaves the browser's zone in a cookie, so the server renders times in it from then on. */
export function rememberTimeZone(): string {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  document.cookie = `${TZ_COOKIE}=${encodeURIComponent(local)}; path=/; max-age=31536000; samesite=lax`;
  return local;
}

/**
 * Starts with the zone the server rendered with, so hydration matches, then switches to the browser's own. The sign-in
 * page already set the cookie, so in practice the two agree and nothing re-renders.
 */
export function useTimeZone(serverTimeZone: string): string {
  const [timeZone, setTimeZone] = useState(serverTimeZone);
  useEffect(() => setTimeZone(rememberTimeZone()), []);
  return timeZone;
}
