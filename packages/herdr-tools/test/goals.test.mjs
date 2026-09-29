import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

async function parentGoalFixture({ workflowStatus = "completed", workflowOutcome = "completed" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "baa-parent-goal-"));
  const cwd = join(directory, "task");
  const configDir = join(directory, "config");
  const manifestDir = join(cwd, ".baa-ton", "herdr-orchestrator");
  const manifestPath = join(manifestDir, "manifest.json");
  const root = {
    target: "w1:p1",
    target_kind: "pane_id",
    pane_id: "w1:p1",
    workspace_id: "w1",
    agent_kind: "pi",
  };
  const parentGoal = {
    version: 1,
    id: "parent-old",
    objective: "Finish the old round.",
    status: "completed",
    nextAction: "Review completion.",
    signals: [],
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
  await mkdir(manifestDir, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 2,
      parentGoal,
      workflows: [
        {
          id: "workflow-active",
          status: workflowStatus,
          outcome: workflowOutcome,
          lanes: [],
        },
      ],
    }),
  );
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      version: 2,
      owner: "herdr-orchestrator",
      orchestrators: [
        {
          id: "root",
          root,
          program: { id: cwd, workspace_id: "w1" },
          workflows: [],
        },
      ],
    }),
    { mode: 0o600 },
  );
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map(
      (key) => [key, process.env[key]],
    ),
  );
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_PANE_ID: root.pane_id,
    HERDR_WORKSPACE_ID: root.workspace_id,
    HERDR_PLUGIN_CONFIG_DIR: configDir,
  });
  const tools = new Map();
  extension({
    on() {},
    registerTool(descriptor) {
      tools.set(descriptor.name, descriptor);
    },
    registerCommand() {},
  });
  return {
    directory,
    cwd,
    manifestPath,
    tools,
    ctx: { cwd, hasUI: false, mode: "json" },
    restore() {
      for (const [key, value] of Object.entries(saved))
        value === undefined
          ? delete process.env[key]
          : (process.env[key] = value);
    },
    async cleanup() {
      this.restore();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("parent goal reset archives and clears the active record so a new round initializes", async () => {
  const fixture = await parentGoalFixture();
  try {
    const reset = await fixture.tools.get("herdr_goal").execute(
      "reset",
      { action: "reset" },
      undefined,
      undefined,
      fixture.ctx,
    );
    assert.deepEqual(reset.details, {
      reset: true,
      archivedGoalId: "parent-old",
      historyLength: 1,
    });
    const archivedManifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    assert.equal(archivedManifest.parentGoal, undefined);
    assert.equal(archivedManifest.goalHistory.length, 1);
    assert.equal(archivedManifest.goalHistory[0].version, 1);
    assert.equal(archivedManifest.goalHistory[0].id, "parent-old");
    assert.equal(archivedManifest.goalHistory[0].archivedAt.length > 0, true);

    const initialized = await fixture.tools.get("herdr_goal").execute(
      "initialize",
      { action: "initialize", objective: "Start the new round." },
      undefined,
      undefined,
      fixture.ctx,
    );
    assert.equal(initialized.details.goal.objective, "Start the new round.");
    const status = await fixture.tools.get("herdr_goal").execute(
      "status",
      { action: "status" },
      undefined,
      undefined,
      fixture.ctx,
    );
    assert.equal(status.details.goalHistoryCount, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("legacy single parent-goal manifests remain unchanged and root-scoped", async () => {
  const fixture = await parentGoalFixture();
  try {
    const before = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    const status = await fixture.tools.get("herdr_goal").execute(
      "legacy-status",
      { action: "status" },
      undefined,
      undefined,
      fixture.ctx,
    );
    assert.equal(status.details.goal.id, before.parentGoal.id);
    assert.equal(status.details.goal.objective, before.parentGoal.objective);
    assert.deepEqual(
      JSON.parse(await readFile(fixture.manifestPath, "utf8")),
      before,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("parent goal reset refuses active workflows unless force records a reason", async () => {
  const fixture = await parentGoalFixture({ workflowStatus: "running", workflowOutcome: "running" });
  try {
    await assert.rejects(
      fixture.tools.get("herdr_goal").execute(
        "reset-active",
        { action: "reset" },
        undefined,
        undefined,
        fixture.ctx,
      ),
      /non-terminal.*workflow-active/,
    );
    const forced = await fixture.tools.get("herdr_goal").execute(
      "reset-force",
      { action: "reset", force: true, reason: "Reconcile the stale parent round." },
      undefined,
      undefined,
      fixture.ctx,
    );
    assert.equal(forced.details.archivedGoalId, "parent-old");
    const archived = JSON.parse(await readFile(fixture.manifestPath, "utf8")).goalHistory[0];
    assert.equal(archived.force, true);
    assert.equal(archived.reason, "Reconcile the stale parent round.");
    assert.equal(JSON.parse(await readFile(fixture.manifestPath, "utf8")).parentGoal, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("forced root housekeeping reports a pass without archiving a synthetic running lane", async () => {
  const fixture = await parentGoalFixture({ workflowStatus: "running", workflowOutcome: "running" });
  try {
    const before = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    before.workflows[0].lanes.push({ id: "lane-live", status: "running", tabId: "w1:t2" });
    await writeFile(fixture.manifestPath, JSON.stringify(before));

    const result = await fixture.tools.get("herdr_housekeep").execute(
      "end-housekeeping",
      {},
      undefined,
      undefined,
      fixture.ctx,
    );

    assert.equal(result.details.forced, true);
    assert.deepEqual(result.details.archivedWorkflowIds, []);
    assert.equal(result.details.error, undefined);
    assert.match(result.content[0].text, /Forced housekeeping complete/);
    const after = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    assert.equal(after.workflows[0].status, "running");
    assert.equal(after.workflows[0].lanes.length, 1);
    assert.equal(after.workflows[0].lanes[0].status, "running");
    assert.equal(after.workflows[0].lanes[0].tabId, "w1:t2");
  } finally {
    await fixture.cleanup();
  }
});

test("planning records a versioned scoped goal graph and per-lane profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-goals-"));
  const cwd = join(directory, "task");
  const configDir = join(directory, "config");
  const manifestDir = join(cwd, ".baa-ton", "herdr-orchestrator");
  const manifestPath = join(manifestDir, "manifest.json");
  const saved = Object.fromEntries(
    [
      "HERDR_ENV",
      "HERDR_PANE_ID",
      "HERDR_WORKSPACE_ID",
      "HERDR_PLUGIN_CONFIG_DIR",
    ].map((key) => [key, process.env[key]]),
  );
  try {
    await mkdir(manifestDir, { recursive: true });
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({
        version: 2,
        owner: "herdr-orchestrator",
        orchestrators: [
          {
            id: "root",
            root: {
              target: "w1:p1",
              target_kind: "pane_id",
              pane_id: "w1:p1",
              workspace_id: "w1",
              agent_kind: "pi",
            },
            program: { id: cwd, workspace_id: "w1" },
            workflows: [],
          },
        ],
      }),
      { mode: 0o600 },
    );
    Object.assign(process.env, {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PLUGIN_CONFIG_DIR: configDir,
    });
    const tools = new Map();
    extension({
      on() {},
      registerTool(descriptor) {
        tools.set(descriptor.name, descriptor);
      },
      registerCommand() {},
      async exec(_command, args) {
        if (args[0] === "agent" && args[1] === "get")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                type: "agent_info",
                agent: {
                  agent: "pi",
                  pane_id: "w1:p1",
                  workspace_id: "w1",
                  agent_session: { kind: "path", value: join(cwd, "root-session.jsonl") },
                },
              },
            }),
          };
        throw new Error(`unexpected herdr ${args.join(" ")}`);
      },
    });
    await writeFile(join(cwd, "root-session.jsonl"), JSON.stringify({ type: "session", id: "01a0b04d-0bef-7207-b486-d51d62f0e3dc", cwd }) + "\n");
    const fallback = {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinking: "high",
      auth: "subscription",
    };
    const laneProfile = { ...fallback, thinking: "xhigh" };
    const result = await tools.get("herdr_plan").execute(
      "plan",
      {
        objective: "Build the scoped graph",
        launchProfile: fallback,
        lanes: [
          { objective: "Prepare", launchProfile: laneProfile },
          { objective: "Use preparation", dependencies: ["lane-1"] },
        ],
      },
      undefined,
      undefined,
      { cwd, hasUI: false, mode: "json", sessionManager: { getSessionId: () => "01a0b04d-0bef-7207-b486-d51d62f0e3dc", getSessionFile: () => join(cwd, "root-session.jsonl") } },
    );
    const workflow = result.details.workflow;
    assert.equal(workflow.goalSchemaVersion, 1);
    assert.equal(workflow.launchProfileVersion, 1);
    assert.equal(workflow.goals.length, 3);
    assert.equal(workflow.goals[0].ownership.authority, "authorized-root");
    assert.equal(workflow.goals[1].ownership.authority, "lane");
    assert.equal(workflow.goals[1].ownership.laneId, "lane-1");
    assert.deepEqual(workflow.goals[2].dependencies, [workflow.goals[1].id]);
    assert.equal(workflow.lanes[0].launchProfile.thinking, "xhigh");
    assert.equal(workflow.lanes[0].launchProfileVersion, 1);
    assert.equal(workflow.lanes[1].launchProfile, undefined);
    assert.deepEqual(
      JSON.parse(await readFile(manifestPath, "utf8")).workflows[0].goals,
      workflow.goals,
    );
  } finally {
    for (const [key, value] of Object.entries(saved))
      value === undefined
        ? delete process.env[key]
        : (process.env[key] = value);
    await rm(directory, { recursive: true, force: true });
  }
});
