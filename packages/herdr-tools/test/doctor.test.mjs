import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "baa-doctor-"));
  const cwd = join(directory, "task");
  const configDir = join(directory, "config");
  await mkdir(cwd, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  return { directory, cwd, configDir };
}

test("herdr_doctor reports a healthy installation and never mutates the manifest", async () => {
  const { directory, cwd, configDir } = await fixture();
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map(
      (key) => [key, process.env[key]],
    ),
  );
  try {
    const manifestPath = join(cwd, ".baa-ton", "herdr-orchestrator", "manifest.json");
    await mkdir(join(cwd, ".baa-ton", "herdr-orchestrator"), { recursive: true });
    const manifest = { version: 2, workflows: [] };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const before = await readFile(manifestPath, "utf8");
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
        if (args[0] === "plugin" && args[1] === "config-dir")
          return { code: 0, stderr: "", stdout: configDir };
        throw new Error(`unexpected herdr ${args.join(" ")}`);
      },
    });
    const ctx = {
      cwd,
      hasUI: false,
      mode: "json",
      modelRegistry: {
        find: () => ({ reasoning: true, thinkingLevelMap: {} }),
        hasConfiguredAuth: () => true,
        isUsingOAuth: () => true,
      },
    };
    const report = await tools
      .get("herdr_doctor")
      .execute("doctor", {}, undefined, undefined, ctx);
    const checkIds = report.details.checks.map((entry) => entry.id).sort();
    assert.deepEqual(checkIds, [
      "adapter-registry-capability-matrix",
      "codex-sandbox-git-metadata-writability",
      "extension-source",
      "lane-bridge-liveness",
      "manifest-store",
      "native-herdr-connectivity",
      "plugin-enablement-and-routing",
      "root-identity",
      "state-location",
    ]);
    assert.equal(report.details.ok, true);
    for (const entry of report.details.checks)
      assert.notEqual(entry.status, "fail", `${entry.id}: ${entry.detail}`);
    const manifestCheck = report.details.checks.find(
      (entry) => entry.id === "manifest-store",
    );
    assert.match(manifestCheck.detail, /Version 2 manifest/);
    const after = await readFile(manifestPath, "utf8");
    assert.equal(after, before, "doctor must never write the manifest");
  } finally {
    for (const [key, value] of Object.entries(saved))
      value === undefined
        ? delete process.env[key]
        : (process.env[key] = value);
    await rm(directory, { recursive: true, force: true });
  }
});

test("doctor refreshes a stale config-dir snapshot before synchronous root routing checks", async () => {
  const { directory, cwd, configDir } = await fixture();
  const frozenConfigDir = join(directory, "frozen-config");
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map(
      (key) => [key, process.env[key]],
    ),
  );
  try {
    const manifestDir = join(cwd, ".baa-ton", "herdr-orchestrator");
    await mkdir(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({ version: 2, workflows: [] }));
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({
        version: 2,
        owner: "herdr-orchestrator",
        orchestrators: [
          {
            id: "root-a",
            root: {
              target: "w1:p1",
              target_kind: "pane_id",
              pane_id: "w1:p1",
              workspace_id: "w1",
              agent_kind: "pi",
            },
            program: {
              id: cwd,
              workspace_id: "w1",
              parent_manifest_path: manifestPath,
            },
            workflows: [],
          },
        ],
      }),
    );
    Object.assign(process.env, {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PLUGIN_CONFIG_DIR: frozenConfigDir,
    });
    const tools = new Map();
    extension({
      on() {},
      registerTool(descriptor) {
        tools.set(descriptor.name, descriptor);
      },
      registerCommand() {},
      async exec(_command, args) {
        if (args[0] === "plugin" && args[1] === "config-dir")
          return { code: 0, stderr: "", stdout: configDir };
        throw new Error(`unexpected herdr ${args.join(" ")}`);
      },
    });
    const report = await tools
      .get("herdr_doctor")
      .execute("doctor", {}, undefined, undefined, {
        cwd,
        hasUI: false,
        mode: "json",
        modelRegistry: {
          find: () => ({ reasoning: true, thinkingLevelMap: {} }),
          hasConfiguredAuth: () => true,
          isUsingOAuth: () => true,
        },
      });
    const routing = report.details.checks.find(
      (entry) => entry.id === "plugin-enablement-and-routing",
    );
    assert.equal(routing.status, "ok");
    assert.match(routing.detail, /This pane is a registered root/);
    assert.equal(process.env.HERDR_PLUGIN_CONFIG_DIR, configDir);
  } finally {
    for (const [key, value] of Object.entries(saved))
      value === undefined
        ? delete process.env[key]
        : (process.env[key] = value);
    await rm(directory, { recursive: true, force: true });
  }
});

test("herdr_doctor fails closed when native Herdr connectivity is unavailable", async () => {
  const { directory, cwd, configDir } = await fixture();
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map(
      (key) => [key, process.env[key]],
    ),
  );
  try {
    const manifestDir = join(cwd, ".baa-ton", "herdr-orchestrator");
    await mkdir(manifestDir, { recursive: true });
    // loadManifest() falls back to {version:2, workflows:[]} for any version
    // other than 1 or 2, so a legacy/future version is invisible today.
    await writeFile(
      join(manifestDir, "manifest.json"),
      JSON.stringify({ version: 2, workflows: [] }),
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
        if (args[0] === "plugin" && args[1] === "config-dir")
          throw new Error("plugin config-dir: no such plugin");
        throw new Error(`unexpected herdr ${args.join(" ")}`);
      },
    });
    const ctx = { cwd, hasUI: false, mode: "json", modelRegistry: {} };
    const report = await tools
      .get("herdr_doctor")
      .execute("doctor", {}, undefined, undefined, ctx);
    assert.equal(report.details.ok, false);
    const connectivity = report.details.checks.find(
      (entry) => entry.id === "native-herdr-connectivity",
    );
    assert.equal(connectivity.status, "fail");
    const routing = report.details.checks.find(
      (entry) => entry.id === "plugin-enablement-and-routing",
    );
    assert.equal(
      routing.status,
      "fail",
      "routing cannot be checked without connectivity",
    );
  } finally {
    for (const [key, value] of Object.entries(saved))
      value === undefined
        ? delete process.env[key]
        : (process.env[key] = value);
    await rm(directory, { recursive: true, force: true });
  }
});

test("doctor reads the routed manifest and normalizes identity-bound Pi tool attestations", async () => {
  const { directory, cwd, configDir } = await fixture();
  const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1", HERDR_PLUGIN_CONFIG_DIR: configDir };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, env);
    const manifestDir = join(cwd, ".baa-ton", "herdr-orchestrator");
    await mkdir(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, "manifest.json");
    const startup = join(manifestDir, "startup.json");
    const manifest = JSON.stringify({ version: 2, workflows: [{ id: "workflow-a", lanes: [{ id: "lane-a", startupIntentPath: startup, startupNonce: "nonce-a" }] }] });
    await writeFile(manifestPath, manifest);
    const root = { target: "w1:p1", target_kind: "pane_id", pane_id: "w1:p1", workspace_id: "w1", agent_kind: "pi" };
    await writeFile(join(configDir, "config.json"), JSON.stringify({ version: 2, owner: "herdr-orchestrator", orchestrators: [{ id: "root-a", root, program: { id: cwd, workspace_id: "w1", parent_manifest_path: manifestPath }, workflows: [{ workflow_id: "workflow-a", manifest_path: manifestPath, lanes: [{ lane_id: "lane-a", target: "w1:p2", target_kind: "pane_id", pane_id: "w1:p2", workspace_id: "w1" }] }] }] }));
    const tools = new Map();
    const agent = { agent: "pi", pane_id: "w1:p2", workspace_id: "w1", interactive_ready: true, agent_session: { kind: "path", value: "/tmp/session-a" } };
    extension({ on() {}, registerCommand() {}, registerTool: tool => tools.set(tool.name, tool), async exec(_command, args) {
      if (args[0] === "plugin" && args[1] === "config-dir") return { code: 0, stderr: "", stdout: configDir };
      if (args[0] === "agent" && args[1] === "get") return { code: 0, stderr: "", stdout: JSON.stringify({ result: { agent } }) };
      throw new Error(`unexpected command: ${args}`);
    } });
    const ctx = { cwd, hasUI: false, modelRegistry: {} };
    const ready = { nonce: "nonce-a", paneId: "w1:p2", workspaceId: "w1", sessionPath: "/tmp/session-a", tools: ["herdr_plan", "herdr_dispatch", "herdr_complete"] };
    async function check(attestation) {
      await writeFile(`${startup}.ready`, JSON.stringify(attestation));
      const report = await tools.get("herdr_doctor").execute("doctor", {}, undefined, undefined, ctx);
      return report.details.checks.find(check => check.id === "lane-bridge-liveness");
    }
    assert.equal((await check(ready)).status, "ok");
    for (const invalid of [{ ...ready, nonce: "stale" }, { ...ready, paneId: "other" }, { ...ready, workspaceId: "other" }, { ...ready, sessionPath: "/tmp/other" }, { ...ready, tools: ["herdr_plan"] }]) {
      assert.equal((await check(invalid)).status, "warn");
    }
    agent.agent = "codex";
    assert.equal((await check({ operations: ["plan", "dispatch", "complete"] })).status, "ok");
    agent.pane_id = "different-pane";
    assert.equal((await check(ready)).status, "fail");
    assert.equal(await readFile(manifestPath, "utf8"), manifest);
  } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  }
});

test("lane-bridge-liveness tolerates gone panes only with durable completion receipts", async () => {
  const { directory, cwd, configDir } = await fixture();
  const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1", HERDR_PLUGIN_CONFIG_DIR: configDir };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, env);
    const manifestDir = join(cwd, ".baa-ton", "herdr-orchestrator");
    await mkdir(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, "manifest.json");
    const startup = join(manifestDir, "startup.json");
    const root = { target: "w1:p1", target_kind: "pane_id", pane_id: "w1:p1", workspace_id: "w1", agent_kind: "pi" };
    // Two mapped lanes: lane-live (w1:p2, alive) and lane-gone (w1:p3, pane removed).
    await writeFile(join(configDir, "config.json"), JSON.stringify({ version: 2, owner: "herdr-orchestrator", orchestrators: [{ id: "root-a", root, program: { id: cwd, workspace_id: "w1", parent_manifest_path: manifestPath }, workflows: [{ workflow_id: "workflow-a", manifest_path: manifestPath, lanes: [
      { lane_id: "lane-live", target: "w1:p2", target_kind: "pane_id", pane_id: "w1:p2", workspace_id: "w1" },
      { lane_id: "lane-gone", target: "w1:p3", target_kind: "pane_id", pane_id: "w1:p3", workspace_id: "w1" },
    ] }] }] }));
    const liveAgent = { agent: "pi", pane_id: "w1:p2", workspace_id: "w1", interactive_ready: true, agent_session: { kind: "path", value: "/tmp/session-a" } };
    await writeFile(`${startup}.ready`, JSON.stringify({ nonce: "nonce-a", paneId: "w1:p2", workspaceId: "w1", sessionPath: "/tmp/session-a", tools: ["herdr_plan", "herdr_dispatch", "herdr_complete"] }));
    let goneResult = { code: 1, stderr: "", stdout: JSON.stringify({ error: { code: "agent_not_found", message: "agent target w1:p3 not found" }, id: "cli:agent:get" }) };
    const tools = new Map();
    extension({ on() {}, registerCommand() {}, registerTool: tool => tools.set(tool.name, tool), async exec(_command, args) {
      if (args[0] === "plugin" && args[1] === "config-dir") return { code: 0, stderr: "", stdout: configDir };
      if (args[0] === "agent" && args[1] === "get" && args[2] === "w1:p2") return { code: 0, stderr: "", stdout: JSON.stringify({ result: { agent: liveAgent } }) };
      if (args[0] === "agent" && args[1] === "get" && args[2] === "w1:p3") return goneResult;
      throw new Error(`unexpected command: ${args}`);
    } });
    const ctx = { cwd, hasUI: false, modelRegistry: {} };
    async function check(goneLane) {
      await writeFile(manifestPath, JSON.stringify({ version: 2, workflows: [{ id: "workflow-a", lanes: [
        { id: "lane-live", startupIntentPath: startup, startupNonce: "nonce-a" },
        goneLane,
      ] }] }));
      const report = await tools.get("herdr_doctor").execute("doctor", {}, undefined, undefined, ctx);
      return report.details.checks.find(entry => entry.id === "lane-bridge-liveness");
    }

    // Completed + missing pane: durable receipt with id and summary -> warn.
    const receipted = await check({ id: "lane-gone", status: "done", completionReceipt: { id: "receipt-b", summary: "Reviewed README", delivery: "delivered" } });
    assert.equal(receipted.status, "warn");
    assert.match(receipted.detail, /lane-live \(w1:p2\) native\/bridge evidence present/);
    assert.match(receipted.detail, /lane-gone \(w1:p3\) pane is gone; lane has durable completion receipt receipt-b/);

    // Unfinished + missing pane: no receipt -> fail even with terminal status.
    const terminalOnly = await check({ id: "lane-gone", status: "done" });
    assert.equal(terminalOnly.status, "fail");
    assert.match(terminalOnly.detail, /lane-gone pane w1:p3 is gone without a durable completion receipt/);

    // Receipt missing a summary is not durable evidence -> fail.
    const emptySummary = await check({ id: "lane-gone", status: "done", completionReceipt: { id: "receipt-b", summary: "", delivery: "delivered" } });
    assert.equal(emptySummary.status, "fail");
    assert.match(emptySummary.detail, /without a durable completion receipt/);

    for (const receipt of [{ id: "", summary: "Done" }, { id: "receipt-b", summary: "   " }]) {
      assert.equal((await check({ id: "lane-gone", completionReceipt: receipt })).status, "fail");
    }

    // Unrelated CLI errors must still fail, receipt or not.
    goneResult = { code: 1, stderr: "", stdout: JSON.stringify({ error: { code: "internal_error", message: "agent_not_found lookup failed: socket unavailable" }, id: "cli:agent:get" }) };
    const unrelated = await check({ id: "lane-gone", status: "done", completionReceipt: { id: "receipt-b", summary: "Reviewed README", delivery: "delivered" } });
    assert.equal(unrelated.status, "fail");
    assert.match(unrelated.detail, /internal_error/);
    assert.doesNotMatch(unrelated.detail, /without a durable completion receipt/);

    goneResult = { code: 1, stderr: "agent_not_found (unstructured)", stdout: "" };
    assert.equal((await check({ id: "lane-gone", completionReceipt: { id: "receipt-b", summary: "Done" } })).status, "fail");
  } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  }
});
