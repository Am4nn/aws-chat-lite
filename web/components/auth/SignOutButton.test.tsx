// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signOut } from "@/lib/client/signOut";
import { SignOutButton } from "./SignOutButton";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/lib/client/signOut", () => ({ signOut: vi.fn(async () => {}) }));

afterEach(cleanup);

describe("SignOutButton", () => {
  it("signs out, then goes to the sign-in page", async () => {
    render(<SignOutButton />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(signOut).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Sign out" }).hasAttribute("disabled")).toBe(true);
  });
});
