import { describe, it, expect } from "vitest";
import { newTicket } from "./tickets.js";

describe("newTicket", () => {
  it("is 128 random bits as 22 base64url characters, different every time", () => {
    const a = newTicket();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newTicket()).not.toBe(a);
  });
});
