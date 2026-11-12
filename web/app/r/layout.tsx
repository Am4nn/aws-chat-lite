import type { ReactNode } from "react";
import { DictationEngineProvider } from "@/components/chat/DictationEngine";
import { LiveProvider } from "@/lib/client/LiveProvider";
import { serverEnv } from "@/lib/server/env";

/** Above the room segment, so switching rooms (which remounts the room layout) keeps the tab's one socket. */
export default function RoomsLayout({ children }: { children: ReactNode }) {
  return (
    <DictationEngineProvider engine={serverEnv().dictation}>
      <LiveProvider>{children}</LiveProvider>
    </DictationEngineProvider>
  );
}
