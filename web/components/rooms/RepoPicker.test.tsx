import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RepoPicker } from "./RepoPicker";

const repos = Array.from({ length: 21 }, (_, i) => `o/r${i + 1}`);
const html = (picked: string[]) => renderToStaticMarkup(
  <RepoPicker installations={[{ id: 1, account: "o", repos }]} initial={{ installationId: 1, repos: picked }} busy={false} onCancel={() => {}} onSave={() => {}} />,
);

describe("RepoPicker", () => {
  it("says the limit and holds Save back once more than 20 repos are ticked", () => {
    const over = html(repos);
    expect(over).toContain("Pick up to 20 repos.");
    expect(over).toMatch(/<button[^>]*disabled=""[^>]*><span[^>]*>Save<\/span><\/button>/);
  });
  it("saves 20 or fewer", () => {
    const ok = html(repos.slice(0, 20));
    expect(ok).not.toContain("Pick up to 20 repos.");
    expect(ok).not.toMatch(/<button[^>]*disabled=""[^>]*><span[^>]*>Save<\/span><\/button>/);
  });
});
