import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

// Top-level keys a pre-#21 loadManifest carried through a save (974a77d).
const PRE_LANE_ADMIN_TOP_LEVEL = [
  "version", "workflows", "parentGoal", "questionRequests", "messageRequests", "sessionLog",
  "goalHistory", "parentGoals", "goalHistoryByRoot", "rootSessionLogs", "rootQueues", "queue",
];

test("the standing-policy acknowledgement survives goal resets, old-writer rewrites and stale saves", async () => {
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map((key) => [key, process.env[key]]),
  );
  const directory = await mkdtemp(join(tmpdir(), "baa-ack-"));
  const configDir = join(directory, "config");
  const parent = join(directory, "parent");
  const stateDir = join(parent, ".baa-ton", "herdr-orchestrator");
  const manifestPath = join(stateDir, "manifest.json");
  const ackPath = join(stateDir, "approval-policy-ack.json");
  const rootPane = "w-ack:p1";
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(parent, ".baa-ton", "config.json"),
    JSON.stringify({ version: 1, approvalPolicy: { version: 2, grants: ["dispatch", "retry", "resume"] } }),
  );
  await writeFile(manifestPath, JSON.stringify({ version: 2, workflows: [] }), { mode: 0o600 });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      version: 2,
      owner: "herdr-orchestrator",
      orchestrators: [{
        id: "orchestrator-ack",
        root: { target: rootPane, target_kind: "pane_id", pane_id: rootPane, workspace_id: "w-ack", agent_kind: "pi" },
        program: { id: parent, workspace_id: "w-ack", parent_manifest_path: manifestPath },
        workflows: [],
      }],
    }),
    { mode: 0o600 },
  );
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: rootPane, HERDR_WORKSPACE_ID: "w-ack", HERDR_PLUGIN_CONFIG_DIR: configDir });
  const tools = new Map();
  extension({
    on() {},
    registerCommand() {},
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    async exec(command, args) {
      if (command !== "herdr") throw new Error(`Unexpected command: ${command}`);
      if (args[0] === "pane" && args[1] === "current")
        return { code: 0, stderr: "", stdout: JSON.stringify({ result: { pane: { pane_id: rootPane, workspace_id: "w-ack" } } }) };
      if (args[0] === "agent" && args[1] === "get")
        return { code: 0, stderr: "", stdout: JSON.stringify({ type: "agent_info", agent: { agent: "pi", pane_id: rootPane, workspace_id: "w-ack", agent_status: "idle" } }) };
      return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
    },
  });
  const ctx = { cwd: parent, mode: "json", hasUI: false, ui: { confirm: async () => false, notify() {} } };
  const call = (name, params) => tools.get(name).execute(name, params, undefined, undefined, ctx);
  const acknowledged = async () => (await call("herdr_policy", { action: "show" })).details.acknowledged;
  const readManifest = async () => JSON.parse(await readFile(manifestPath, "utf8"));
  try {
    const acked = await call("herdr_policy", { action: "ack", confirm: true });
    assert.equal(acked.details.acknowledged, true);
    assert.equal(JSON.parse(await readFile(ackPath, "utf8")).hash, acked.details.ack.hash, "the ack has its own file");

    // The suspected path: reset the parent goal and start a new one.
    await call("herdr_goal", { action: "initialize", objective: "First goal." });
    await call("herdr_goal", { action: "reset" });
    assert.equal(await acknowledged(), true, "a goal reset keeps the acknowledgement");
    await call("herdr_goal", { action: "initialize", objective: "Second goal." });
    assert.equal(await acknowledged(), true, "a new goal keeps it too");
    assert.equal((await readManifest()).approvalPolicyAck?.hash, acked.details.ack.hash);

    // A pre-#21 writer (a lane dispatched before an upgrade) saves the
    // manifest with only the top-level keys it knew.
    const oldWriter = Object.fromEntries(
      Object.entries(await readManifest()).filter(([key]) => PRE_LANE_ADMIN_TOP_LEVEL.includes(key)),
    );
    assert.equal("approvalPolicyAck" in oldWriter, false);
    await writeFile(manifestPath, JSON.stringify(oldWriter));
    assert.equal(await acknowledged(), true, "an old-writer rewrite no longer loses it");
    await call("herdr_goal", { action: "set-state", status: "active", nextAction: "Continue." });
    assert.equal((await readManifest()).approvalPolicyAck?.hash, acked.details.ack.hash, "the next save restores the manifest copy");

    // A stale in-memory manifest saved without the ack.
    const stale = await readManifest();
    delete stale.approvalPolicyAck;
    await writeFile(manifestPath, JSON.stringify(stale));
    assert.equal(await acknowledged(), true, "a stale save no longer loses it");
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  }
});

test("after an acknowledgement, no reset, old-writer rewrite or root restart brings back the Record this policy dialog", async () => {
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map((key) => [key, process.env[key]]),
  );
  const directory = await mkdtemp(join(tmpdir(), "baa-ack-dialog-"));
  const configDir = join(directory, "config");
  const parent = join(directory, "parent");
  const stateDir = join(parent, ".baa-ton", "herdr-orchestrator");
  const manifestPath = join(stateDir, "manifest.json");
  const rootPane = "w-dlg:p1";
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(parent, ".baa-ton", "config.json"),
    JSON.stringify({ version: 1, approvalPolicy: { version: 2, grants: ["dispatch", "retry", "resume", "retire"] } }),
  );
  await writeFile(manifestPath, JSON.stringify({ version: 2, workflows: [] }), { mode: 0o600 });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      version: 2,
      owner: "herdr-orchestrator",
      orchestrators: [{
        id: "orchestrator-dlg",
        root: { target: rootPane, target_kind: "pane_id", pane_id: rootPane, workspace_id: "w-dlg", agent_kind: "pi" },
        program: { id: parent, workspace_id: "w-dlg", parent_manifest_path: manifestPath },
        workflows: [],
      }],
    }),
    { mode: 0o600 },
  );
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: rootPane, HERDR_WORKSPACE_ID: "w-dlg", HERDR_PLUGIN_CONFIG_DIR: configDir });
  const dialogs = [];
  // A root session: a fresh extension instance, as after a Pi restart.
  const startRoot = () => {
    const tools = new Map();
    extension({
      on() {},
      registerCommand() {},
      registerTool(definition) {
        tools.set(definition.name, definition);
      },
      async exec(command, args) {
        if (command !== "herdr") throw new Error(`Unexpected command: ${command}`);
        if (args[0] === "pane" && args[1] === "current")
          return { code: 0, stderr: "", stdout: JSON.stringify({ result: { pane: { pane_id: rootPane, workspace_id: "w-dlg" } } }) };
        if (args[0] === "agent" && args[1] === "get")
          return { code: 0, stderr: "", stdout: JSON.stringify({ type: "agent_info", agent: { agent: "pi", pane_id: rootPane, workspace_id: "w-dlg", agent_status: "idle" } }) };
        return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
      },
    });
    const ui = {
      async confirm(title, message) {
        dialogs.push(`${title}: ${message}`);
        return true;
      },
      async select() {
        throw new Error("no select dialog expected");
      },
      notify() {},
    };
    const ctx = { cwd: parent, mode: "tui", hasUI: true, ui };
    return (name, params) => tools.get(name).execute(name, params, undefined, undefined, ctx);
  };
  const recordDialogs = () => dialogs.filter((text) => /Record this policy\?/.test(text));
  try {
    let call = startRoot();
    const first = await call("herdr_policy", { action: "ack" });
    assert.equal(first.details.acknowledged, true);
    assert.equal(recordDialogs().length, 1, "the first acknowledgement is the one native dialog");

    const assertNoNewDialog = async (when) => {
      const again = await call("herdr_policy", { action: "ack" });
      assert.equal(again.details.unchanged, true, `${when}: already acknowledged`);
      assert.equal(recordDialogs().length, 1, `${when}: no Record this policy dialog`);
    };
    await call("herdr_goal", { action: "initialize", objective: "First goal." });
    await call("herdr_goal", { action: "reset" });
    await assertNoNewDialog("after a goal reset");
    await call("herdr_goal", { action: "initialize", objective: "Second goal." });
    await assertNoNewDialog("after a new goal");

    const oldWriter = Object.fromEntries(
      Object.entries(JSON.parse(await readFile(manifestPath, "utf8"))).filter(([key]) => PRE_LANE_ADMIN_TOP_LEVEL.includes(key)),
    );
    await writeFile(manifestPath, JSON.stringify(oldWriter));
    call = startRoot();
    await assertNoNewDialog("after an old-writer rewrite and a root restart");
    await call("herdr_goal", { action: "reset" });
    call = startRoot();
    await assertNoNewDialog("after a reset and another restart");
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  }
});
