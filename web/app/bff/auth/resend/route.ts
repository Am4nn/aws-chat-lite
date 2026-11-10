import { NextResponse } from "next/server";
import { authErrorMessage, resendCode } from "@/lib/server/cognito";
import { jsonError, readJson, str } from "@/lib/server/respond";

export async function POST(req: Request) {
  const username = str((await readJson(req)).username);
  if (!username) return jsonError(400, "Username is required.");
  try {
    return NextResponse.json({ sentTo: (await resendCode(username)) ?? "" });
  } catch (e) {
    return jsonError(400, authErrorMessage(e));
  }
}
