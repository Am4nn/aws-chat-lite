import type { McpApp, Scope } from "../types";
import { timeAgo } from "./format";

const SCOPE_LINES: [Scope, string][] = [
  ["rooms:read", "Read your rooms, chats and threads"],
  ["rooms:write", "Post messages and start agent threads as you"],
];

/** What an app may do, in the consent page's words, reading first. */
export const scopeLines = (scopes: Scope[]) => SCOPE_LINES.filter(([scope]) => scopes.includes(scope)).map(([, line]) => line);

export const appLine = (app: McpApp, nowMs: number) =>
  [
    app.clientName,
    app.scopes.includes("rooms:write") ? "read and post" : "read only",
    `added ${timeAgo(app.createdAt, nowMs)}`,
    `last used ${timeAgo(app.lastUsedAt, nowMs)}`,
  ].join(" · ");
