/**
 * An expected refusal whose message is written for the user. Its message must be ours: text from another system
 * (an AWS SDK error, a remote server's answer) is logged and replaced by DEFAULT_ERROR or a line of our own.
 */
export class UserError extends Error {}
/** What the user is told about any failure that isn't a UserError. */
export const DEFAULT_ERROR = "Something went wrong.";
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
/** A server chat-lite talks to on the caller's behalf failed or refused → 502. */
export class Upstream extends UserError {}
/** The table is throttling us; trying again shortly will likely work → 503. */
export class Unavailable extends UserError {}

/**
 * A sign-in that failed after its flow was found. The browser is on its way back from the other site, so the answer
 * names the room it should land in, with the error.
 */
export class FlowFailed extends Error {
  constructor(readonly roomId: string, readonly error: unknown) {
    super("The connection attempt failed.");
  }
}
