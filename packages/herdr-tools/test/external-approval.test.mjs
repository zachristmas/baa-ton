import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeExternalApproval, issueExternalApproval, parseApprovedGhOperation } from "../external-approval.mjs";

const binding = { repo: "/repo", head: "abc", branch: "topic", target: "main", paneId: "w:p1", sessionId: "/session" };
const command = "gh pr create --base main";

test("external operation approval is explicit, exact, bound, expiring and one-use", () => {
  assert.equal(parseApprovedGhOperation("gh pr create --base main" ).operation, "create");
  assert.equal(issueExternalApproval("gh pr create --base main; echo unsafe", binding), undefined);
  assert.equal(issueExternalApproval("git push", binding), undefined);
  assert.equal(consumeExternalApproval(undefined, command, binding), false, "no approval token blocks");
  // The guard calls issue only after the native user confirmation returns true.
  const token = issueExternalApproval(command, binding, { now: 100, ttlMs: 10 });
  assert.ok(token);
  assert.equal(consumeExternalApproval(token, command, binding, { now: 105 }), true);
  assert.equal(consumeExternalApproval(token, command, binding, { now: 105 }), false, "replay denied");
});

test("command, repository, refs, root identity and expiry mismatches fail closed", () => {
  const make = () => issueExternalApproval(command, binding, { now: 100, ttlMs: 10 });
  for (const [cmd, ctx, now] of [
    ["gh pr create --base release", binding, 101],
    [command, { ...binding, repo: "/other" }, 101],
    [command, { ...binding, head: "new-head" }, 101],
    [command, { ...binding, target: "release" }, 101],
    [command, { ...binding, paneId: "w:p2" }, 101],
    [command, { ...binding, sessionId: "/child-session" }, 101],
    [command, binding, 111],
  ]) assert.equal(consumeExternalApproval(make(), cmd, ctx, { now }), false);
});

test("only literal gh pr create/merge commands are representable; scripts and local-yolo have no grant", () => {
  for (const cmd of ["gh pr merge topic --merge", "gh pr create --base main"]) assert.ok(parseApprovedGhOperation(cmd));
  for (const cmd of ["echo gh pr create", "gh pr create && echo x", "gh pr merge $(id)", "GH_TOKEN=x gh pr create", "git push", "npm run deploy"]) assert.equal(parseApprovedGhOperation(cmd), undefined, cmd);
});
