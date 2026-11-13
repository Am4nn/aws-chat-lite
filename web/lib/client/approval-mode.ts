import type { ApprovalMode } from "@/lib/types";

export const APPROVAL_MODES: { mode: ApprovalMode; label: string; title: string }[] = [
  { mode: "ask", label: "Ask", title: "Ask: agent writes wait for a member's approval." },
  { mode: "auto", label: "Auto", title: "Auto: agents post and set up agents without asking." },
  { mode: "bypass", label: "Bypass", title: "Bypass: agent tools run without asking, except deletes and calls that would carry room chat out." },
];
