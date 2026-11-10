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
