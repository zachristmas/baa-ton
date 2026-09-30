import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { registerExternalApprovalBeforeToolCall } from "../external-approval-hook.mjs";

const commandCreate = "gh pr create --repo owner/repo --base main";
const commandMerge = "gh pr merge topic --repo owner/repo --merge";
const binding = { repo: "/repo", head: "abc", branch: "topic", target: "main", baseRef: "main", headRef: "topic", targetRepo: "owner/repo", host: "github.com", remoteName: "origin", paneId: "w:p1", sessionId: "/session", caller: "root" };

// Dispatch through the registered production Pi callback, then emulate Pi's Bash executor only when unblocked.
async function dispatchToolCall(command, options = {}) {
  const state = { prompts: 0, executions: 0 };
  const listeners = new Map();
  const pi = { on: (name, listener) => listeners.set(name, listener) };
  registerExternalApprovalBeforeToolCall(pi, async (_event, ctx) => {
    assert.equal(ctx.cwd, "/repo");
    return {
      enabled: options.enabled ?? true,
      caller: options.caller ?? "root",
      hasUI: options.hasUI ?? true,
      sessionFile: Object.hasOwn(options, "sessionFile") ? options.sessionFile : "/session",
      resolveBinding: async (operation) => {
        if (options.remotes && options.remotes.filter((r) => r.repo.toLowerCase() === operation.repo.toLowerCase()).length !== 1) throw new Error("remote identity not unique");
        if (options.mismatch) return { ...binding, targetRepo: "owner/elsewhere" };
        return operation.operation === "push" ? { ...binding, destinationRef: operation.destinationRef } : binding;
      },
      confirm: async (operation, shown) => {
        state.prompts++;
        state.shown = { operation, binding: shown };
        return options.confirm ?? true;
      },
    };
  });
  const event = { toolName: "bash", input: { command } };
  const result = await listeners.get("tool_call")(event, { cwd: "/repo", hasUI: true });
  if (!result?.block) {
    state.executions++;
    state.executedCommand = event.input.command;
  }
  return { blocked: Boolean(result?.block), ...state };
}

test("index.ts registers the same production approval registration seam used by the integration harness", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(source, /registerExternalApprovalBeforeToolCall\(pi,/);
  assert.match(source, /externalApprovalChecked\.has\(event\)/);
  assert.match(source, /externalApprovalGranted\.has\(event\)/);
});

test("registered tool_call pre-execution hook approves exact create/merge and executes fake Bash exactly once", async () => {
  for (const command of [commandCreate, commandMerge]) {
    const result = await dispatchToolCall(command);
    assert.equal(result.blocked, false);
    assert.equal(result.prompts, 1);
    assert.equal(result.executions, 1);
    assert.equal(result.executedCommand, command);
    assert.equal(result.shown.binding.targetRepo, "owner/repo");
  }
});

test("decline, child/headless, repo mismatch and ambiguous remotes block without executing", async () => {
  for (const options of [{ confirm: false }, { enabled: false }, { caller: "child" }, { hasUI: false }, { sessionFile: null }, { mismatch: true }, { remotes: [{ repo: "owner/repo" }, { repo: "OWNER/REPO" }] }]) {
    const result = await dispatchToolCall(commandCreate, options);
    assert.equal(result.blocked, true, JSON.stringify(options));
    assert.equal(result.executions, 0);
    assert.equal(result.prompts, options.confirm === false ? 1 : 0);
  }
});

test("wrapped, quoted, compound, dynamic and unsafe command forms block without prompt or execution", async () => {
  for (const command of ["env gh pr create --repo owner/repo", "sh -c 'gh pr merge topic --repo owner/repo'", "gh pr create --repo owner/repo; echo unsafe", "gh pr create --repo owner/repo && gh pr merge topic --repo owner/repo", "gh 'pr' create --repo owner/repo --base main", "gh pr list && eval \\\"$BAA_PR_COMMAND\\\"", "gh pr list; \\\"$RUNNER\\\" ...", "gh pr list | cat", "(gh pr list)", "bash -c 'gh pr list'", "gh pr `echo list`", "gh pr $(echo list)", "eval \\\"$BAA_PR_COMMAND\\\""]) {
    const result = await dispatchToolCall(command);
    assert.equal(result.blocked, true, command);
    assert.equal(result.prompts, 0, command);
    assert.equal(result.executions, 0, command);
  }
});

test("direct simple push is natively approved once and unsafe push forms block", async () => {
  const safe = await dispatchToolCall("git push origin HEAD:refs/heads/topic");
  assert.equal(safe.blocked, false);
  assert.equal(safe.prompts, 1);
  assert.equal(safe.executions, 1);
  for (const command of ["git push --force origin HEAD:refs/heads/topic", "git push origin HEAD:refs/heads/topic; echo x", "git push https://example.test/o/r HEAD:refs/heads/topic"]) {
    const result = await dispatchToolCall(command);
    assert.equal(result.blocked, true, command);
    assert.equal(result.executions, 0, command);
  }
});

test("read-only PR commands pass through without approval", async () => {
  for (const command of ["gh pr list", "gh pr list --state open", "gh pr view 12", "gh pr status", "gh pr diff 12", "gh pr checks 12"]) {
    const result = await dispatchToolCall(command);
    assert.equal(result.prompts, 0, command);
    assert.equal(result.executions, 1, command);
  }
});
