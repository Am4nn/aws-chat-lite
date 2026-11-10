import type { ReactNode } from "react";
import { LiveProvider } from "@/lib/client/LiveProvider";

/** Above the room segment, so switching rooms (which remounts the room layout) keeps the tab's one socket. */
export default function RoomsLayout({ children }: { children: ReactNode }) {
  return <LiveProvider>{children}</LiveProvider>;
}
