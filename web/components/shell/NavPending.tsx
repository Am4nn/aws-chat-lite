"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { clickTarget, placeOf } from "@/lib/client/navTarget";

// A tap must be felt on the same frame, so the rooms track where the user is heading instead of waiting for the server
// to commit the route. `from` is the page at tap time: once the router commits anything else (the target, a
// redirect, Back) the tap is stale and drops out without an effect.
type Tap = { to: string; from: string };
type Navigate = (href: string, options?: { replace?: boolean }) => void;

const Nav = createContext<{ here: string; pending: string | null; navigate: Navigate } | null>(null);

// A navigation that never commits (offline, a cancelled request) must not leave its skeleton up.
const GIVE_UP_MS = 10_000;

function useNav() {
  const nav = useContext(Nav);
  if (!nav) throw new Error("NavPendingProvider is missing");
  return nav;
}

/** Where a tap is heading (path and search), or null when nothing is in flight. */
export const useNavPending = () => useNav().pending;

/** The room page being shown or, while a tap is in flight, the one it is heading to. */
export function useCurrentPlace() {
  const { here, pending } = useNav();
  return placeOf(pending ?? here);
}

/** router.push or replace that marks its target pending first, for navigations that don't start from a link. */
export const useNavigate = () => useNav().navigate;

export function NavPendingProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const here = search ? `${pathname}?${search}` : pathname;
  const router = useRouter();
  const [tap, setTap] = useState<Tap | null>(null);

  // Link calls preventDefault when it takes a click over, and React's handler on the document root runs before this
  // listener, so that is the signal. Synchronous, so the new place and its skeleton paint before the next frame.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const to = clickTarget(e, new URL(here, location.origin).href);
      if (to) flushSync(() => setTap({ to, from: here }));
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [here]);

  // Once any navigation lands the tap is over. Kept, it would come back on Back, when the page matches its `from`
  // again. Cleared while rendering the new page, React's pattern for state that follows a prop.
  const [seen, setSeen] = useState(here);
  if (seen !== here) {
    setSeen(here);
    setTap(null);
  }

  useEffect(() => {
    if (!tap) return;
    const timer = setTimeout(() => setTap(null), GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [tap]);

  // A plain update: called from a click or key handler, React renders it before the next paint; flushSync would warn
  // when a navigation starts from an effect.
  const navigate = useCallback<Navigate>((href, { replace = false } = {}) => {
    const url = new URL(href, location.origin);
    const to = url.pathname + url.search;
    if (to !== here) setTap({ to, from: here });
    if (replace) router.replace(href);
    else router.push(href);
  }, [here, router]);

  const pending = tap && tap.from === here ? tap.to : null;
  const value = useMemo(() => ({ here, pending, navigate }), [here, pending, navigate]);
  return <Nav value={value}>{children}</Nav>;
}
