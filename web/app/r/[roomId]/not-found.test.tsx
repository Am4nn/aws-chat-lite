import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import RoomNotFound from "./not-found";

vi.mock("next/navigation", () => ({ useParams: () => ({ roomId: "r1" }) }));

describe("room not-found", () => {
  it("says the chat or thread is gone and leads back into the room", () => {
    const out = renderToStaticMarkup(<RoomNotFound />);
    expect(out).toContain("This chat or thread doesn&#x27;t exist, or was removed.");
    expect(out).toMatch(/<a[^>]*href="\/r\/r1"[^>]*>Back to the room<\/a>/);
  });
});
