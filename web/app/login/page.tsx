import { LoginForm } from "@/components/auth/LoginForm";
import { serverEnv } from "@/lib/server/env";
import { safeNext } from "@/lib/server/next-path";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  return (
    <main className="grid min-h-dvh place-items-center bg-ink px-4">
      <LoginForm next={next} emailSignup={serverEnv().emailSignup} />
    </main>
  );
}
