import type { NextRequest } from "next/server";
import { finishFlow, mcpTarget } from "@/lib/server/flow-return";

/** Where a remote MCP server's sign-in returns the browser. */
export const GET = (req: NextRequest) => finishFlow(req, "/mcp-flows/finish", mcpTarget);
