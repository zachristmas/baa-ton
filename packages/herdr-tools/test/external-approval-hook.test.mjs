import assert from "node:assert/strict";
import { test } from "node:test";
import { registerExternalApprovalBeforeToolCall } from "../external-approval-hook.mjs";

const commandCreate = "gh pr create --repo owner/repo --base main";
const commandMerge = "gh pr merge topic --repo owner/repo --merge";
const binding = { repo: "/repo", head: "abc", branch: "topic", target: "main", baseRef: "main", headRef: "topic", targetRepo: "owner/repo", host: "github.com", remoteName: "origin", paneId: "w:p1", sessionId: "/session", caller: "root" };

// Register the real gate on a fake Pi event bus and route unblocked calls to a fake executor.
async function beforeToolCall(command, options = {}) {
  const state = { prompts: 0, executions: 0 };
  const listeners = new Map();
  const pi = { on: (name, listener) => listeners.set(name, listener) };
  registerExternalApprovalBeforeToolCall(pi, {
    command,
    enabled: options.enabled ?? true,
    caller: options.caller ?? "root",
    hasUI: options.hasUI ?? true,
    sessionFile: Object.hasOwn(options, "sessionFile") ? options.sessionFile : "/session",
    resolveBinding: async (operation) => {
      if (options.remotes && options.remotes.filter((r) => r.repo.toLowerCase() === operation.repo.toLowerCase()).length !== 1) throw new Error("remote identity not unique");
      if (options.mismatch) return { ...binding, targetRepo: "owner/elsewhere" };
      return binding;
    },
    confirm: async (operation, shown) => {
      state.prompts++;
      state.shown = { operation, binding: shown };
      return options.confirm ?? true;
    },
  });
  const result = await listeners.get("tool_call")({ toolName: "bash", input: { command } });
  if (!result?.block) {
    state.executions++;
    state.executedCommand = command;
  }
  return { blocked: Boolean(result?.block), ...state };
}

test("registered before_tool_call asks confirmation and invokes the fake executor once for exact create/merge", async () => {
  for (const command of [commandCreate, commandMerge]) {
    const result = await beforeToolCall(command);
    assert.equal(result.blocked, false);
    assert.equal(result.prompts, 1);
    assert.equal(result.executions, 1);
    assert.equal(result.executedCommand, command);
    assert.equal(result.shown.binding.targetRepo, "owner/repo");
  }
});

test("decline, missing UI/token, child/headless callers and remote identity failures block", async () => {
  for (const options of [{ confirm: false }, { enabled: false }, { caller: "child" }, { hasUI: false }, { sessionFile: null }, { mismatch: true }, { remotes: [{ repo: "owner/repo" }, { repo: "OWNER/REPO" }] }]) {
    const result = await beforeToolCall(commandCreate, options);
    assert.equal(result.blocked, true, JSON.stringify(options));
    assert.equal(result.executions, 0);
    assert.equal(result.prompts, options.confirm === false ? 1 : 0);
  }
});

test("wrapped, quoted and compound command forms are blocked and never prompted or executed", async () => {
  for (const command of ["env gh pr create --repo owner/repo", "sh -c 'gh pr merge topic --repo owner/repo'", "gh pr create --repo owner/repo; echo unsafe", "gh pr create --repo owner/repo && gh pr merge topic --repo owner/repo", "gh 'pr' create --repo owner/repo --base main"]) {
    const result = await beforeToolCall(command);
    assert.equal(result.blocked, true, command);
    assert.equal(result.prompts, 0, command);
    assert.equal(result.executions, 0, command);
  }
});

test("before_tool_call never prompts for compound, indirect, or dynamic PR commands", async () => {
  for (const command of ["gh pr list && eval \"$BAA_PR_COMMAND\"", "gh pr list; \"$RUNNER\" ...", "gh pr list | cat", "(gh pr list)", "bash -c 'gh pr list'", "gh pr `echo list`", "gh pr $(echo list)", "eval \"$BAA_PR_COMMAND\""]) {
    const result = await beforeToolCall(command);
    assert.equal(result.prompts, 0, command);
    assert.equal(result.executions, 0, command);
  }
  for (const command of ["gh pr list", "gh pr list --state open", "gh pr view 12", "gh pr status", "gh pr diff 12", "gh pr checks 12"]) {
    const result = await beforeToolCall(command);
    assert.equal(result.prompts, 0, command);
    assert.equal(result.executions, 0, command);
  }
});

test("only the exact explicit repository is displayed and accepted", async () => {
  const result = await beforeToolCall(commandCreate, { remotes: [{ repo: "owner/repo" }] });
  assert.equal(result.blocked, false);
  assert.equal(result.shown.binding.targetRepo, "owner/repo");
  const mismatch = await beforeToolCall("gh pr create --repo owner/other --base main", { remotes: [{ repo: "owner/repo" }] });
  assert.equal(mismatch.blocked, true);
  assert.equal(mismatch.prompts, 0);
  assert.equal(mismatch.executions, 0);
});
