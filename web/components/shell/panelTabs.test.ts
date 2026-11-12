import { describe, expect, it } from "vitest";
import { PANEL_TABS, panelTabIds } from "./panelTabs";

const labels = (ids: ReturnType<typeof panelTabIds>) => ids.map((id) => PANEL_TABS[id].label);

describe("panelTabIds", () => {
  it("gives a chat four tabs, with Agents, Room and People grouping what used to be eight", () =>
    expect(labels(panelTabIds({ thread: false, step: false }))).toEqual(["Agents", "Room", "People", "Search"]));

  it("adds Context only on a thread", () =>
    expect(labels(panelTabIds({ thread: true, step: false }))).toEqual(["Context", "Agents", "Room", "People", "Search"]));

  it("leads with the step picked on a thread's Map", () =>
    expect(labels(panelTabIds({ thread: true, step: true }))[0]).toBe("Step"));
});
