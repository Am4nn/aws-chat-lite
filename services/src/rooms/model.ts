/** An expected refusal whose message is written for the user; anything else is a bug and stays hidden. */
export class UserError extends Error {}
/** Bad input from the caller → HTTP 400. */
export class ValidationError extends UserError {}
/** The caller's role doesn't allow this → 403. */
export class Forbidden extends UserError {}
/** No such room, or you're not in it (we never reveal which) → 404. */
export class NotFound extends UserError {}
/** The name or slot is taken, or the item changed under the request → 409. */
export class Conflict extends UserError {}
/** The invite link expired or was revoked, or the room is archived → 410. */
export class Gone extends UserError {}

/** Room display name: 1–40 characters after trimming, case kept. */
export function roomName(input: unknown): string {
  const name = typeof input === "string" ? input.trim() : "";
  if (name.length < 1 || name.length > 40) throw new ValidationError("Room name must be 1 to 40 characters.");
  return name;
}

/** Chat name: lowercase a-z, 0-9 and dashes, 1–32 characters (shown as #name). */
export function chatName(input: unknown): string {
  const name = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (!/^[a-z0-9-]{1,32}$/.test(name)) {
    throw new ValidationError("Chat names use a-z, 0-9 and dashes, 1 to 32 characters.");
  }
  return name;
}
