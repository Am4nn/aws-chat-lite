import { useCallback, useEffect, useState } from "react";
import { bff, errorText } from "@/lib/client/bff";
import { useToast } from "@/components/overlays/Toast";

/**
 * The last answer for each path, so a panel shown again (the room panel unmounts the tabs it isn't showing) draws at
 * once while it fetches again. It lives as long as the page: signing in is a full page load, so one person's cache is
 * never shown to the next.
 */
const cache = new Map<string, unknown>();

/**
 * A room panel's data, the server's answer being the truth: loaded on mount, and again on `reload()` or when `key`
 * changes. A failed load toasts its reason. With nothing to show yet it also sets `failed`, so the panel offers a
 * retry instead of loading for good; with an earlier answer on screen, that answer stays.
 */
export function useRoomData<T>(path: string, key?: unknown) {
  const toast = useToast();
  const [data, setData] = useState<T | null>(() => (cache.get(path) as T | undefined) ?? null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [shownPath, setShownPath] = useState(path);
  if (shownPath !== path) {
    setShownPath(path);
    setData((cache.get(path) as T | undefined) ?? null);
    setFailed(false);
  }

  // Changes made on screen (optimistic ones included) are cached too, so they survive a tab switch.
  useEffect(() => {
    if (data !== null) cache.set(path, data);
  }, [path, data]);

  useEffect(() => {
    let current = true;
    bff<T>(path).then(
      (d) => {
        if (!current) return;
        setData(d);
        setFailed(false);
      },
      (e) => {
        if (!current) return;
        if (!cache.has(path)) setFailed(true);
        toast(errorText(e), "error");
      },
    );
    return () => { current = false; };
  }, [path, version, key, toast]);

  const reload = useCallback(() => {
    setFailed(false);
    setVersion((v) => v + 1);
  }, []);

  return { data, setData, failed, reload };
}
