// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelsProvider } from "@/lib/client/ModelsProvider";
import type { ModelOption, Role, RoomView } from "@/lib/types";
import { ModelPill } from "./ModelPill";

const option = (pick: ModelOption["pick"], label: string, privateOk = true): ModelOption =>
  ({ pick, label, short: label, price: pick === "auto" ? "" : "$1 / $2", privateOk });
const models = [
  option("auto", "Auto"), option("sonnet", "Sonnet 5.5"), option("haiku", "Haiku 5.5"), option("opus", "Opus 5.5"),
  option("fable", "Fable 5.2"), option("deepseek-flash", "DeepSeek Flash", false), option("deepseek-pro", "DeepSeek Pro", false),
];
const view = (role: Role) => ({
  room: { roomId: "r1", name: "Room", ownerId: "u1", archived: false }, me: { role }, models, defaultModel: "auto",
}) as unknown as RoomView;

function pill(role: Role = "member") {
  const onChange = vi.fn();
  render(
    <ModelsProvider view={view(role)}>
      <ModelPill value="opus" onChange={onChange} taint={["attachment"]} />
    </ModelsProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Model: Opus 5.5/ }));
  return { onChange, menu: screen.getByRole("menu") };
}
const focused = () => document.activeElement?.textContent ?? "";
/** The menu leaves with a short fade. */
const closed = () => waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

// jsdom has no media queries; a desktop-width screen is enough here.
beforeAll(() => {
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe("ModelPill", () => {
  it("moves with the arrows past the DeepSeek rows a private thread can't use, and Enter picks and closes", async () => {
    const { onChange, menu } = pill();
    expect(focused()).toContain("Opus 5.5");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(focused()).toContain("Fable 5.2");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(focused()).toContain("Auto");
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("auto");
    await closed();
  });

  it("shows the DeepSeek rows as unavailable on a private thread", () => {
    pill();
    const flash = screen.getByRole("menuitemradio", { name: /DeepSeek Flash/ });
    expect(flash.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Private thread: DeepSeek is off")).toBeTruthy();
  });

  it("closes on Escape and gives focus back to the pill", async () => {
    const { menu } = pill();
    fireEvent.keyDown(menu, { key: "Escape" });
    await closed();
    expect(focused()).toContain("Opus 5.5");
    expect(document.activeElement?.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("offers the room default to admins only", () => {
    pill("member");
    expect(screen.queryByText(/the room default/)).toBeNull();
    cleanup();
    pill("admin");
    expect(screen.getByRole("button", { name: "Make Opus 5.5 the room default" })).toBeTruthy();
  });
});
