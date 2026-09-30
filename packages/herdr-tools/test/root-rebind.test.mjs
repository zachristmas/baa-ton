import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, readdir, rm, writeFile, mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

const root = (paneId, workspaceId) => ({ target: paneId, target_kind: "pane_id", pane_id: paneId, workspace_id: workspaceId, agent_kind: "pi" });

// After a Herdr server restart: the root was w22:p1, its pane is gone, and
// the same Pi session came back as w2J:p1.
async function fixture({ liveSession = "sess-01a0cc67", samePane = false, concurrent = false, ambiguous = false, oldPaneError = false, withFinishedLane = false, parkedGoal = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "baa-root-rebind-")));
  const cwd = join(directory, "project");
  const configDir = join(directory, "config");
  const manifestDir = join(cwd, ".baa-ton", "herdr-orchestrator");
  const manifestPath = join(manifestDir, "manifest.json");
  const oldRoot = root("w22:p1", "w22");
  const newRoot = samePane ? oldRoot : root("w2J:p1", "w2J");
  const oldId = `orchestrator:w22:w22:p1:${cwd}`;
  const otherRoot = root("w-other:p1", "w-other");
  const ambiguousRoot = root("w-gone:p1", "w-gone");
  const otherId = `orchestrator:w-other:w-other:p1:${cwd}`;
  const ambiguousId = `orchestrator:w-gone:w-gone:p1:${cwd}`;
  const config = {
    version: 2,
    owner: "herdr-orchestrator",
    orchestrators: [
      { id: oldId, root: oldRoot, program: { id: cwd, workspace_id: "w22", parent_manifest_path: manifestPath }, workflows: [] },
      ...(concurrent ? [{ id: otherId, root: otherRoot, program: { id: cwd, workspace_id: "w-other", parent_manifest_path: manifestPath }, workflows: [{ workflow_id: "herdr-other-live", manifest_path: manifestPath, lanes: [{ lane_id: "other-lane", target: "w-other:p9", target_kind: "pane_id", pane_id: "w-other:p9", workspace_id: "w-other" }] }] }] : []),
      ...(ambiguous ? [{ id: ambiguousId, root: ambiguousRoot, program: { id: cwd, workspace_id: "w-gone", parent_manifest_path: manifestPath }, workflows: [] }] : []),
    ],
  };
  const finished = withFinishedLane ? {
    id: "herdr-finished-old",
    status: "completed",
    updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString(),
    taskBinding: { rootPaneId: oldRoot.pane_id, workspaceId: oldRoot.workspace_id },
    ownership: { createdBy: "herdr-orchestrator", paneIds: ["w22:p9"] },
    lanes: [{ id: "lane-done", status: "running", paneId: "w22:p9", tabId: "w22:t9", completionReceipt: { id: "receipt-done", summary: "finished", delivery: "delivered" }, sessionLog: { kind: "lane", status: "completed", paneId: "w22:p9", workspaceId: "w22" } }],
    evidence: [],
  } : undefined;
  const archiveReady = withFinishedLane ? Array.from({ length: 101 }, (_, index) => ({
    id: `herdr-archive-${String(index).padStart(4, "0")}`,
    status: "completed",
    updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString(),
    taskBinding: { rootPaneId: oldRoot.pane_id, workspaceId: oldRoot.workspace_id },
    lanes: [{ id: `archive-lane-${index}`, status: "completion-reported", tabId: `w22:t${index + 20}`, retirement: { status: "retired", tabClosed: true }, sessionLog: { kind: "lane", status: "retired" } }],
    evidence: [],
  })) : [];
  const manifest = {
    version: 2,
    // A lane that was running when Herdr restarted: not quiescent, ended with its pane.
    workflows: [
      { id: "herdr-live", status: "running", taskBinding: { rootPaneId: "w22:p1", workspaceId: "w22" }, lanes: [{ id: "lane-1", status: "working", paneId: "w22:p9" }], ownership: { paneIds: ["w22:p9"] }, evidence: [] },
      ...(finished ? [finished] : []),
      ...archiveReady,
      ...(concurrent ? [{ id: "herdr-other-live", status: "running", taskBinding: { rootPaneId: otherRoot.pane_id, workspaceId: otherRoot.workspace_id }, lanes: [{ id: "other-lane", status: "working" }], evidence: [] }] : []),
    ],
    parentGoals: {
      [oldId]: { rootId: oldId, root: oldRoot, objective: "Continue the previous unfinished goal", status: parkedGoal ? "parked" : "active", nextAction: "resume safe work", ...(parkedGoal ? { supervisor: { version: 1, state: "stopped", intervalSeconds: 300, nudgeCount: 0, nextNudgeAt: null, createdAt: "2026-09-27T02:00:00.000Z", updatedAt: "2026-09-27T02:00:00.000Z" } } : {}) },
      ...(concurrent ? { [otherId]: { rootId: otherId, root: otherRoot, objective: "Concurrent root goal", status: "active", nextAction: "continue" } } : {}),
    },
    ...(withFinishedLane ? { leases: [{ id: "lease-dead", resource: "port", number: 43210, workflowId: finished.id, laneId: "lane-done", state: "active" }] } : {}),
    ...(parkedGoal ? { rootSupervision: [{ rootId: oldId, rootParkedAt: "2026-09-27T02:00:00.000Z", alerts: [] }] } : {}),
    rootSessionLogs: [
      { rootId: oldId, root: oldRoot, kind: "root", sessionRef: { provider: "pi", sessionId: "sess-01a0cc67", nativeHandle: { kind: "id", value: "sess-01a0cc67" } }, startedAt: "2026-09-27T02:00:00.000Z", status: "idle", paneId: "w22:p1", workspaceId: "w22" },
      ...(concurrent ? [{ rootId: otherId, root: otherRoot, kind: "root", sessionRef: { provider: "pi", sessionId: "other-session", nativeHandle: { kind: "id", value: "other-session" } }, startedAt: "2026-09-27T02:00:00.000Z", status: "idle", paneId: otherRoot.pane_id, workspaceId: otherRoot.workspace_id }] : []),
      ...(ambiguous ? [{ rootId: ambiguousId, root: ambiguousRoot, kind: "root", sessionRef: { provider: "pi", sessionId: liveSession, nativeHandle: { kind: "id", value: liveSession } }, startedAt: "2026-09-27T02:00:00.000Z", status: "idle", paneId: ambiguousRoot.pane_id, workspaceId: ambiguousRoot.workspace_id }] : []),
    ],
  };
  await mkdir(manifestDir, { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(configDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const saved = Object.fromEntries(["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR", "CLAUDE_CODE_SESSION_ID", "BAA_TON_NO_PROCESS_SWEEP"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: newRoot.pane_id, HERDR_WORKSPACE_ID: newRoot.workspace_id, HERDR_PLUGIN_CONFIG_DIR: configDir });
  delete process.env.CLAUDE_CODE_SESSION_ID;
  const tools = new Map();
  extension({
    on() {},
    registerCommand() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    async exec(_command, args) {
      const ok = (result) => ({ code: 0, stderr: "", stdout: JSON.stringify({ result }) });
      if (args[0] === "plugin" && args[1] === "config-dir") return ok({ config_dir: configDir });
      if (args[0] === "workspace" && args[1] === "list") return ok({ workspaces: [{ workspace_id: newRoot.workspace_id }, ...(concurrent ? [{ workspace_id: "w-other" }] : [])] });
      if (args[0] === "agent" && args[1] === "get") {
        if (args[2] === newRoot.pane_id)
          return ok({ type: "agent_info", agent: { agent: "pi", name: "pi-root", pane_id: newRoot.pane_id, workspace_id: newRoot.workspace_id, agent_session: { kind: "id", value: liveSession }, agent_status: "idle" } });
        if (oldPaneError && args[2] === oldRoot.pane_id)
          return { code: 1, stderr: "", stdout: JSON.stringify({ error: { code: "internal_error", message: "pane probe unavailable" } }) };
        if (concurrent && args[2] === otherRoot.pane_id)
          return ok({ type: "agent_info", agent: { agent: "pi", name: "other-root", pane_id: otherRoot.pane_id, workspace_id: otherRoot.workspace_id, agent_session: { kind: "id", value: "other-session" }, agent_status: "idle" } });
        return { code: 1, stderr: "", stdout: JSON.stringify({ error: { code: "agent_not_found", message: `agent target ${args[2]} not found` } }) };
      }
      if (args[0] === "pane" && args[1] === "get") return ok({ pane: { tab_id: `${newRoot.workspace_id}:t1` } });
      if (args[0] === "pane" && args[1] === "list") return ok({ panes: [] });
      if (args[0] === "tab" && ["rename", "close"].includes(args[1])) return ok({});
      throw new Error(`Unexpected Herdr command: ${args.join(" ")}`);
    },
  });
  return {
    cwd,
    newRoot,
    oldId,
    tools,
    context: { cwd, hasUI: false, mode: "json", modelRegistry: {} },
    config: async () => JSON.parse(await readFile(join(configDir, "config.json"), "utf8")),
    manifest: async () => JSON.parse(await readFile(manifestPath, "utf8")),
    async cleanup() {
      for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("after a Herdr restart, reconcile rebinds the project's root to its new pane when the same session runs there", async () => {
  const f = await fixture();
  try {
    const result = await f.tools.get("herdr_reconcile_root").execute("reconcile", {}, undefined, undefined, f.context);
    assert.equal(result.details.reconciled, true);
    assert.match(result.content[0].text, /Rebound root orchestrator:w22:w22:p1:.* \(w22:p1 -> w2J:p1\): Herdr restart/);
    const config = await f.config();
    assert.equal(config.orchestrators.length, 1, "one orchestrator for the project, never two");
    assert.equal(config.orchestrators[0].root.pane_id, "w2J:p1");
    assert.equal(config.orchestrators[0].id, `orchestrator:w2J:w2J:p1:${f.cwd}`);
    const manifest = await f.manifest();
    assert.equal(manifest.rootSessionLogs.find((entry) => entry.rootId === config.orchestrators[0].id).paneId, "w2J:p1");
    assert.equal(manifest.workflows[0].taskBinding.rootPaneId, "w22:p1", "old workflows stay historical");
  } finally {
    await f.cleanup();
  }
});

test("plain baa-ton-start bootstrap automatically rebinds the exact gone root and adopts its unfinished goal", async () => {
  const f = await fixture();
  try {
    const result = await f.tools.get("herdr_bootstrap_root").execute("start", {}, undefined, undefined, f.context);
    assert.equal(result.details.alreadyRegistered, true);
    const config = await f.config();
    assert.equal(config.orchestrators.length, 1);
    assert.equal(config.orchestrators[0].root.pane_id, f.newRoot.pane_id);
    const manifest = await f.manifest();
    const newId = config.orchestrators[0].id;
    assert.equal(manifest.parentGoals[newId].objective, "Continue the previous unfinished goal");
    assert.equal(manifest.parentGoals["orchestrator:w22:w22:p1:" + f.cwd], undefined);
    assert.equal(manifest.workflows[0].taskBinding.rootPaneId, "w22:p1", "historical workflow binding is retained");
  } finally {
    await f.cleanup();
  }
});

test("bootstrap is the documented recovery path that resumes a parked root after exact identity reconciliation", async () => {
  const f = await fixture({ parkedGoal: true });
  try {
    await f.tools.get("herdr_bootstrap_root").execute("start", {}, undefined, undefined, f.context);
    const config = await f.config();
    const manifest = await f.manifest();
    const newId = config.orchestrators[0].id;
    assert.equal(manifest.parentGoals[newId].status, "active");
    assert.equal(manifest.parentGoals[newId].supervisor.state, "running");
    assert.ok(manifest.parentGoals[newId].supervisor.nextNudgeAt);
    assert.equal(manifest.rootSupervision.find((entry) => entry.rootId === newId).rootParkedAt, undefined);
  } finally {
    await f.cleanup();
  }
});

test("verified bootstrap clears a stale parked marker and restores an active supervisor", async () => {
  const f = await fixture({ parkedGoal: true });
  try {
    const manifest = await f.manifest();
    manifest.parentGoals[f.oldId].status = "paused";
    manifest.parentGoals[f.oldId].supervisor.state = "paused";
    manifest.parentGoals[f.oldId].supervisor.nextNudgeAt = null;
    await writeFile(join(f.cwd, ".baa-ton", "herdr-orchestrator", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await f.tools.get("herdr_bootstrap_root").execute("start", {}, undefined, undefined, f.context);
    const config = await f.config();
    const recovered = await f.manifest();
    const newId = config.orchestrators[0].id;
    assert.equal(recovered.parentGoals[newId].status, "active");
    assert.equal(recovered.parentGoals[newId].supervisor.state, "running");
    assert.ok(recovered.parentGoals[newId].supervisor.nextNudgeAt);
    assert.equal(recovered.rootSupervision.find((entry) => entry.rootId === newId).rootParkedAt, undefined);
  } finally {
    await f.cleanup();
  }
});

test("plain bootstrap recognizes a replacement session on the exact same registered pane", async () => {
  const f = await fixture({ samePane: true, liveSession: "replacement-session" });
  try {
    await f.tools.get("herdr_bootstrap_root").execute("start", {}, undefined, undefined, f.context);
    const config = await f.config();
    assert.equal(config.orchestrators.length, 1);
    const manifest = await f.manifest();
    const log = manifest.rootSessionLogs.find((entry) => entry.rootId === f.oldId);
    assert.equal(log.sessionRef.sessionId, "replacement-session");
    assert.equal(manifest.workflows[0].taskBinding.rootPaneId, "w22:p1");
    assert.equal(manifest.parentGoals[f.oldId].objective, "Continue the previous unfinished goal");
  } finally {
    await f.cleanup();
  }
});

test("recovery immediately cleans only the recovered root, retires dead finished lanes, releases their leases, and archives eligible history", async () => {
  const f = await fixture({ concurrent: true, withFinishedLane: true });
  process.env.BAA_TON_NO_PROCESS_SWEEP = "1";
  try {
    await f.tools.get("herdr_bootstrap_root").execute("start", {}, undefined, undefined, f.context);
    const config = await f.config();
    assert.equal(config.orchestrators.length, 2);
    assert.equal(config.orchestrators.find((entry) => entry.id === "orchestrator:w-other:w-other:p1:" + f.cwd).root.pane_id, "w-other:p1");
    const manifest = await f.manifest();
    const finished = manifest.workflows.find((workflow) => workflow.id === "herdr-finished-old");
    assert.equal(finished.lanes[0].status, "completion-reported", "running record is reconciled from retired-session proof");
    assert.equal(finished.lanes[0].retirement.status, "retired");
    assert.equal(manifest.leases.find((lease) => lease.id === "lease-dead").state, "released");
    assert.ok(manifest.workflows.some((workflow) => workflow.id === "herdr-other-live"), "the concurrent root's workflow remains live");
    assert.equal(manifest.parentGoals["orchestrator:w-other:w-other:p1:" + f.cwd].objective, "Concurrent root goal");
    const archiveDir = join(f.cwd, ".baa-ton", "herdr-orchestrator", "archive");
    const archiveNames = await readdir(archiveDir);
    const archived = (await readFile(join(archiveDir, archiveNames[0]), "utf8")).trim().split("\n").map((line) => JSON.parse(line).workflow.id);
    assert.equal(archived.length, 1, "the normal keep-recent policy remains scoped to the recovered root");
    assert.match(archived[0], /^herdr-archive-/);
    assert.ok(manifest.workflows.filter((workflow) => workflow.id.startsWith("herdr-archive-")).length >= 100);
  } finally {
    await f.cleanup();
  }
});

test("recovery fails closed when the old pane liveness probe is not authoritative", async () => {
  const f = await fixture({ oldPaneError: true });
  try {
    await assert.rejects(
      f.tools.get("herdr_reconcile_root").execute("unproven", {}, undefined, undefined, f.context),
      /not a registered root/,
    );
    assert.equal((await f.config()).orchestrators[0].root.pane_id, "w22:p1");
    assert.equal((await f.manifest()).rootSessionLogs[0].paneId, "w22:p1");
  } finally {
    await f.cleanup();
  }
});

test("recovery fails closed when multiple gone roots make the prior identity ambiguous", async () => {
  const f = await fixture({ ambiguous: true });
  try {
    await assert.rejects(
      f.tools.get("herdr_reconcile_root").execute("ambiguous", {}, undefined, undefined, f.context),
      /not a registered root/,
    );
    assert.equal((await f.config()).orchestrators.length, 2);
    assert.equal((await f.manifest()).rootSessionLogs.length, 2);
  } finally {
    await f.cleanup();
  }
});

test("a gone root that ran another session is not rebound automatically, and bootstrap add never adds a second orchestrator beside it", async () => {
  const f = await fixture({ liveSession: "some-other-session" });
  try {
    await assert.rejects(
      f.tools.get("herdr_reconcile_root").execute("reconcile", {}, undefined, undefined, f.context),
      /is gone, but it ran another session \(sess-01a0cc67\), so it is not rebound automatically; herdr_recover_root/,
    );
    await assert.rejects(
      f.tools.get("herdr_bootstrap_root").execute("bootstrap", { add: true }, undefined, undefined, f.context),
      /root orchestrator:w22:w22:p1:.* is gone \(pane w22:p1 no longer exists\)\. Call herdr_reconcile_root/,
    );
    assert.equal((await f.config()).orchestrators.length, 1);
  } finally {
    await f.cleanup();
  }
});
