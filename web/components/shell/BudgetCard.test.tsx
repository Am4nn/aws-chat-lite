// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Budget } from "@/lib/types";
import { BudgetCard } from "./BudgetCard";

const budget: Budget = { spentMicros: 0, capMicros: 3_000_000, capRev: 1, month: "2026-11", resetsAt: "2026-12-01T00:00:00Z" };
const mocks = vi.hoisted(() => ({ bff: vi.fn(), setBudget: vi.fn() }));
vi.mock("@/lib/client/bff", () => ({ bff: mocks.bff, errorText: String }));
vi.mock("@/lib/client/ThreadsProvider", () => ({ useThreads: () => ({ budget, setBudget: mocks.setBudget }) }));
vi.mock("@/components/overlays/Toast", () => ({ useToast: () => vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function editCap(to: string) {
  render(<BudgetCard roomId="r1" isOwner />);
  fireEvent.click(screen.getByRole("button", { name: "Change the monthly cap" }));
  const input = screen.getByRole("textbox", { name: "Monthly cap in dollars, up to $20" });
  fireEvent.change(input, { target: { value: to } });
  return input;
}

describe("BudgetCard", () => {
  it("saves the new cap when the field loses focus, as a phone keyboard's Done does", async () => {
    mocks.bff.mockResolvedValue({ budget: { ...budget, capMicros: 5_000_000 } });
    fireEvent.blur(editCap("5"));
    await waitFor(() => expect(mocks.bff).toHaveBeenCalledWith("/bff/api/rooms/r1/budget", { method: "PUT", body: { capUsd: 5 } }));
    await waitFor(() => expect(mocks.setBudget).toHaveBeenCalledWith({ ...budget, capMicros: 5_000_000 }));
  });

  it("saves on Enter", async () => {
    mocks.bff.mockResolvedValue({ budget });
    fireEvent.keyDown(editCap("7.5"), { key: "Enter" });
    await waitFor(() => expect(mocks.bff).toHaveBeenCalledWith("/bff/api/rooms/r1/budget", { method: "PUT", body: { capUsd: 7.5 } }));
  });

  it("closes the field when the server refuses the cap, so it never strands open; the toast says why", async () => {
    mocks.bff.mockRejectedValue(new Error("Pick a cap up to $20."));
    fireEvent.blur(editCap("25"));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(screen.getByRole("button", { name: "Change the monthly cap" })).toBeTruthy();
  });

  it("leaves the cap alone on Escape, or when it didn't change", () => {
    const input = editCap("9");
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(screen.queryByRole("textbox")).toBeNull();
    cleanup();
    fireEvent.blur(editCap("3.00"));
    expect(mocks.bff).not.toHaveBeenCalled();
  });
});
