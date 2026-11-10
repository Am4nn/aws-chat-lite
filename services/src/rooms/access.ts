export type Role = "owner" | "admin" | "member";
export type Action = "read" | "createChat" | "manageInvite" | "removeMember" | "setRole" | "archive" | "setBudget" | "leave";

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

/**
 * The room role matrix (the one place permissions are decided).
 * - everyone in the room can read it
 * - admins and the owner create chats and manage the invite link
 * - you can remove only someone of a lower role; the owner can't be removed
 * - only the owner changes roles (admin ↔ member); the owner's own role never changes
 * - only the owner archives the room or sets its monthly agent budget
 * - the owner is the one member who can't leave the room
 */
export function can(action: Action, actor: Role, target?: Role): boolean {
  switch (action) {
    case "read":
      return true;
    case "createChat":
    case "manageInvite":
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
