import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { laneGuardVerdict } from "../lane-guard.mjs";

const cwd = "/work/lanes/d03";
const scratch = "/state/herdr-orchestrator";
const call = (tool_name, tool_input) => laneGuardVerdict({ tool_name, tool_input, cwd }, { scratch });

test("the lane guard keeps writes inside the lane's worktree, /tmp and its scratch, in any permission mode", () => {
  assert.equal(call("Write", { file_path: "/work/lanes/d03/src/a.ts" }), undefined);
  assert.equal(call("Edit", { file_path: "src/b.ts" }), undefined, "relative to the worktree");
  assert.equal(call("Write", { file_path: "/tmp/demo/steps.json" }), undefined);
  assert.equal(call("Write", { file_path: `${scratch}/notes.md` }), undefined);
  assert.match(call("Write", { file_path: "/work/lanes/d04/src/a.ts" }).deny, /outside the lane's worktree/);
  assert.match(call("Edit", { file_path: "../d04/x.ts" }).deny, /outside the lane's worktree/);
  assert.match(call("Write", { file_path: `${homedir()}/.zshrc` }).deny, /outside the lane's worktree/);
  assert.equal(call("Bash", { command: "pnpm test" }), undefined, "other tools get no decision here");
});

test("the lane guard keeps credentials out of reach: keys, cloud and gh tokens, keychain, .env outside the worktree", () => {
  assert.match(call("Read", { file_path: `${homedir()}/.ssh/id_ed25519` }).deny, /credential file/);
  assert.match(call("Read", { file_path: `${homedir()}/.aws/credentials` }).deny, /credential file/);
  assert.match(call("Bash", { command: "cat ~/.ssh/id_rsa" }).deny, /reads credentials/);
  assert.match(call("Bash", { command: "gh auth token" }).deny, /reads credentials/);
  assert.match(call("Bash", { command: "security find-generic-password -s x -w" }).deny, /reads credentials/);
  assert.match(call("Bash", { command: "cat /Users/someone/prod/.env" }).deny, /environment file outside the lane's worktree/);
  assert.match(call("Read", { file_path: "/srv/app/.env.production" }).deny, /credential file/);
  assert.equal(call("Read", { file_path: "/work/lanes/d03/.env.demo" }), undefined, "the lane's own demo env stays usable");
  assert.equal(call("Bash", { command: "export $(cat .env.demo | xargs) && pnpm dev" }), undefined);
});

test("as a hook it answers deny with a reason on stdout, and nothing otherwise", () => {
  const hook = fileURLToPath(new URL("../lane-guard.mjs", import.meta.url));
  const run = (input) => spawnSync(process.execPath, [hook, "--scratch", scratch], { input: JSON.stringify(input), encoding: "utf8" });
  const denied = JSON.parse(run({ tool_name: "Write", tool_input: { file_path: "/etc/hosts" }, cwd }).stdout);
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /^Baa-ton lane guard: Write outside the lane's worktree/);
  assert.equal(run({ tool_name: "Write", tool_input: { file_path: "/work/lanes/d03/a.ts" }, cwd }).stdout, "");
});
