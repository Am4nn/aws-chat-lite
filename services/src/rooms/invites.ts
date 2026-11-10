import { randomBytes } from "node:crypto";

/** An invite link works for 7 days (the room can rotate or revoke it sooner). */
export const INVITE_TTL_SEC = 7 * 24 * 3600;

/** 128 random bits as 22 base64url characters: unguessable, safe in a URL. */
export function newInviteCode(): string {
  return randomBytes(16).toString("base64url");
}

export type InviteState = "ok" | "expired" | "revoked" | "missing";

/** Checked on every accept (TTL deletion is lazy, so an expired item may still exist). */
export function inviteState(inv: { expiresAt: number; revoked?: boolean } | undefined, nowSec: number): InviteState {
  if (!inv) return "missing";
  if (inv.revoked) return "revoked";
  return nowSec >= inv.expiresAt ? "expired" : "ok";
}
