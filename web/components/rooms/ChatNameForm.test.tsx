// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bff } from "@/lib/client/bff";
import { ChatNameForm } from "./ChatNameForm";

const toasts = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/client/bff", () => ({ bff: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/overlays/Toast", () => ({ useToast: () => toasts }));
const mockedBff = vi.mocked(bff);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const type = (value: string) => fireEvent.change(screen.getByLabelText("Name"), { target: { value } });

describe("ChatNameForm", () => {
  it("renames a chat in place, starting from its name, and stays on it", async () => {
    mockedBff.mockResolvedValueOnce({ chatId: "c2", name: "off-topic" });
    const onDone = vi.fn();
    render(<ChatNameForm roomId="r1" chat={{ chatId: "c2", name: "random" }} onDone={onDone} />);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("random");
    type("Off Topic");
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(mockedBff).toHaveBeenCalledWith("/bff/api/rooms/r1/chats/c2", { method: "PATCH", body: { name: "off-topic" } });
    expect(toasts).toHaveBeenCalledWith("Renamed to #off-topic");
    expect(router.refresh).toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("creates a chat and opens it", async () => {
    mockedBff.mockResolvedValueOnce({ chatId: "c9", name: "deploys" });
    render(<ChatNameForm roomId="r1" onDone={() => {}} />);
    type("deploys");
    fireEvent.click(screen.getByRole("button", { name: "Create chat" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/r/r1/c/c9"));
    expect(mockedBff).toHaveBeenCalledWith("/bff/api/rooms/r1/chats", { body: { name: "deploys" } });
  });

  it("shows the server's refusal in the form", async () => {
    mockedBff.mockRejectedValueOnce(new Error("#general already exists."));
    render(<ChatNameForm roomId="r1" chat={{ chatId: "c2", name: "random" }} onDone={() => {}} />);
    type("general");
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect((await screen.findByRole("alert")).textContent).toBe("#general already exists.");
  });
});
