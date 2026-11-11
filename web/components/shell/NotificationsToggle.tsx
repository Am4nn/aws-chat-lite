import { Bell, BellOff } from "lucide-react";
import type { PushState } from "@/lib/client/push";
import { Hint } from "@/components/ui/Hint";
import { Switch } from "@/components/ui/Switch";

const NOTE: Record<"install" | "blocked" | "unsupported", { text: string; hint?: string }> = {
  install: { text: "On iPhone, add chat-lite to your Home Screen first", hint: "Share ▸ Add to Home Screen, then open it from there." },
  blocked: { text: "Notifications are blocked for this site", hint: "Allow them in your browser's site settings." },
  unsupported: { text: "This browser can't show notifications" },
};

/** This device's notifications, as a row of the room menu. Shows nothing where the server can't send any. */
export function NotificationsToggle({ state, onToggle }: { state: PushState; onToggle: () => void }) {
  if (state === "hidden") return null;
  const row = "relative flex min-h-9 items-center gap-2.5 px-2.5";

  if (state === "on" || state === "off") {
    return (
      <div className={`${row} text-[13.5px] text-text-2`}>
        <Bell aria-hidden="true" size={14} className="shrink-0" />
        {`Notifications: ${state}`}
        <Switch on={state === "on"} label={state === "on" ? "Turn off" : "Turn on"} onToggle={onToggle} className="ml-auto" />
      </div>
    );
  }

  const { text, hint } = NOTE[state];
  return (
    <div className={`${row} py-1.5 text-[12.5px] leading-snug text-text-3`}>
      <BellOff aria-hidden="true" size={14} className="shrink-0" />
      <span>{text}</span>
      {hint && <Hint text={hint} below />}
    </div>
  );
}
