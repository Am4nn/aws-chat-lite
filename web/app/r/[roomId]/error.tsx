"use client";

import { RouteError } from "@/components/shell/RouteError";

/** Inside the room's shell, so the sidebar stays usable while this page can't load. */
export default function RoomPageError(props: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <RouteError {...props} />
    </div>
  );
}
