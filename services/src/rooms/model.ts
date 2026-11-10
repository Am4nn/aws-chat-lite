/** Bad input from the caller → HTTP 400. */
export class ValidationError extends Error {}

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
