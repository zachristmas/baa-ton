import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { registerExternalApprovalBeforeToolCall } from "../external-approval-hook.mjs";
import { createExternalApprovalResolver } from "../external-approval-resolver.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const commandCreate = "gh pr create --repo owner/repo --base main";
const commandMerge = `gh pr merge 123 --repo owner/repo --match-head-commit ${"a".repeat(40)} --merge`;
const headOid = "a".repeat(40);
const binding = { repo: "/repo", head: headOid, branch: "topic", target: "main", baseRef: "main", headRef: "topic", targetRepo: "owner/repo", host: "github.com", remoteName: "origin", paneId: "w:p1", sessionId: "/session", caller: "root" };

// Dispatch through the registered production Pi callback, then emulate Pi's Bash executor only when unblocked.
async function dispatchToolCall(command, options = {}) {
  const state = { prompts: 0, executions: 0, diagnostics: [] };
  const listeners = new Map();
  let currentBinding = operationBinding(command);
  function operationBinding(value) { return parsePush(value) ? { ...binding, head: parsePush(value)[2], branch: parsePush(value)[3], destinationRef: `refs/heads/${parsePush(value)[3]}` } : binding; }
  function parsePush(value) { return /git push (\S+) ([a-f0-9]{40}):refs\/heads\/([\w./-]+)/.exec(value); }
  const pi = { on: (name, listener) => listeners.set(name, listener) };
  registerExternalApprovalBeforeToolCall(pi, async (_event, ctx) => {
    assert.equal(ctx.cwd, "/repo");
    return {
      enabled: options.enabled ?? true,
      caller: options.caller ?? "root",
      hasUI: options.hasUI ?? true,
      mode: options.mode ?? "tui",
      confirmAvailable: options.confirmAvailable ?? (options.hasUI ?? true),
      diagnostic: (entry) => state.diagnostics.push(entry),
      sessionFile: Object.hasOwn(options, "sessionFile") ? options.sessionFile : "/session",
      resolveBinding: options.resolveBinding ?? (async (operation) => {
        if (options.remotes && options.remotes.filter((r) => r.repo.toLowerCase() === operation.repo.toLowerCase()).length !== 1) throw new Error("remote identity not unique");
        if (options.mismatch) return { ...currentBinding, targetRepo: "owner/elsewhere" };
        return { ...currentBinding };
      }),
      confirm: async (operation, shown) => {
        state.prompts++;
        state.shown = { operation, binding: shown };
        if (options.changeDuringConfirm) currentBinding = { ...currentBinding, ...options.changeDuringConfirm };
        if (options.onConfirm) await options.onConfirm(operation, shown);
        return options.confirm ?? true;
      },
    };
  });
  const event = { toolName: "bash", input: { command } };
  const result = await listeners.get("tool_call")(event, { cwd: "/repo", mode: options.mode ?? "tui", hasUI: options.hasUI ?? true });
  if (!result?.block) {
    state.executions++;
    state.executedCommand = event.input.command;
  }
  return { blocked: Boolean(result?.block), reason: result?.reason, ...state };
}

test("index.ts registers the same production approval registration seam used by the integration harness", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(source, /registerExternalApprovalBeforeToolCall\(pi,/);
  assert.match(source, /mode: \(ctx as ExtensionContext & \{ mode\?: string \}\)\.mode/);
  assert.match(source, /baa-external-approval-diagnostic/);
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
  const safe = await dispatchToolCall(`git push origin ${headOid}:refs/heads/topic`);
  assert.equal(safe.blocked, false);
  assert.equal(safe.prompts, 1);
  assert.equal(safe.executions, 1);
  for (const command of ["git push --force origin HEAD:refs/heads/topic", "git push origin HEAD:refs/heads/topic; echo x", "git push https://example.test/o/r HEAD:refs/heads/topic"]) {
    const result = await dispatchToolCall(command);
    assert.equal(result.blocked, true, command);
    assert.equal(result.executions, 0, command);
  }
});

test("binding changes while native confirmation is open block execution", async () => {
  const changes = [
    { head: "b".repeat(40) }, { branch: "other" }, { repo: "/other" },
    { host: "evil.example" }, { targetRepo: "owner/other" },
    { headRef: "other" }, { baseRef: "release", target: "release" },
    { remoteUrl: "ssh://evil.example/owner/repo.git" }, { remoteRepo: "owner/other" },
    { destinationOid: "c".repeat(40) }, { pr: { number: 123, state: "CLOSED" } },
    { pr: { number: 123, headOid: "b".repeat(40), state: "OPEN" } },
    { pr: { number: 123, baseOid: "c".repeat(40), state: "OPEN" } },
  ];
  for (const changeDuringConfirm of changes) {
    const result = await dispatchToolCall(commandCreate, { changeDuringConfirm });
    assert.equal(result.blocked, true, JSON.stringify(changeDuringConfirm));
    assert.equal(result.prompts, 1);
    assert.equal(result.executions, 0);
  }
  const changedPush = await dispatchToolCall(`git push origin ${headOid}:refs/heads/topic`, { changeDuringConfirm: { head: "b".repeat(40) } });
  assert.equal(changedPush.blocked, true);
  assert.equal(changedPush.executions, 0);
});

test("resolver binds effective push URL/live OID and authoritative PR metadata from fake servers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "external-approval-"));
  const session = join(dir, "session");
  await writeFile(session, "session");
  const state = { pushUrl: "git@github.com:owner/repo.git", branch: "topic", destination: "b".repeat(40), head: "a".repeat(40), base: "c".repeat(40), prState: "OPEN", mergeStateStatus: "CLEAN" };
  const calls = [];
  const fakeExec = async (program, args, options) => {
    calls.push({ program, args: [...args], options });
    let stdout = "";
    if (program === "git" && args.join(" ") === "rev-parse --show-toplevel") stdout = dir;
    else if (program === "git" && args.join(" ") === "rev-parse HEAD") stdout = state.head;
    else if (program === "git" && args.join(" ") === "symbolic-ref --quiet --short HEAD") stdout = state.branch;
    else if (program === "git" && args[0] === "remote" && args[1] === "get-url") stdout = state.pushUrl;
    else if (program === "git" && args[0] === "remote") stdout = "origin";
    else if (program === "git" && args[0] === "config" && args[1] === "--get" && args[2].startsWith("branch.")) stdout = "origin";
    else if (program === "git" && args[0] === "config") throw new Error("not configured");
    else if (program === "git" && args[0] === "ls-remote") stdout = args.at(-1) === state.missingRef ? "" : `${args.at(-1) === `refs/heads/${state.branch}` ? state.head : state.destination}\t${args.at(-1)}`;
    else if (program === "gh" && args[0] === "pr" && args[1] === "view") stdout = JSON.stringify({ number: 123, state: state.prState, mergeStateStatus: state.mergeStateStatus, mergeable: "MERGEABLE", mergedAt: null, url: "https://github.com/owner/repo/pull/123", headRefName: "topic", headRefOid: state.head, headRepositoryOwner: { login: "owner" }, headRepository: { name: "repo" }, baseRefName: "main", baseRefOid: state.base });
    else throw new Error(`unexpected fake command ${program} ${args.join(" ")}`);
    return { stdout };
  };
  const resolver = createExternalApprovalResolver({ cwd: dir, execFile: fakeExec, sessionFile: session, paneId: "w:p1" });
  try {
    const push = await resolver(parsePushOperation(`git push origin ${state.head}:refs/heads/main`));
    assert.equal(push.destinationOid, state.destination);
    assert.equal(push.remoteRepo, "owner/repo");
    const created = await resolver({ operation: "create", argv: ["gh", "pr", "create", "--repo", "owner/repo", "--base", "main"], repo: "owner/repo" });
    assert.equal(created.headRefOid, state.head);
    assert.equal(created.baseRefOid, state.destination);
    assert.equal(created.targetRepo, "owner/repo");
    assert.equal(created.baseRef, "main");
    assert.equal(created.headRef, "topic");
    state.pushUrl = "git@github.com:zachristmas/baa-ton.git";
    state.branch = "feat/reset-yolo-policy";
    const exactCreate = await resolver({ operation: "create", repo: "zachristmas/baa-ton", argv: ["gh", "pr", "create", "--repo", "zachristmas/baa-ton", "--base", "main", "--head", "feat/reset-yolo-policy", "--title", "Harden reset cleanup and external approval gates", "--body", "Hardens reset and Windows process-identity cleanup; adds routine local-YOLO grants while preserving external escalation; canonicalizes configured dispatch profiles and rejects ad-hoc profiles; binds Git push/PR approvals to the root session, immutable OIDs, live refs and authoritative PR metadata. Validation: npm test 195/195; extension suite 651/651; focused profile policy 36/36. TypeScript reports existing repository diagnostics."] });
    assert.equal(exactCreate.headRefOid, state.head);
    assert.equal(exactCreate.baseRefOid, state.destination);
    assert.equal(exactCreate.targetRepo, "zachristmas/baa-ton");
    assert.equal(exactCreate.headRef, "feat/reset-yolo-policy");
    state.pushUrl = "git@github.com:owner/repo.git";
    state.branch = "topic";
    const prOperation = { operation: "merge", argv: ["gh", "pr", "merge", "123", "--repo", "owner/repo", "--squash", "--match-head-commit", state.head], repo: "owner/repo" };
    const pr = await resolver(prOperation);
    assert.equal(pr.pr.headOid, state.head);
    assert.equal(pr.pr.baseOid, state.base);
    assert.equal(pr.pr.state, "OPEN");
    assert.equal(pr.pr.mergeStateStatus, "CLEAN");
    const viewCall = calls.find((call) => call.program === "gh" && call.args[0] === "pr" && call.args[1] === "view");
    assert.deepEqual(viewCall.args, ["pr", "view", "123", "--repo", "owner/repo", "--json", "number,state,headRefOid,baseRefOid,mergeStateStatus,mergeable,mergedAt,url,headRefName,baseRefName,headRepositoryOwner,headRepository"]);
    assert.deepEqual(viewCall.options, { cwd: dir, encoding: "utf8", maxBuffer: 1024 * 1024 });
    state.head = "d".repeat(40);
    await assert.rejects(resolver(prOperation), (error) => error.resolverPhase === "pr_metadata");
    state.head = "a".repeat(40);
    state.prState = "CLOSED";
    await assert.rejects(resolver(prOperation), (error) => error.resolverPhase === "pr_metadata");
    state.prState = "OPEN";
    state.mergeStateStatus = "DIRTY";
    await assert.rejects(resolver(prOperation), (error) => error.resolverPhase === "pr_metadata");
    state.mergeStateStatus = "CLEAN";
    state.missingRef = "refs/heads/main";
    await assert.rejects(resolver({ operation: "create", argv: ["gh", "pr", "create", "--repo", "owner/repo", "--base", "main"], repo: "owner/repo" }), (error) => error.message === "External approval resolver failed." && error.resolverPhase === "base_oid");
    state.missingRef = "";
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function parsePushOperation(command) {
  const oid = /git push origin ([a-f0-9]{40}):refs\/heads\/([\w./-]+)/.exec(command);
  return { operation: "push", argv: command.split(" "), remoteName: "origin", branch: oid[2], sourceRef: oid[1], destinationRef: `refs/heads/${oid[2]}` };
}

test("fail-closed tool results expose only the final enum diagnostics and never execute", async () => {
  const cases = [
    [commandCreate, { hasUI: false, mode: "headless" }, "deny", "no_ui"],
    [commandCreate, { enabled: false }, "deny", "disabled"],
    [commandCreate, { caller: "child" }, "deny", "non_root"],
    [commandCreate, { sessionFile: null }, "deny", "no_session"],
    [commandCreate, { confirmAvailable: false }, "deny", "no_confirm"],
    ["gh pr list && eval \\\"$BAA_PR_COMMAND\\\"", {}, "parse", "unsafe_command"],
    [commandCreate, { mismatch: true }, "deny", "binding_mismatch"],
    [commandCreate, { confirm: false }, "deny", "declined"],
    [commandCreate, { changeDuringConfirm: { head: "b".repeat(40) } }, "deny", "binding_changed"],
    [commandCreate, { resolveBinding: async () => { throw Object.assign(new Error("token-abc /private/path"), { resolverPhase: "base_oid" }); } }, "deny", "resolver_error"],
  ];
  for (const [command, options, stage, denial] of cases) {
    const result = await dispatchToolCall(command, options);
    assert.equal(result.blocked, true, denial);
    assert.equal(result.executions, 0, denial);
    assert.match(result.reason, new RegExp(`stage=${stage}, denial=${denial}`));
    if (options.resolveBinding) assert.match(result.reason, /resolverPhase=base_oid/);
    assert.match(result.reason, /mode=(?:tui|headless|unknown), hasUI=(?:true|false), confirmAvailable=(?:true|false)/);
    for (const secret of [command, "secret-owner", "private-repo", "token-abc", "/private/path", "/repo"]) assert.equal(result.reason.includes(secret), false);
  }
});

test("diagnostics record only safe state and stable categories, never command or binding data", async () => {
  const approved = await dispatchToolCall(commandCreate);
  assert.deepEqual(approved.diagnostics.map(({ stage }) => stage), ["parse", "resolve-before", "confirm", "resolve-after", "allow"]);
  assert.ok(approved.diagnostics.every((entry) => entry.mode === "tui" && entry.hasUI && entry.confirmAvailable && entry.denial === "none"));
  const privateCommand = "gh pr create --repo secret-owner/private-repo --base token-abc https://secret.example/private";
  const denied = await dispatchToolCall(privateCommand, { mode: "headless", hasUI: false, sessionFile: "/private/session/path" });
  assert.equal(denied.blocked, true);
  assert.deepEqual(denied.diagnostics, [{ mode: "headless", hasUI: false, confirmAvailable: false, stage: "deny", denial: "no_ui" }]);
  const serialized = JSON.stringify([...approved.diagnostics, ...denied.diagnostics]);
  for (const secret of ["secret-owner", "private-repo", "token-abc", "secret.example", "/private/session/path", commandCreate]) assert.equal(serialized.includes(secret), false);
  assert.deepEqual(Object.keys(denied.diagnostics[0]).sort(), ["confirmAvailable", "denial", "hasUI", "mode", "stage"]);
});

test("read-only PR commands pass through without approval", async () => {
  for (const command of ["gh pr list", "gh pr list --state open", "gh pr view 12", "gh pr status", "gh pr diff 12", "gh pr checks 12"]) {
    const result = await dispatchToolCall(command);
    assert.equal(result.prompts, 0, command);
    assert.equal(result.executions, 1, command);
  }
});
