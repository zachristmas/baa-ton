import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeExternalApproval, containsGhPrMutation, containsUnsafeShellExecution, issueExternalApproval, parseApprovedGhOperation } from "../external-approval.mjs";

const binding = { repo: "/repo", head: "abc", branch: "topic", target: "main", targetRepo: "owner/repo", host: "github.com", remoteName: "origin", paneId: "w:p1", sessionId: "/session", caller: "root" };
const command = "gh pr create --repo owner/repo --base main";

test("external operation approval is explicit, exact, bound, expiring and one-use", () => {
  assert.equal(parseApprovedGhOperation(command).operation, "create");
  assert.equal(issueExternalApproval("gh pr create --repo owner/repo --base main; echo unsafe", binding), undefined);
  assert.equal(issueExternalApproval("git push", binding), undefined);
  assert.equal(issueExternalApproval(command, { ...binding, caller: "child" }), undefined);
  assert.equal(issueExternalApproval(command, { ...binding, targetRepo: "other/repo" }), undefined);
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

test("only literal gh pr create/merge commands are representable; wrappers fail closed", () => {
  for (const cmd of ["gh pr merge topic -R owner/repo --merge", "gh pr create --repo=owner/repo --base main", "gh pr create --repo owner/repo --base main", "gh 'pr' create --repo owner/repo --base main", "gh pr create --repo=owner/repo --base 'main ref'"]) assert.ok(parseApprovedGhOperation(cmd));
  for (const cmd of ["gh pr merge topic --merge", "gh pr create --base main", "gh pr create -R owner/repo --repo owner/other", "env gh pr merge topic -R owner/repo --merge", "GH_TOKEN=x gh pr create -R owner/repo --base main", "echo gh pr create", "gh pr create && echo x", "gh pr merge $(id)", "git push", "npm run deploy"]) assert.equal(parseApprovedGhOperation(cmd), undefined, cmd);
  for (const cmd of ["gh pr merge topic -R owner/repo --merge", "env gh pr merge topic -R owner/repo --merge", "GH_TOKEN=x gh pr create -R owner/repo --base main", "sh -c 'gh pr create'"]) assert.equal(containsGhPrMutation(cmd), true, cmd);
  assert.equal(containsGhPrMutation("gh --hostname github.com pr merge topic -R owner/repo --merge"), true);
  assert.equal(containsGhPrMutation("command 'gh' pr create -R owner/repo --base main"), true);
  for (const cmd of ["gh pr create --repo owner/repo; echo done", "gh pr create --repo owner/repo\\n", "gh pr\\ create -R owner/repo", "gh pr create -R owner/repo$(id)", "gh pr create -R owner/repo && gh pr merge -R owner/repo", "sh -c 'gh pr create -R owner/repo'", "env GH_TOKEN=x command gh pr merge -R owner/repo"]) assert.equal(containsGhPrMutation(cmd), true, cmd);
  for (const cmd of ["env gh pr create -R owner/repo", "command gh pr merge -R owner/repo", "sh -c 'gh pr create -R owner/repo'"]) assert.equal(parseApprovedGhOperation(cmd), undefined, cmd);
  const shownBinding = { ...binding, host: "github.com", remoteName: "fork" };
  assert.equal(consumeExternalApproval(issueExternalApproval(command, binding), command, shownBinding), false, "remote identity is bound");
  assert.equal(containsGhPrMutation("git status"), false);
});

test("gh pr is default-deny except for explicit read-only verbs", () => {
  const mutators = ["create", "merge", "close", "edit", "reopen", "review", "ready", "update-branch", "lock", "unlock", "comment", "delete", "checkout"];
  for (const verb of mutators) assert.equal(containsGhPrMutation(`gh pr ${verb}`), true, verb);
  for (const args of [
    "review --approve", "review --comment", "review --request-changes", "edit --title changed",
    "close --comment done", "ready", "update-branch", "lock", "unlock", "unknown-verb", "",
  ]) assert.equal(containsGhPrMutation(`gh pr ${args}`), true, args);
  for (const verb of ["list", "view", "status", "diff", "checks"]) assert.equal(containsGhPrMutation(`gh pr ${verb}`), false, verb);
  for (const cmd of ["gh pr list && eval \"$BAA_PR_COMMAND\"", "gh pr list; \"$RUNNER\" ...", "gh pr list | cat", "(gh pr list)", "bash -c 'gh pr list'", "gh pr `echo list`", "gh pr $(echo list)", "gh 'pr' list", "gh pr li'st'", "GH=gh $GH pr list", "env gh pr list", "gh pr list *", "gh pr list # ignored"]) assert.equal(containsGhPrMutation(cmd), true, cmd);
  for (const cmd of ["eval \"$BAA_PR_COMMAND\"", "\"$RUNNER\" ...", "bash -c 'git status'"]) assert.equal(containsUnsafeShellExecution(cmd), true, cmd);
  for (const cmd of ["gh pr list", "gh pr list --state open", "gh pr view 12", "gh pr status", "gh pr diff 12", "gh pr checks 12"]) assert.equal(containsUnsafeShellExecution(cmd), false, cmd);
});

test("mutator detection survives wrappers, quoting, flags and shell composition", () => {
  for (const cmd of [
    "gh pr close 12", "gh 'pr' 'edit' 12", "gh \"pr\" re'view' 12", "GH_TOKEN=x gh pr ready",
    "env command gh pr update-branch", "command gh --hostname github.com pr lock 12",
    "sh -c 'gh pr unlock 12'", "bash -c \"gh pr review --approve\"",
    "gh pr list && gh pr close 12", "echo safe; gh pr edit 12", "gh pr close\\ 12",
    "gh pr close $(printf 12)", "/usr/bin/gh pr reopen 12",
  ]) assert.equal(containsGhPrMutation(cmd), true, cmd);
  for (const cmd of ["gh pr list --state open", "gh pr view 12", "gh pr status", "gh pr diff 12", "gh pr checks 12"]) assert.equal(containsGhPrMutation(cmd), false, cmd);
});
