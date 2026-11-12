import type { NextRequest } from "next/server";
import { finishFlow, githubTarget } from "@/lib/server/flow-return";

/** Where GitHub's sign-in returns the browser. */
export const GET = (req: NextRequest) => finishFlow(req, "/github-flows/finish", githubTarget);
