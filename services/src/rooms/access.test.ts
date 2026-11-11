import { describe, it, expect } from "vitest";
import { can, type Action, type Role } from "./access.js";

// [action, actor, target, allowed]
const MATRIX: [Action, Role, Role | undefined, boolean][] = [
  ["read", "owner", undefined, true], ["read", "admin", undefined, true], ["read", "member", undefined, true],
  ["createChat", "owner", undefined, true], ["createChat", "admin", undefined, true], ["createChat", "member", undefined, false],
  ["manageInvite", "owner", undefined, true], ["manageInvite", "admin", undefined, true], ["manageInvite", "member", undefined, false],
  ["removeMember", "owner", "admin", true], ["removeMember", "owner", "member", true], ["removeMember", "owner", "owner", false],
  ["removeMember", "admin", "member", true], ["removeMember", "admin", "admin", false], ["removeMember", "admin", "owner", false],
  ["removeMember", "member", "member", false],
  ["setRole", "owner", "member", true], ["setRole", "owner", "admin", true], ["setRole", "owner", "owner", false],
  ["setRole", "admin", "member", false], ["setRole", "admin", "admin", false], ["setRole", "member", "member", false],
  ["archive", "owner", undefined, true], ["archive", "admin", undefined, false], ["archive", "member", undefined, false],
  ["setBudget", "owner", undefined, true], ["setBudget", "admin", undefined, false], ["setBudget", "member", undefined, false],
  ["setModel", "owner", undefined, true], ["setModel", "admin", undefined, true], ["setModel", "member", undefined, false],
  ["setSandbox", "owner", undefined, true], ["setSandbox", "admin", undefined, true], ["setSandbox", "member", undefined, false],
  ["leave", "owner", undefined, false], ["leave", "admin", undefined, true], ["leave", "member", undefined, true],
];

describe("can (the room role matrix)", () => {
  for (const [action, actor, target, allowed] of MATRIX) {
    it(`${actor} ${allowed ? "may" : "may not"} ${action}${target ? ` on ${target}` : ""}`, () => {
      expect(can(action, actor, target)).toBe(allowed);
    });
  }
});
