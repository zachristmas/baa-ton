import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

test("a planned workflow from an earlier root session can be superseded; launched ones cannot", async () => {
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map((key) => [key, process.env[key]]),
  );
  const directory = await mkdtemp(join(tmpdir(), "baa-supersede-"));
  const configDir = join(directory, "config");
  const parent = join(directory, "parent");
  const stateDir = join(parent, ".baa-ton", "herdr-orchestrator");
  const manifestPath = join(stateDir, "manifest.json");
  const rootPane = "w-sup:p1";
  const root = { target: rootPane, target_kind: "pane_id", pane_id: rootPane, workspace_id: "w-sup", agent_kind: "pi" };
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const planned = (id, extra = {}) => ({
    id,
    objective: `Work ${id}`,
    status: "planned",
    outcome: "planned",
    taskBinding: { workspaceId: "w-sup", rootPaneId: rootPane, rootSessionPath: "/sessions/old-root.jsonl" },
    ownership: { createdBy: "herdr-orchestrator", tabIds: [], paneIds: [] },
    lanes: [{ id: "lane-1", status: "planned" }],
    evidence: [],
    ...extra,
  });
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 2,
      workflows: [
        planned("herdr-stale001"),
        planned("herdr-live0001", { status: "running", outcome: "running", lanes: [{ id: "lane-1", status: "running", paneId: "w-sup:p2" }] }),
        planned("herdr-fresh001", { taskBinding: { workspaceId: "w-sup", rootPaneId: rootPane, rootSessionPath: "/sessions/new-root.jsonl" } }),
      ],
      rootSessionLogs: [{
        rootId: "orchestrator-sup",
        root,
        kind: "root",
        status: "working",
        startedAt: "t",
        sessionRef: { provider: "pi", sessionId: "session-new", metadata: { sessionPath: "/sessions/new-root.jsonl" } },
      }],
      leases: [{
        id: "lease-1", resource: "app", label: "default", kind: "port-block", ports: [3600, 3601],
        workflowId: "herdr-stale001", laneId: "lane-1", state: "active", grantedBy: "dispatch", grantedAt: "t",
      }],
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      version: 2,
      owner: "herdr-orchestrator",
      orchestrators: [{ id: "orchestrator-sup", root, program: { id: parent, workspace_id: "w-sup", parent_manifest_path: manifestPath }, workflows: [] }],
    }),
    { mode: 0o600 },
  );
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: rootPane, HERDR_WORKSPACE_ID: "w-sup", HERDR_PLUGIN_CONFIG_DIR: configDir });
  const tools = new Map();
  extension({
    on() {},
    registerCommand() {},
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    async exec(command) {
      if (command !== "herdr") throw new Error(`Unexpected command: ${command}`);
      return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
    },
  });
  const ctx = { cwd: parent, mode: "json", hasUI: false, ui: { confirm: async () => false, notify() {} } };
  const supersede = (workflowId, reason = "Planned by the previous root session; re-planning.") =>
    tools.get("herdr_supersede").execute("supersede", { workflowId, reason }, undefined, undefined, ctx);
  try {
    const result = await supersede("herdr-stale001");
    assert.equal(result.details.staleRootSession, true);
    assert.equal(result.details.releasedLeases, 1);
    assert.match(result.content[0].text, /Superseded herdr-stale001 \(planned by an earlier root session\)/);
    const stored = JSON.parse(await readFile(manifestPath, "utf8"));
    const workflow = stored.workflows.find((item) => item.id === "herdr-stale001");
    assert.deepEqual([workflow.status, workflow.outcome, workflow.lanes[0].status], ["superseded", "superseded", "superseded"]);
    assert.ok(workflow.evidence.some((entry) => entry.kind === "workflow-superseded"));
    assert.equal(stored.leases[0].state, "released");

    await assert.rejects(supersede("herdr-live0001"), /only retires workflows that never started a lane\. Use herdr_close instead/);
    const fresh = await supersede("herdr-fresh001", "No longer needed.");
    assert.equal(fresh.details.staleRootSession, false, "a current-session plan can be superseded too, and is reported as current");
    await assert.rejects(supersede("herdr-fresh001"), /is superseded/, "superseding twice is refused");
    await assert.rejects(
      tools.get("herdr_supersede").execute("supersede", { workflowId: "herdr-stale001", reason: "  " }, undefined, undefined, ctx),
      /reason is required/,
    );

    // A superseded workflow no longer blocks a goal reset.
    await tools.get("herdr_goal").execute("goal", { action: "initialize", objective: "Goal." }, undefined, undefined, ctx);
    await assert.rejects(
      tools.get("herdr_goal").execute("goal", { action: "reset" }, undefined, undefined, ctx),
      /herdr-live0001/,
      "only the still-running workflow blocks it",
    );
    const blocking = (await tools.get("herdr_goal").execute("goal", { action: "reset" }, undefined, undefined, ctx).catch((error) => error)).message;
    assert.doesNotMatch(blocking, /herdr-stale001|herdr-fresh001/);
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  }
});
