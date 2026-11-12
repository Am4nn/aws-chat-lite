import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Me } from "@/lib/types";

const me = vi.hoisted(() => ({ current: {} as Partial<Me> }));
vi.mock("@/lib/server/api", () => ({
  serverApi: async (path: string) => (path === "/me" ? me.current : { rooms: [] }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({}) }));

const { default: Home } = await import("./page");
const html = async (who: Partial<Me>) => {
  me.current = who;
  return renderToStaticMarkup(await Home({ searchParams: Promise.resolve({}) }));
};

describe("Home with no rooms", () => {
  it("lets someone waiting for an invite sign out", async () => {
    const page = await html({ username: "aman", isCreator: false });
    expect(page).toContain("Ask someone for an invite link");
    expect(page).toMatch(/<button[^>]*>.*Sign out<\/button>/);
  });
  it("lets a creator sign out beside the create form", async () => {
    const page = await html({ username: "aman", isCreator: true });
    expect(page).toContain("Create room");
    expect(page).toMatch(/<button[^>]*>.*Sign out<\/button>/);
  });
});
