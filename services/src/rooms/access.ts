export type Role = "owner" | "admin" | "member";
export type Action =
  | "read" | "manageChats" | "manageInvite" | "removeMember" | "setRole" | "archive" | "setBudget" | "setModel" | "manageConnections" | "setSandbox"
  | "manageAgents" | "setTimeZone" | "leave";

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

/**
 * The room role matrix (the one place permissions are decided).
 * - everyone in the room can read it
 * - admins and the owner create, rename and archive chats and manage the invite link
 * - you can remove only someone of a lower role; the owner can't be removed
 * - only the owner changes roles (admin ↔ member); the owner's own role never changes
 * - only the owner archives the room or sets its monthly agent budget
 * - admins and the owner set the room's default model, its GitHub connection, its approval timeout and whether its
 *   sandbox reaches the internet
 * - admins and the owner change any of the room's agents and schedules, not only their own, copy agents into the
 *   room, and set its time zone
 * - the owner is the one member who can't leave the room
 */
export function can(action: Action, actor: Role, target?: Role): boolean {
  switch (action) {
    case "read":
      return true;
    case "manageChats":
    case "manageInvite":
    case "setModel":
    case "manageConnections":
    case "setSandbox":
    case "manageAgents":
    case "setTimeZone":
      return RANK[actor] >= RANK.admin;
    case "removeMember":
      return target !== undefined && target !== "owner" && RANK[actor] >= RANK.admin && RANK[actor] > RANK[target];
    case "setRole":
      return actor === "owner" && target !== undefined && target !== "owner";
    case "archive":
    case "setBudget":
      return actor === "owner";
    case "leave":
      return actor !== "owner";
  }
}
