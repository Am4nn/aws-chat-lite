// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bff } from "@/lib/client/bff";
import { ModelsProvider, useModelPick } from "@/lib/client/ModelsProvider";
import type { ModelOption, ModelPick, Role, RoomView, TaintSource } from "@/lib/types";
import { ModelPill } from "./ModelPill";

vi.mock("@/lib/client/bff", () => ({ bff: vi.fn(async () => ({})), errorText: String }));

const option = (pick: ModelOption["pick"], label: string, privateOk = true): ModelOption =>
  ({ pick, label, short: label, price: pick === "auto" ? "" : "$1 / $2", privateOk });
const models = [
  option("auto", "Auto"), option("sonnet", "Sonnet 5.5"), option("haiku", "Haiku 5.5"), option("opus", "Opus 5.5"),
  option("fable", "Fable 5.2"), option("deepseek-flash", "DeepSeek Flash", false), option("deepseek-pro", "DeepSeek Pro", false),
];
const view = (role: Role, defaultModel: ModelPick = "auto") => ({
  room: { roomId: "r1", name: "Room", ownerId: "u1", archived: false }, me: { role }, models, defaultModel,
}) as unknown as RoomView;

function pill(role: Role = "member", o: { value?: ModelPick; roomDefault?: ModelPick; taint?: TaintSource[] } = { value: "opus" }) {
  const onChange = vi.fn();
  render(
    <ModelsProvider view={view(role, o.roomDefault)}>
      <ModelPill value={o.value} onChange={onChange} taint={o.taint ?? ["attachment"]} />
    </ModelsProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Model: / }));
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

  it("says what made the thread private", () => {
    pill("member", { value: "opus", taint: ["attachment", "sandbox"] });
    expect(screen.getByRole("img", { name: "Private: has attachments and sandbox files, so DeepSeek is off." })).toBeTruthy();
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
    expect(screen.getByRole("menuitem", { name: "Make Opus 5.5 the room default" })).toBeTruthy();
  });

  it("reaches the room default with the arrows, and Enter makes it the default", async () => {
    const { menu } = pill("admin");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(focused()).toBe("Make Opus 5.5 the room default");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(focused()).toContain("Auto");
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(bff).toHaveBeenCalledWith("/bff/api/rooms/r1/model", { method: "PUT", body: { model: "opus" } });
    await closed();
  });

  it("shows Auto on a private thread when the room default is DeepSeek and the chat hasn't picked", () => {
    pill("member", { roomDefault: "deepseek-flash" });
    expect(screen.getByRole("button", { name: "Model: Auto" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /^Auto/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: /DeepSeek Flash/ }).textContent).toContain("default");
  });
});

describe("useModelPick", () => {
  it("has no pick of its own, so a send carries no model, until the chat picks one", () => {
    let current: ReturnType<typeof useModelPick> | undefined;
    function Probe() {
      current = useModelPick("c1");
      return null;
    }
    render(<ModelsProvider view={view("member", "deepseek-flash")}><Probe /></ModelsProvider>);
    expect(current![0]).toBeUndefined();
    act(() => current![1]("haiku"));
    expect(current![0]).toBe("haiku");
  });
});
