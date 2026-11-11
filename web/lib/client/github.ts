/**
 * Where the GitHub sign-in's return route sends the browser once the API has finished (or refused) it: back to the
 * room to pick repos, or with the error for its toast; home when the API couldn't tell which room it was for.
 */
export function githubCallbackTarget({ status, body }: { status: number; body: { roomId?: string; error?: string } }): string {
  const room = body.roomId ? `/r/${body.roomId}` : "/";
  const query = new URLSearchParams(status < 300 ? [["github", "pick"]] : [["githubError", body.error ?? "Something went wrong."]]);
  return `${room}?${query}`;
}
