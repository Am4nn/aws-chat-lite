# Task 2 report: room approval mode and post cap

Implemented: `ApprovalMode` (services + web), `AuditKind += mode | cap` (services + web, with ActivityLog ICONS rows and an `auditLine` case per pre-flight F1), `DEFAULT_POST_CAP`/`approvalModeOf`/`postCapOf`, `connectionsRepo().get` now returns `approvalMode`, `postCap`, `sandboxInternet` from the same META read, `setApprovalMode`/`setPostCap` (requireManager + withAudit), PUT `/rooms/{roomId}/approval-mode` and `/post-cap` (handler, CDK routes, BFF allowlist), GET connections adds both, `RoomView.approvalMode` (services + web).

## TDD
RED: model.test, handler.test (404 on new routes), infra connections.test, web forward.test all failed before implementation.
GREEN: services connections/approvals tests 34/34; infra 25 files 170 tests; web 110 files 768 tests; `npm run check` (knip, eslint, tsc) clean. Int tests written in connections/repo.int.test.ts, not run (batched).

## Files
services: approvals/model(.test), connections/{repo,handler,handler.test,repo.int.test}, rooms/repo, threads/types; infra: lib/connections(.test); web: lib/types, lib/server/forward(.test), lib/client/audit(.test), components/rooms/ActivityLog.

## Notes
Handler test split into two tests because `vi.spyOn(docClient(), "send")` accumulates calls across `call()`s in one test. Existing GET connections test expectation extended with the two new fields.

## Controller verification
services full run on ee6879f: 126 files, 1359/1359 passed.
