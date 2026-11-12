import { useCallback, useEffect, useState } from "react";
import { bff, errorText } from "@/lib/client/bff";
import { useToast } from "@/components/overlays/Toast";

/**
 * A room panel's data, the server's answer being the truth: loaded on mount, and again on `reload()` or when `key`
 * changes. A failed load toasts its reason and sets `failed`, so a panel with nothing to show yet offers a retry
 * instead of spinning for good.
 */
export function useRoomData<T>(path: string, key?: unknown) {
  const toast = useToast();
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);

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
        setFailed(true);
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
