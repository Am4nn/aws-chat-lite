import { bff } from "./bff";
import { disablePush } from "./push";

/**
 * Push is turned off for this browser first, while the session can still delete the device on the server, so the
 * next person to sign in here doesn't get this account's notifications. A failure there doesn't keep anyone signed in.
 */
export async function signOut(): Promise<void> {
  await disablePush().catch(() => {});
  await bff("/bff/auth/signout", { body: {} });
}
