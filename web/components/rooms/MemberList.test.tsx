// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bff } from "@/lib/client/bff";
import type { Member } from "@/lib/types";
import { MemberList } from "./MemberList";

const refresh = vi.hoisted(() => vi.fn());
const toasts = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/client/bff", () => ({ bff: vi.fn(), errorText: String }));
vi.mock("@/components/overlays/Toast", () => ({ useToast: () => toasts }));

const member = (userId: string, role: Member["role"]): Member => ({ userId, username: userId, role, online: true });
const MEMBERS = [member("aman", "owner"), member("bea", "member"), member("cal", "member")];
const mockedBff = vi.mocked(bff);

afterEach(() => {
  cleanup();
  mockedBff.mockReset();
  refresh.mockReset();
  toasts.mockReset();
});

const show = (members = MEMBERS) => render(<MemberList roomId="r1" members={members} myRole="owner" myUserId="aman" />);
const act = (name: string, item: string) => {
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${name}` }));
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
};
/** Each row as its name plus its role badge, if any (members have none). */
const names = () => screen.getAllByRole("listitem").map((li) => {
  const name = MEMBERS.find((m) => li.textContent?.includes(m.username))!.username;
  const badge = within(li).queryByText(/^(owner|admin)$/)?.textContent;
  return [name, badge].filter(Boolean).join(" ");
});

describe("MemberList", () => {
  it("shows a new role on the tap, before the server answers", () => {
    mockedBff.mockReturnValueOnce(new Promise(() => {}));
    show();
    act("bea", "Make admin");
    expect(names()).toEqual(["aman owner", "bea admin", "cal"]);
  });

  it("puts the old role back and shows the server's reason when it refuses", async () => {
    mockedBff.mockRejectedValueOnce("Not a member of this room.");
    show();
    act("bea", "Make admin");
    await vi.waitFor(() => expect(toasts).toHaveBeenCalledWith("Not a member of this room.", "error"));
    await vi.waitFor(() => expect(names()).toEqual(["aman owner", "bea", "cal"]));
    expect(refresh).toHaveBeenCalled();
  });

  it("takes a removed member away on the tap, and back when the server refuses", async () => {
    let refuse!: (e: unknown) => void;
    mockedBff.mockReturnValueOnce(new Promise((_, reject) => { refuse = reject; }));
    show();
    act("cal", "Remove from room");
    await vi.waitFor(() => expect(names()).toEqual(["aman owner", "bea"]));
    refuse("Not a member of this room.");
    await vi.waitFor(() => expect(names()).toEqual(["aman owner", "bea", "cal"]));
  });

  it("follows the server's list once it changes, rather than holding the tapped role", async () => {
    mockedBff.mockResolvedValueOnce({});
    const { rerender } = show();
    act("bea", "Make admin");
    await vi.waitFor(() => expect(toasts).toHaveBeenCalledWith("bea is now an admin"));
    rerender(<MemberList roomId="r1" members={[member("aman", "owner"), member("bea", "admin"), member("cal", "member")]} myRole="owner" myUserId="aman" />);
    rerender(<MemberList roomId="r1" members={MEMBERS} myRole="owner" myUserId="aman" />);
    await vi.waitFor(() => expect(names()).toEqual(["aman owner", "bea", "cal"]));
  });
});
