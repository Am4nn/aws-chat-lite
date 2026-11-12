import type { ReactNode } from "react";
import { DictationEngineProvider } from "@/components/chat/DictationEngine";
import { LiveProvider } from "@/lib/client/LiveProvider";
import { serverEnv } from "@/lib/server/env";
import { NavPendingProvider } from "@/components/shell/NavPending";
import { NavProgress } from "@/components/shell/NavProgress";

/**
 * Above the room segment, so switching rooms (which remounts the room layout) keeps the tab's one socket, and a tap's
 * pending place and progress bar outlive the room it was made in.
 */
export default function RoomsLayout({ children }: { children: ReactNode }) {
  return (
    <DictationEngineProvider engine={serverEnv().dictation}>
      <LiveProvider>
        <NavPendingProvider>
          <NavProgress />
          {children}
        </NavPendingProvider>
      </LiveProvider>
    </DictationEngineProvider>
  );
}
