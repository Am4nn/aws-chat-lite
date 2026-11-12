import { useEffect, useState } from "react";
import { errorText } from "@/lib/client/bff";
import { disablePush, enablePush, pushState, syncPush, type PushState } from "@/lib/client/push";
import { useToast } from "@/components/overlays/Toast";

/**
 * This device's notifications. Opening the app saves its subscription again, healing one the server dropped. The
 * switch moves at once, then settles on what the browser and server really have.
 */
export function usePush(): { state: PushState; toggle: () => void } {
  const toast = useToast();
  const [state, setState] = useState<PushState>("hidden");

  useEffect(() => {
    syncPush().catch(() => {});
    pushState().then(setState, () => {});
  }, []);

  async function toggle() {
    const turnOn = state === "off";
    setState(turnOn ? "on" : "off");
    try {
      await (turnOn ? enablePush() : disablePush());
    } catch (e) {
      setState(state);
      toast(errorText(e, "Notifications couldn't be changed. Try again."), "error");
    }
    pushState().then(setState, () => {});
  }

  return { state, toggle };
}
