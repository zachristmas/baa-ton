import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { formatPlan, planReset, runReset, STATE_SUBPATH } from "../reset.mjs";

function project() {
  const root = mkdtempSync(join(tmpdir(), "reset-"));
  const dir = join(root, STATE_SUBPATH);
  mkdirSync(dir, { recursive: true });
  const intent = join(dir, "herdr-00000001-lane-1-startup.json");
  const manifest = {
    version: 2,
    approvalPolicyAck: { hash: "abc" },
    queue: { items: [{ id: "q" }] },
    leases: [{ id: "l1" }, { id: "l2", releasedAt: "2026-01-01" }],
    workflows: [
      { id: "herdr-00000001", status: "running", worktree: { path: "/w/worktree-a" }, lanes: [{ id: "lane-1", tabId: "w1:t2", status: "running", startupIntentPath: intent }] },
      { id: "herdr-00000002", status: "completed", lanes: [{ id: "lane-1", tabId: "w1:t9", status: "done", retirement: { status: "retired" } }, { id: "lane-2", tabId: "w1:t1", status: "running" }] },
    ],
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  for (const name of ["herdr-00000001-lane-1-startup.json", "herdr-00000001-lane-1-startup.json.ready", "claude-mcp-aaaaaaaa.json", "manifest.json.pre-old", "spec-state.json", "spec.json", "known-safe-approvals.jsonl"]) writeFileSync(join(dir, name), "x");
  return { root, dir };
}
const ports = (closed) => ({ rootTabIds: new Set(["w1:t1"]), closeTab: (id) => closed.push(id), killLane: async () => ({}), env: {} });

test("the plan covers every lane tab except the root's own and lists worktrees without touching them", () => {
  const { root, dir } = project();
  try {
    const plan = planReset(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")), { stateDir: dir, names: readdirSync(dir), rootTabIds: new Set(["w1:t1"]), specStatePresent: true });
    assert.deepEqual(plan.tabs.map((tab) => tab.tabId).sort(), ["w1:t2", "w1:t9"]);
    assert.equal(plan.leases, 1);
    assert.deepEqual(plan.worktreesLeftAlone, ["/w/worktree-a"]);
    assert.match(formatPlan(plan), /dry run/);
    assert.ok(plan.keeps.includes("spec-state.json (progress)"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dry run changes nothing", async () => {
  const { root, dir } = project();
  const closed = [];
  try {
    const before = readFileSync(join(dir, "manifest.json"), "utf8");
    const result = await runReset({ projectRoot: root, ...ports(closed) });
    assert.equal(result.applied, false);
    assert.deepEqual(closed, []);
    assert.equal(readFileSync(join(dir, "manifest.json"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applying archives the manifest first, empties it, keeps config and spec progress, deletes lane files", async () => {
  const { root, dir } = project();
  const closed = [];
  try {
    const result = await runReset({ projectRoot: root, apply: true, ...ports(closed) });
    assert.equal(result.applied, true);
    assert.deepEqual(closed.sort(), ["w1:t2", "w1:t9"]);
    const fresh = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.deepEqual(fresh, { version: 2, workflows: [], approvalPolicyAck: { hash: "abc" } });
    const archive = readdirSync(join(dir, "archive")).find((name) => name.endsWith(".manifest.json.gz"));
    assert.equal(JSON.parse(gunzipSync(readFileSync(join(dir, "archive", archive))).toString()).workflows.length, 2);
    assert.deepEqual(readdirSync(dir).filter((name) => /^herdr-|^claude-|\.pre-/.test(name)), []);
    for (const kept of ["spec.json", "spec-state.json", "known-safe-approvals.jsonl"]) assert.ok(existsSync(join(dir, kept)), kept);
    assert.ok(!existsSync(join(dir, ".manifest.json.herdr-orchestrator.lock")), "lock released");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--include-spec archives and clears spec progress too", async () => {
  const { root, dir } = project();
  try {
    await runReset({ projectRoot: root, apply: true, includeSpec: true, ...ports([]) });
    assert.ok(!existsSync(join(dir, "spec-state.json")));
    assert.ok(readdirSync(join(dir, "archive")).some((name) => name.endsWith(".spec-state.json.gz")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inside Herdr, an unknown root tab refuses rather than risk closing the root", async () => {
  const { root, dir } = project();
  try {
    await assert.rejects(runReset({ projectRoot: root, apply: true, ...ports([]), rootTabIds: new Set(), env: { HERDR_PANE_ID: "w1:p1" } }), /cannot tell which tab holds this root/);
    assert.equal(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).workflows.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tab that is already gone is not a failure; other close errors are reported", async () => {
  const { root } = project();
  try {
    const result = await runReset({ projectRoot: root, apply: true, ...ports([]), closeTab: (id) => { throw new Error(id === "w1:t2" ? "tab not found" : "socket closed"); } });
    assert.deepEqual(result.failures, ["tab w1:t9: socket closed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
