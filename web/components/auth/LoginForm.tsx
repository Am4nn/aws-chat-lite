"use client";

import { useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { bff } from "@/lib/client/bff";
import { dur, easeOut, spring } from "@/lib/motion";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";

type Mode = "signin" | "signup" | "confirm";

export function LoginForm({ next, emailSignup }: { next: string; emailSignup: boolean }) {
  const [mode, setMode] = useState<Mode>("signin");
  const [form, setForm] = useState({ username: "", password: "", email: "", code: "" });
  const [sentTo, setSentTo] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "signup") {
        const r = await bff<{ confirmed: boolean; sentTo?: string }>("/bff/auth/signup", { body: form });
        if (!r.confirmed) {
          setSentTo(r.sentTo ?? "your email");
          setMode("confirm");
          return;
        }
      } else {
        await bff(mode === "confirm" ? "/bff/auth/confirm" : "/bff/auth/signin", { body: form });
      }
      // A full page load after sign-in: the session cookies just changed, so every server component and cache starts fresh.
      window.location.assign(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-[380px]">
      <div className="mb-8 flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-[10px] bg-lime font-display text-lg font-bold text-lime-ink">c</span>
        <span className="font-display text-xl font-bold">chat-lite</span>
      </div>

      {mode !== "confirm" && (
        <div role="tablist" className="relative mb-6 flex rounded-xl border border-line bg-surface-2 p-[3px]">
          {(["signin", "signup"] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => { setMode(m); setError(""); }}
              className={`relative z-10 h-9 flex-1 rounded-lg text-[13px] font-medium transition-colors ${mode === m ? "text-text" : "text-text-2 hover:text-text"}`}
            >
              {mode === m && <motion.span layoutId="auth-tab" transition={spring.glide} className="absolute inset-0 -z-10 rounded-lg bg-surface-3" />}
              {m === "signin" ? "Sign in" : "Create account"}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={submit} className="flex flex-col gap-4">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={mode}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: dur.fast, ease: easeOut }}
            className="flex flex-col gap-4"
          >
            {mode === "confirm" ? (
              <>
                <p className="text-sm text-text-2">We sent a code to <span className="text-text">{sentTo}</span>.</p>
                <Field id="code" label="Confirmation code" inputMode="numeric" autoComplete="one-time-code" value={form.code} onChange={set("code")} required autoFocus />
              </>
            ) : (
              <>
                <Field id="username" label="Username" autoComplete="username" value={form.username} onChange={set("username")} required autoFocus />
                {mode === "signup" && emailSignup && (
                  <Field id="email" label="Email" type="email" autoComplete="email" value={form.email} onChange={set("email")} required />
                )}
                <Field
                  id="password" label="Password" type="password" minLength={8}
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  value={form.password} onChange={set("password")} required
                />
              </>
            )}
          </motion.div>
        </AnimatePresence>

        <AnimatePresence>
          {error && (
            <motion.p
              role="alert"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: dur.base, ease: easeOut }}
              className="overflow-hidden text-[13px] text-[#ff9b8f]"
            >
              {error}
            </motion.p>
          )}
        </AnimatePresence>

        <Button type="submit" variant="primary" disabled={busy} className="mt-1 h-11">
          {busy && <Spinner />}
          {mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Confirm and sign in"}
        </Button>
      </form>
    </div>
  );
}
