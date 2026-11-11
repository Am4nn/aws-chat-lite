import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApprovalItem } from "@/lib/client/run";
import { ApprovalCard } from "./ApprovalCard";

const approval: ApprovalItem = {
  kind: "approval", step: 2, title: "Comment on #4 in a/b?", status: "pending",
  call: { id: "c", name: "github_comment", input: { number: 4, body: "Ship <it>" } },
  expiresAt: new Date(Date.now() + 7_200_000 + 30_000).toISOString(),
};
const html = (a: ApprovalItem) => renderToStaticMarkup(<ApprovalCard runId="run1" approval={a} meName="aman" enter={false} />);

describe("ApprovalCard", () => {
  it("asks with the tool's title, says who may approve and when it expires, and offers Deny and Approve", () => {
    const out = html(approval);
    expect(out).toContain("Comment on #4 in a/b?");
    expect(out).toContain("write action · anyone in the room can approve · expires in 2 h");
    expect(out).toMatch(/>Deny</);
    expect(out).toMatch(/>Approve</);
  });

  it("calls a gated web call what it is, not a write", () => {
    const fetch = { ...approval, title: "Fetch https://e.example/?", call: { id: "c", name: "web_fetch", input: { url: "https://e.example/" } } };
    expect(html(fetch)).toContain("web call from a private thread · anyone in the room can approve");
  });

  it("shows exactly what will run under Details, as JSON", () => {
    const out = html(approval);
    expect(out).toContain("Details");
    expect(out).toContain("&quot;body&quot;: &quot;Ship &lt;it&gt;&quot;");
  });

  it("once settled, is one line saying how, with no buttons", () => {
    const approved = html({ ...approval, status: "approved", by: "bea" });
    expect(approved).toContain("Approved by bea");
    expect(approved).not.toMatch(/>Approve</);
    expect(html({ ...approval, status: "approved", by: "aman" })).toContain("Approved by you");
    expect(html({ ...approval, status: "expired" })).toContain("Skipped: no one approved in time");
    expect(html({ ...approval, status: "cancelled", by: "bea" })).toContain("Cancelled: the run was stopped");
  });
});
