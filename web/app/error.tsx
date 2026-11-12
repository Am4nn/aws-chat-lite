"use client";

import { RouteError } from "@/components/shell/RouteError";
import { Brand } from "@/components/ui/Brand";

export default function AppError(props: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-ink px-4 py-10">
      <div className="flex w-full max-w-[380px] flex-col gap-6">
        <Brand />
        <RouteError {...props} />
      </div>
    </main>
  );
}
