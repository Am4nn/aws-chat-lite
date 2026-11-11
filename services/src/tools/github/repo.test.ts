import { describe, expect, it } from "vitest";
import type { GitHubConnection } from "../../threads/types.js";
import { repoOf } from "./repo.js";

const conn = (repos: string[]): GitHubConnection => ({ installationId: 1, account: "fake-org", repos, addedBy: "u1", addedAt: "2026-11-11T00:00:00Z" });

describe("repoOf", () => {
  it("refuses when the room has no GitHub connection", () => {
    expect(repoOf({ repo: "fake-org/playground" })).toEqual({
      error: "GitHub isn't connected to this room. An admin can connect it in the room panel.",
    });
  });

  it("defaults to the only connected repo, and asks which one when there are several", () => {
    expect(repoOf({}, conn(["fake-org/playground"]))).toBe("fake-org/playground");
    expect(repoOf({}, conn(["fake-org/a", "fake-org/b"]))).toEqual({ error: "Say which repo: fake-org/a, fake-org/b." });
  });

  it("takes a connected repo in any case, in the connection's spelling", () => {
    expect(repoOf({ repo: "Fake-Org/Playground" }, conn(["fake-org/playground"]))).toBe("fake-org/playground");
  });

  it("refuses a repo outside the connection", () => {
    expect(repoOf({ repo: "other/x" }, conn(["fake-org/a", "fake-org/b"]))).toEqual({
      error: "other/x isn't connected to this room. Connected: fake-org/a, fake-org/b.",
    });
  });
});
