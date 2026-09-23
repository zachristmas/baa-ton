import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

const root = {
  target: "root-pane",
  target_kind: "pane_id",
  pane_id: "root-pane",
  workspace_id: "root-space",
  agent_kind: "pi",
};

async function git(cwd, ...args) {
  return execFile("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function fixture({ dirty = false, failTab = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "baa-cleanup-sweep-"));
  const cwd = join(directory, "checkout");
  const worktree = join(directory, "orphan-worktree");
  const manifestPath = join(cwd, ".baa-ton", "herdr-orchestrator", "manifest.json");
  const configDir = join(directory, "config");
  await mkdir(cwd, { recursive: true });
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.email", "test@example.invalid");
  await git(cwd, "config", "user.name", "Cleanup Test");
  await git(cwd, "config", "commit.gpgsign", "false");
  await writeFile(join(cwd, "tracked.txt"), "base\n");
  await git(cwd, "add", "tracked.txt");
  await git(cwd, "commit", "-m", "base");
  await git(cwd, "worktree", "add", "-b", "orphan-branch", worktree, "HEAD");
  if (dirty) await writeFile(join(worktree, "dirty.txt"), "dirty\n");

  const tabWorkflow = {
    id: "workflow-tabs",
    objective: "Retire terminal lane tabs.",
    outcome: "completed",
    status: "completed",
    cwd,
    worktree: null,
    lanes: [
      {
        id: "lane-tabs",
        objective: "Tab lane",
        readOnly: false,
        agentKind: "pi",
        status: "completion-reported",
        paneId: "lane-pane",
        tabId: "lane-tab",
        persistenceHandle: { provider: "pi", sessionId: "tab-session" },
        sessionLog: {
          kind: "lane",
          sessionRef: { provider: "pi", sessionId: "tab-session" },
          startedAt: "2026-01-01T00:00:00.000Z",
          status: "completed",
          workflowId: "workflow-tabs",
          laneId: "lane-tabs",
          paneId: "lane-pane",
          tabId: "lane-tab",
          workspaceId: root.workspace_id,
        },
      },
    ],
    taskBinding: {
      workspaceId: root.workspace_id,
      rootPaneId: root.pane_id,
      rootSessionPath: "root-session",
    },
    herdr: {},
    agent: {},
    agentKind: "pi",
    goalSchemaVersion: 1,
    rootGoalId: "goal-workflow-tabs",
    goals: [],
    evidence: [],
    ownership: {
      createdBy: "herdr-orchestrator",
      workspaceId: root.workspace_id,
      tabIds: ["lane-tab"],
      paneIds: ["lane-pane"],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const worktreeWorkflow = {
    id: "workflow-worktree",
    objective: "Remove a retired worktree.",
    outcome: "completed",
    status: "completed",
    cwd: worktree,
    worktree,
    worktreeBinding: {
      checkoutPath: worktree,
      repoParent: {
        workspaceId: root.workspace_id,
        checkoutPath: cwd,
        repoKey: "test-repo",
        repoRoot: cwd,
      },
    },
    lanes: [
      {
        id: "lane-worktree",
        objective: "Worktree lane",
        readOnly: false,
        agentKind: "pi",
        status: "completed",
        paneId: "worktree-pane",
        tabId: "worktree-tab",
        persistenceHandle: { provider: "pi", sessionId: "worktree-session" },
        sessionLog: {
          kind: "lane",
          sessionRef: { provider: "pi", sessionId: "worktree-session" },
          startedAt: "2026-01-01T00:00:00.000Z",
          status: "retired",
          workflowId: "workflow-worktree",
          laneId: "lane-worktree",
          paneId: "worktree-pane",
          tabId: "worktree-tab",
          workspaceId: root.workspace_id,
          worktree,
        },
      },
    ],
    taskBinding: {
      workspaceId: root.workspace_id,
      rootPaneId: root.pane_id,
      rootSessionPath: "root-session",
    },
    laneRetirement: {
      version: 1,
      status: "retired",
      workspaceId: root.workspace_id,
      tabIds: ["worktree-tab"],
      closedTabIds: ["worktree-tab"],
      failedTabIds: [],
      pendingTabIds: [],
      requestedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      evidence: [],
    },
    herdr: {},
    agent: {},
    agentKind: "pi",
    goalSchemaVersion: 1,
    rootGoalId: "goal-workflow-worktree",
    goals: [],
    evidence: [],
    ownership: {
      createdBy: "herdr-orchestrator",
      workspaceId: root.workspace_id,
      tabIds: ["worktree-tab"],
      paneIds: ["worktree-pane"],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await mkdir(join(cwd, ".baa-ton", "herdr-orchestrator"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify({ version: 2, workflows: [tabWorkflow, worktreeWorkflow] }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(configDir, "config.json"),
    `${JSON.stringify({
      version: 2,
      owner: "herdr-orchestrator",
      orchestrators: [{
        id: "cleanup-root",
        root,
        program: { id: cwd, workspace_id: root.workspace_id, parent_manifest_path: manifestPath },
        workflows: [{
          workflow_id: tabWorkflow.id,
          manifest_path: manifestPath,
          lanes: [{
            lane_id: "lane-tabs",
            target: "lane-pane",
            target_kind: "pane_id",
            pane_id: "lane-pane",
            workspace_id: root.workspace_id,
          }],
        }],
      }],
    }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const keys = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_PANE_ID: root.pane_id,
    HERDR_WORKSPACE_ID: root.workspace_id,
    HERDR_PLUGIN_CONFIG_DIR: configDir,
  });
  const calls = [];
  const liveTabs = new Set(["lane-tab"]);
  const tools = new Map();
  extension({
    on() {},
    registerTool(descriptor) {
      tools.set(descriptor.name, descriptor);
    },
    registerCommand() {},
    async exec(command, args) {
      assert.equal(command, "herdr");
      calls.push(args);
      if (args[0] === "plugin" && args[1] === "config-dir")
        return { code: 0, stderr: "", stdout: configDir };
      if (args[0] === "agent" && args[1] === "get")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              type: "agent_info",
              agent: {
                name: "root",
                agent: "pi",
                pane_id: root.pane_id,
                workspace_id: root.workspace_id,
              },
            },
          }),
        };
      if (args[0] === "tab" && args[1] === "list")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              tabs: [...liveTabs].map((tab_id) => ({
                tab_id,
                label: "🐑 tab-lane",
                workspace_id: root.workspace_id,
              })),
            },
          }),
        };
      if (args[0] === "tab" && args[1] === "close") {
        if (failTab) throw new Error("close failed for lane-tab");
        liveTabs.delete(args[2]);
        return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
      }
      if (args[0] === "worktree" && args[1] === "list")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              worktrees: [{ path: worktree, open_workspace_id: null }],
            },
          }),
        };
      throw new Error(`unexpected Herdr command: ${args.join(" ")}`);
    },
  });
  return {
    directory,
    cwd,
    worktree,
    manifestPath,
    tools,
    calls,
    liveTabs,
    async cleanup() {
      for (const [key, value] of Object.entries(saved))
        value === undefined ? delete process.env[key] : (process.env[key] = value);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function context(cwd, confirm) {
  return {
    cwd,
    hasUI: true,
    mode: "tui",
    ui: { async confirm() { return confirm; } },
  };
}

function headlessContext(cwd) {
  return {
    cwd,
    hasUI: false,
    mode: "json",
    ui: { async confirm() { return false; } },
  };
}

async function sweep(fixtureData, execute, confirm = true) {
  return fixtureData.tools.get("herdr_sweep").execute(
    "cleanup-sweep-test",
    { execute },
    undefined,
    undefined,
    context(fixtureData.cwd, confirm),
  );
}

test("cleanup sweep dry-runs the root-scoped tabs and unopened worktree, then decline has no side effects", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.manifestPath, "utf8");
    const dryRun = await sweep(f, false);
    assert.equal(dryRun.details.dryRun, true);
    assert.deepEqual(dryRun.details.laneTabs.map((item) => item.tabId), ["lane-tab"]);
    assert.equal(dryRun.details.laneTabs[0].label, "🐑 tab-lane");
    assert.equal(dryRun.details.worktrees[0].workflowId, "workflow-worktree");
    assert.equal(dryRun.details.worktrees[0].branch, "orphan-branch");
    assert.equal(f.calls.some((args) => args[0] === "tab" && args[1] === "close"), false);

    const declined = await sweep(f, true, false);
    assert.equal(declined.details.cancelled, true);
    assert.equal(f.liveTabs.has("lane-tab"), true);
    assert.equal(await readFile(f.manifestPath, "utf8"), before);
    await git(f.cwd, "show-ref", "--verify", "refs/heads/orphan-branch");
  } finally {
    await f.cleanup();
  }
});

test("headless cleanup reports the user-confirmation handoff and never mutates", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.tools.get("herdr_sweep").execute(
        "headless-cleanup-sweep-test",
        { execute: true },
        undefined,
        undefined,
        headlessContext(f.cwd),
      ),
      /requires either native TUI confirmation or confirm=true after the user has explicitly approved this exact dry-run inventory/i,
    );
    assert.equal(
      f.calls.some((args) => args[0] === "tab" && args[1] === "close"),
      false,
    );
    assert.equal(f.liveTabs.has("lane-tab"), true);
  } finally {
    await f.cleanup();
  }
});

test("confirmed cleanup retires tabs, removes the unopened worktree and branch, and updates session logs", async () => {
  const f = await fixture();
  try {
    const result = await sweep(f, true, true);
    assert.equal(result.details.swept, true);
    assert.equal(result.details.partialFailure, false);
    assert.deepEqual(result.details.retirementResults[0].closedTabIds, ["lane-tab"]);
    assert.equal(result.details.worktreeResults[0].removed, true);
    assert.equal(result.details.worktreeResults[0].branchRemoved, true);
    assert.equal(f.liveTabs.has("lane-tab"), false);
    await assert.rejects(git(f.cwd, "show-ref", "--verify", "refs/heads/orphan-branch"));
    const stored = JSON.parse(await readFile(f.manifestPath, "utf8"));
    assert.equal(stored.workflows[0].lanes[0].sessionLog.status, "retired");
    assert.equal(stored.workflows[0].laneRetirement.status, "retired");
    assert.equal(stored.workflows[1].lanes[0].sessionLog.status, "gone");
    assert.ok(stored.workflows[1].evidence.some((entry) => entry.kind === "cleanup-sweep-worktree-gone"));
  } finally {
    await f.cleanup();
  }
});

test("cleanup sweep lists and releases leases of finished or vanished workflows only", async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(f.manifestPath, "utf8"));
    const tabs = manifest.workflows.find((workflow) => workflow.id === "workflow-tabs");
    manifest.workflows.push({
      ...tabs,
      id: "workflow-live",
      status: "running",
      outcome: "running",
      lanes: [{ id: "lane-live", status: "running", paneId: "live-pane" }],
      ownership: { ...tabs.ownership, tabIds: [], paneIds: ["live-pane"] },
      evidence: [],
    });
    const lease = (id, workflowId, ports) => ({
      id, resource: "app", label: "default", kind: "port-block", ports,
      workflowId, laneId: "lane", state: "active", grantedBy: "dispatch", grantedAt: "t",
    });
    manifest.leases = [
      lease("lease-done", "workflow-tabs", [3600, 3601]),
      lease("lease-gone", "workflow-vanished", [3602, 3603]),
      lease("lease-live", "workflow-live", [3604, 3605]),
    ];
    await writeFile(f.manifestPath, JSON.stringify(manifest));

    const dryRun = await sweep(f, false);
    assert.deepEqual(
      dryRun.details.leases.map((item) => [item.leaseId, item.reason]),
      [["lease-done", "workflow completed"], ["lease-gone", "workflow no longer in the manifest"]],
    );
    assert.equal(
      JSON.parse(await readFile(f.manifestPath, "utf8")).leases.every((item) => item.state === "active"),
      true,
      "a dry run releases nothing",
    );

    const result = await sweep(f, true, true);
    assert.equal(result.details.partialFailure, false);
    const stored = JSON.parse(await readFile(f.manifestPath, "utf8"));
    const byId = Object.fromEntries(stored.leases.map((item) => [item.id, item]));
    assert.equal(byId["lease-done"].state, "released");
    assert.equal(byId["lease-done"].releaseReason, "lane tabs retired", "retiring the lane tabs frees the lease first");
    assert.equal(byId["lease-gone"].state, "released");
    assert.equal(byId["lease-gone"].releaseReason, "cleanup sweep");
    assert.deepEqual(result.details.releasedLeaseIds, ["lease-gone"]);
    assert.equal(byId["lease-live"].state, "active", "a running workflow keeps its lease");
    assert.ok(
      stored.workflows
        .find((workflow) => workflow.id === "workflow-tabs")
        .evidence.some((entry) => entry.kind === "lease-released"),
    );
  } finally {
    await f.cleanup();
  }
});

test("cleanup sweep records a dirty worktree and tab close failure without aborting remaining work", async () => {
  const f = await fixture({ dirty: true, failTab: true });
  try {
    const result = await sweep(f, true, true);
    assert.equal(result.details.partialFailure, true);
    assert.equal(result.details.worktreeResults.length, 0);
    assert.ok(result.details.errors.some((error) => error.resource === "lane-tabs"));
    assert.ok(result.details.errors.some((error) => error.resource === "worktree" && /dirty/i.test(error.error)));
    const stored = JSON.parse(await readFile(f.manifestPath, "utf8"));
    assert.ok(stored.workflows[0].evidence.some((entry) => entry.kind === "lane-retirement-tab-failed"));
    assert.ok(stored.workflows[1].evidence.some((entry) => entry.kind === "cleanup-sweep-worktree-retained"));
    await git(f.cwd, "show-ref", "--verify", "refs/heads/orphan-branch");
  } finally {
    await f.cleanup();
  }
});

test("cleanup sweep refuses a non-root caller", async () => {
  const f = await fixture();
  const previousPane = process.env.HERDR_PANE_ID;
  process.env.HERDR_PANE_ID = "child-pane";
  try {
    await assert.rejects(
      sweep(f, false),
      /cleanup sweep is root-only.*verified controller-mapped root/i,
    );
  } finally {
    process.env.HERDR_PANE_ID = previousPane;
    await f.cleanup();
  }
});
