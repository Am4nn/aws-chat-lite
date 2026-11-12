import Link from "next/link";
import { Users } from "lucide-react";
import { callApi, idToken } from "@/lib/server/api";
import { expiresIn } from "@/components/rooms/invite";
import { buttonClass } from "@/components/ui/Button";
import { JoinButton } from "./JoinButton";

type Preview = { roomName: string; memberCount: number; expiresAt: number };

/** Public: anyone with the link sees which room it leads to before signing in. */
export default async function InvitePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const res = await callApi(`/invites/${encodeURIComponent(code)}`, undefined);
  const body = await res.json().catch(() => ({}));
  const signedIn = !!(await idToken());

  return (
    <main className="grid min-h-dvh place-items-center bg-ink px-4">
      <div className="w-full max-w-[380px] rounded-2xl border border-line-strong bg-surface-2 p-6">
        {res.ok ? <Valid preview={body as Preview} code={code} signedIn={signedIn} /> : <Invalid message={body.error ?? "This invite link doesn't work."} />}
      </div>
    </main>
  );
}

function Valid({ preview, code, signedIn }: { preview: Preview; code: string; signedIn: boolean }) {
  return (
    <>
      <p className="text-xs font-medium text-text-3">You&apos;re invited to</p>
      <h1 className="mt-1 font-display text-2xl font-bold">{preview.roomName}</h1>
      <p className="mt-2 flex items-center gap-1.5 text-[13px] text-text-2">
        <Users aria-hidden="true" size={14} /> {preview.memberCount} {preview.memberCount === 1 ? "member" : "members"}
        <span className="text-text-3">· link expires in {expiresIn(preview.expiresAt, Math.floor(Date.now() / 1000))}</span>
      </p>
      <div className="mt-6">
        {signedIn ? (
          <JoinButton code={code} />
        ) : (
          <Link
            href={`/login?next=${encodeURIComponent(`/invite/${code}`)}`}
            className={`${buttonClass({ variant: "primary", size: "lg" })} w-full`}
          >
            Sign in to join
          </Link>
        )}
      </div>
    </>
  );
}

function Invalid({ message }: { message: string }) {
  return (
    <>
      <h1 className="font-display text-xl font-bold">Can&apos;t join with this link</h1>
      <p className="mt-2 text-sm text-text-2">{message} Ask the room for a new one.</p>
      <Link href="/" className="mt-5 inline-block text-[13px] text-lime transition-opacity hover:underline active:opacity-70">Go to your rooms</Link>
    </>
  );
}
