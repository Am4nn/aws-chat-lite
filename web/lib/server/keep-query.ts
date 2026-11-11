/**
 * A redirect target that keeps the query of the page redirecting, so a message riding on it (such as the result of
 * connecting an MCP server) survives a page that only forwards somewhere else.
 */
export function keepQuery(path: string, params: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) for (const v of [value ?? []].flat()) query.append(key, v);
  return query.size ? `${path}?${query}` : path;
}
