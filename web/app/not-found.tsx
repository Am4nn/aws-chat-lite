import Link from "next/link";
import { Brand } from "@/components/ui/Brand";
import { buttonClass } from "@/components/ui/Button";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-ink px-4 py-10">
      <div className="flex w-full max-w-[380px] flex-col gap-6">
        <Brand />
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-xl font-bold">No such page.</h1>
          <p className="text-[13.5px] text-text-2">The link may be old, or it was removed.</p>
        </div>
        {/* "/" sends a signed-in visitor on to their first room and anyone else to sign in; a prefetch would be wasted. */}
        <Link href="/" prefetch={false} className={`${buttonClass({ variant: "primary", size: "lg" })} self-start`}>Go to your rooms</Link>
      </div>
    </main>
  );
}
