import assert from "node:assert/strict";
import { test } from "node:test";
import { approveExternalGhCommand } from "../external-approval-hook.mjs";

const commandCreate = "gh pr create --repo owner/repo --base main";
const commandMerge = "gh pr merge topic --repo owner/repo --merge";
const binding = { repo: "/repo", head: "abc", branch: "topic", target: "main", baseRef: "main", headRef: "topic", targetRepo: "owner/repo", host: "github.com", remoteName: "origin", paneId: "w:p1", sessionId: "/session", caller: "root" };

// Mirrors Pi's before_tool_call result contract. An executor counter proves the harness
// never runs a command; permitted commands are represented, not executed.
async function beforeToolCall(command, options = {}) {
  const state = { prompts: 0, executions: 0 };
  const approved = await approveExternalGhCommand({
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
  const blocked = !approved;
  // Intentionally never invoke a command executor, even when the hook permits it.
  return { blocked, ...state };
}

test("before_tool_call asks native confirmation and allows exact create/merge path without executing it", async () => {
  for (const command of [commandCreate, commandMerge]) {
    const result = await beforeToolCall(command);
    assert.equal(result.blocked, false);
    assert.equal(result.prompts, 1);
    assert.equal(result.executions, 0);
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

test("only the exact explicit repository is displayed and accepted", async () => {
  const result = await beforeToolCall(commandCreate, { remotes: [{ repo: "owner/repo" }] });
  assert.equal(result.blocked, false);
  assert.equal(result.shown.binding.targetRepo, "owner/repo");
  const mismatch = await beforeToolCall("gh pr create --repo owner/other --base main", { remotes: [{ repo: "owner/repo" }] });
  assert.equal(mismatch.blocked, true);
  assert.equal(mismatch.prompts, 0);
  assert.equal(mismatch.executions, 0);
});
