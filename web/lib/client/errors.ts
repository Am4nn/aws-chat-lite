export const DEFAULT_ERROR = "Something went wrong.";

/** An error whose message we wrote, so the user may see it. Any other error's text is the browser's or a library's. */
export class UserError extends Error {}
