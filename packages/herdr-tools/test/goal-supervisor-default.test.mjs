import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

test("a new goal, including after reset, is supervised unless the previous goal was explicitly paused", async () => {
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map((key) => [key, process.env[key]]),
  );
  const directory = await mkdtemp(join(tmpdir(), "baa-goal-default-"));
  const configDir = join(directory, "config");
  const parent = join(directory, "parent");
  const stateDir = join(parent, ".baa-ton", "herdr-orchestrator");
  const manifestPath = join(stateDir, "manifest.json");
  const rootPane = "w-goal:p1";
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(manifestPath, JSON.stringify({ version: 2, workflows: [] }), { mode: 0o600 });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      version: 2,
      owner: "herdr-orchestrator",
      orchestrators: [{
        id: "orchestrator-goal",
        root: { target: rootPane, target_kind: "pane_id", pane_id: rootPane, workspace_id: "w-goal", agent_kind: "pi" },
        program: { id: parent, workspace_id: "w-goal", parent_manifest_path: manifestPath },
        workflows: [],
      }],
    }),
    { mode: 0o600 },
  );
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: rootPane, HERDR_WORKSPACE_ID: "w-goal", HERDR_PLUGIN_CONFIG_DIR: configDir });
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
  const goal = async (params) =>
    (await tools.get("herdr_goal").execute("goal", params, undefined, undefined, ctx)).details.goal;
  const fresh = async (params = {}) => {
    await goal({ action: "reset" });
    return goal({ action: "initialize", objective: "Next goal.", ...params });
  };
  try {
    const first = await goal({ action: "initialize", objective: "First goal." });
    assert.equal(first.supervisor.state, "running", "no separate start call is needed");
    assert.equal(first.supervisor.intervalSeconds, 300);
    const due = Date.parse(first.supervisor.nextNudgeAt) - Date.parse(first.supervisor.createdAt);
    assert.equal(due, 300_000, "the first nudge is one interval out");

    await goal({ action: "start", nudgeIntervalSeconds: 120 });
    const afterReset = await fresh();
    assert.equal(afterReset.supervisor.state, "running", "the goal after a reset (parent-goal-73132480's case) is supervised");
    assert.equal(afterReset.supervisor.intervalSeconds, 120, "and keeps the previous interval");
    assert.ok(afterReset.supervisor.nextNudgeAt);

    await goal({ action: "pause", pauseReason: "Zach paused the run." });
    const afterPause = await fresh();
    assert.equal(afterPause.supervisor.state, "paused", "an explicit pause carries over");
    assert.equal(afterPause.supervisor.pauseReason, "Zach paused the run.");
    assert.equal(afterPause.supervisor.nextNudgeAt, null);

    // Setting the goal back to a live state ends the pause: it is supervised again.
    const blocked = await goal({ action: "set-state", status: "blocked", nextAction: "Recover the held items." });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.supervisor.state, "running", "a goal that left its pause is nudged again");
    assert.equal(blocked.supervisor.pauseReason, undefined);
    assert.ok(blocked.supervisor.nextNudgeAt, "with a nudge scheduled");

    await goal({ action: "start" });
    await goal({ action: "stop" });
    const afterStop = await fresh({ nudgeIntervalSeconds: 60 });
    assert.equal(afterStop.supervisor.state, "running", "a stop is not a pause");
    assert.equal(afterStop.supervisor.intervalSeconds, 60, "an explicit interval wins");
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  }
});
