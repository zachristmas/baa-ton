import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

test("the root records, reads and cancels its capacity gate without losing controller state", async () => {
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map((key) => [key, process.env[key]]),
  );
  const directory = await mkdtemp(join(tmpdir(), "baa-capacity-"));
  const configDir = join(directory, "config");
  const parent = join(directory, "parent");
  const manifestPath = join(parent, ".baa-ton", "herdr-orchestrator", "manifest.json");
  const rootPane = "w-cap:p1";
  await mkdir(join(parent, ".baa-ton", "herdr-orchestrator"), { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const controllerState = {
    rootId: "orchestrator-cap",
    alerts: [{ id: "alert-1", kind: "no-progress", text: "x", createdAt: "t", delivery: { status: "delivered", updatedAt: "t" } }],
    watchdog: { idleSince: "2026-09-23T00:00:00.000Z", alertedAt: "2026-09-23T00:31:00.000Z" },
  };
  await writeFile(manifestPath, JSON.stringify({ version: 2, workflows: [], rootSupervision: [controllerState] }), { mode: 0o600 });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      version: 2,
      owner: "herdr-orchestrator",
      orchestrators: [{
        id: "orchestrator-cap",
        root: { target: rootPane, target_kind: "pane_id", pane_id: rootPane, workspace_id: "w-cap", agent_kind: "pi" },
        program: { id: parent, workspace_id: "w-cap", parent_manifest_path: manifestPath, capacity_escalate_minutes: 10, watchdog_minutes: 45 },
        workflows: [],
      }],
    }),
    { mode: 0o600 },
  );
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: rootPane, HERDR_WORKSPACE_ID: "w-cap", HERDR_PLUGIN_CONFIG_DIR: configDir });
  const tools = new Map();
  extension({
    on() {},
    registerCommand() {},
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    async exec(command, args) {
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  });
  const call = (params) =>
    tools.get("herdr_capacity").execute("capacity", params, undefined, undefined, {
      cwd: parent,
      mode: "json",
      hasUI: false,
      ui: { confirm: async () => false, notify() {} },
    });
  const stored = async () => JSON.parse(await readFile(manifestPath, "utf8")).rootSupervision[0];
  try {
    await assert.rejects(call({ action: "wait", minFreeMemoryGb: 8 }), /reason is required/);
    await assert.rejects(call({ action: "wait", reason: "D19" }), /at least one of/);
    const waiting = await call({ action: "wait", reason: "dispatch D19 needs 8 GB", minFreeMemoryGb: 8, maxSwapUsedGb: 20 });
    assert.equal(waiting.details.gate.status, "waiting");
    assert.match(waiting.content[0].text, /\[waiting\] dispatch D19 needs 8 GB: free >= 8 GB, swap <= 20 GB/);
    assert.match(waiting.content[0].text, /a digest reports 'capacity available'/);
    assert.equal(typeof waiting.details.sample.freeMemoryGb, "number", "the live sample is shown");
    let entry = await stored();
    assert.deepEqual(entry.alerts, controllerState.alerts, "controller alerts survive an extension write");
    assert.deepEqual(entry.watchdog, controllerState.watchdog);
    assert.equal(entry.capacityGate.minFreeMemoryGb, 8);

    const status = await call({ action: "status" });
    assert.equal(status.details.gate.id, entry.capacityGate.id);
    const cancelled = await call({ action: "cancel" });
    assert.equal(cancelled.details.gate.status, "cancelled");
    entry = await stored();
    assert.ok(entry.capacityGate.cancelledAt);
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  }
});
