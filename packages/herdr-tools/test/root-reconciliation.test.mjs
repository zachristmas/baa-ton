import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, rm, writeFile, mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

function root(paneId, workspaceId, agentKind) {
  return {
    target: paneId,
    target_kind: "pane_id",
    pane_id: paneId,
    workspace_id: workspaceId,
    agent_kind: agentKind,
  };
}

function persistence(provider, value) {
  return {
    provider,
    sessionId: value,
    nativeHandle: { kind: "id", value },
  };
}

async function fixture({ foreign = false, childConflict = false } = {}) {
  // realpath: macOS tmpdir() is a /var symlink to /private/var, and the Pi
  // session proof canonicalizes session paths.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "baa-root-reconcile-")));
  const cwd = join(directory, "project");
  const otherCwd = join(directory, "other-project");
  const configDir = join(directory, "config");
  const manifestDir = join(cwd, ".baa-ton", "herdr-orchestrator");
  const manifestPath = join(manifestDir, "manifest.json");
  const currentRoot = root("w-a:root", "w-a", "claude");
  const otherRoot = root("w-b:root", "w-b", "pi");
  const childPane = childConflict ? currentRoot.pane_id : "w-a:child";
  const child = {
    lane_id: "current-child",
    target: childPane,
    target_kind: "pane_id",
    pane_id: childPane,
    workspace_id: currentRoot.workspace_id,
  };
  const currentWorkflow = {
    workflow_id: "current-workflow",
    manifest_path: manifestPath,
    lanes: [child],
  };
  const otherWorkflow = {
    workflow_id: "other-workflow",
    manifest_path: manifestPath,
    lanes: [
      {
        lane_id: "other-child",
        target: "w-b:child",
        target_kind: "pane_id",
        pane_id: "w-b:child",
        workspace_id: "w-b",
      },
    ],
  };
  const currentProgram = {
    id: foreign ? otherCwd : cwd,
    workspace_id: currentRoot.workspace_id,
    parent_manifest_path: foreign
      ? join(otherCwd, ".baa-ton", "herdr-orchestrator", "manifest.json")
      : manifestPath,
  };
  const config = {
    version: 2,
    owner: "herdr-orchestrator",
    orchestrators: [
      {
        id: "root-a",
        root: currentRoot,
        program: currentProgram,
        workflows: childConflict ? [currentWorkflow] : [currentWorkflow],
      },
      {
        id: "root-b",
        root: otherRoot,
        program: {
          id: cwd,
          workspace_id: otherRoot.workspace_id,
          parent_manifest_path: manifestPath,
        },
        workflows: [otherWorkflow],
      },
    ],
  };
  const manifest = {
    version: 2,
    workflows: [],
    parentGoals: {
      "root-a": {
        version: 1,
        id: "goal-a",
        rootId: "root-a",
        root: currentRoot,
        objective: "Current root goal",
        status: "active",
        nextAction: "reconcile",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      },
      "root-b": {
        version: 1,
        id: "goal-b",
        rootId: "root-b",
        root: otherRoot,
        objective: "Other root goal",
        status: "active",
        nextAction: "continue",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      },
    },
    rootSessionLogs: [
      {
        rootId: "root-a",
        root: currentRoot,
        kind: "root",
        sessionRef: persistence("claude", "old-session"),
        startedAt: "2026-09-18T00:00:00.000Z",
        status: "idle",
        paneId: currentRoot.pane_id,
        workspaceId: currentRoot.workspace_id,
      },
      {
        rootId: "root-b",
        root: otherRoot,
        kind: "root",
        sessionRef: persistence("pi", "other-session"),
        startedAt: "2026-09-18T00:00:00.000Z",
        status: "idle",
        paneId: otherRoot.pane_id,
        workspaceId: otherRoot.workspace_id,
      },
    ],
    rootQueues: {
      version: 1,
      roots: [
        { version: 1, rootId: "root-a", root: currentRoot, itemIds: [] },
        { version: 1, rootId: "root-b", root: otherRoot, itemIds: [] },
      ],
    },
  };
  await mkdir(manifestDir, { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(configDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR", "CLAUDE_CODE_SESSION_ID"].map(
      (key) => [key, process.env[key]],
    ),
  );
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_PANE_ID: currentRoot.pane_id,
    HERDR_WORKSPACE_ID: currentRoot.workspace_id,
    HERDR_PLUGIN_CONFIG_DIR: configDir,
  });
  delete process.env.CLAUDE_CODE_SESSION_ID;
  const missing = new Set();
  const tools = new Map();
  extension({
    on() {},
    registerCommand() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    async exec(_command, args) {
      if (args[0] === "plugin" && args[1] === "config-dir")
        return { code: 0, stderr: "", stdout: JSON.stringify({ result: { config_dir: configDir } }) };
      if (args[0] === "agent" && args[1] === "get") {
        const paneId = args[2];
        if (missing.has(paneId))
          return {
            code: 1,
            stderr: "",
            stdout: JSON.stringify({ error: { code: "agent_not_found", message: `agent target ${paneId} not found` } }),
          };
        const isCurrent = paneId === currentRoot.pane_id;
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              type: "agent_info",
              agent: {
                agent: isCurrent ? "pi" : "pi",
                name: isCurrent ? "pi-root" : "other-root",
                pane_id: paneId,
                workspace_id: isCurrent ? currentRoot.workspace_id : otherRoot.workspace_id,
                agent_session: { kind: "id", value: isCurrent ? "new-session" : "other-session" },
                agent_status: "idle",
              },
            },
          }),
        };
      }
      throw new Error(`Unexpected Herdr command: ${args.join(" ")}`);
    },
  });
  return {
    directory,
    cwd,
    configDir,
    manifestPath,
    currentRoot,
    otherRoot,
    tools,
    missing,
    context: { cwd, hasUI: false, mode: "json", modelRegistry: {} },
    async config() {
      return JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
    },
    async manifest() {
      return JSON.parse(await readFile(manifestPath, "utf8"));
    },
    async cleanup() {
      for (const [key, value] of Object.entries(saved))
        value === undefined ? delete process.env[key] : (process.env[key] = value);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("reconcile root repairs only the current root and is idempotent", async () => {
  const f = await fixture();
  try {
    const beforeConfig = await f.config();
    const beforeManifest = await f.manifest();
    const result = await f.tools
      .get("herdr_reconcile_root")
      .execute("reconcile", {}, undefined, undefined, f.context);
    assert.equal(result.details.reconciled, true);
    assert.equal(result.details.root.agent_kind, "pi");

    const afterConfig = await f.config();
    assert.equal(afterConfig.orchestrators[0].root.agent_kind, "pi");
    assert.deepEqual(
      afterConfig.orchestrators[0].workflows,
      beforeConfig.orchestrators[0].workflows,
    );
    assert.deepEqual(afterConfig.orchestrators[1], beforeConfig.orchestrators[1]);
    const afterManifest = await f.manifest();
    assert.equal(afterManifest.parentGoals["root-a"].root.agent_kind, "pi");
    assert.equal(afterManifest.rootSessionLogs[0].root.agent_kind, "pi");
    assert.equal(afterManifest.rootSessionLogs[0].sessionRef.provider, "pi");
    assert.equal(afterManifest.rootSessionLogs[0].sessionRef.sessionId, "new-session");
    assert.deepEqual(afterManifest.parentGoals["root-b"], beforeManifest.parentGoals["root-b"]);
    assert.deepEqual(afterManifest.rootSessionLogs[1], beforeManifest.rootSessionLogs[1]);
    assert.deepEqual(afterManifest.rootQueues.roots[1], beforeManifest.rootQueues.roots[1]);

    const stableConfig = JSON.stringify(afterConfig);
    const stableManifest = JSON.stringify(afterManifest);
    const repeated = await f.tools
      .get("herdr_reconcile_root")
      .execute("reconcile-again", {}, undefined, undefined, f.context);
    assert.equal(repeated.details.reconciled, false);
    assert.match(repeated.content[0].text, /already current; no state changed/);
    assert.equal(JSON.stringify(await f.config()), stableConfig);
    assert.equal(JSON.stringify(await f.manifest()), stableManifest);
  } finally {
    await f.cleanup();
  }
});

test("reconcile preserves an attested Pi session-file binding alongside Herdr's native UUID", async () => {
  const f = await fixture();
  const sessionPath = join(f.directory, "pi-root_new-session.jsonl");
  const saved = Object.fromEntries(
    ["PI_CODING_AGENT", "PI_SESSION_ID", "PI_SESSION_FILE"].map((key) => [key, process.env[key]]),
  );
  try {
    await writeFile(sessionPath, "{}\n");
    f.context.sessionManager = { getSessionFile: () => sessionPath };
    await f.tools
      .get("herdr_reconcile_root")
      .execute("reconcile", {}, undefined, undefined, f.context);
    const entry = (await f.manifest()).rootSessionLogs.find((item) => item.rootId === "root-a");
    assert.equal(entry.sessionRef.provider, "pi");
    assert.equal(entry.sessionRef.sessionId, "new-session");
    assert.deepEqual(entry.sessionRef.nativeHandle, { kind: "id", value: "new-session" });
    assert.equal(entry.sessionRef.metadata.sessionPath, sessionPath);
  } finally {
    for (const [key, value] of Object.entries(saved))
      value === undefined ? delete process.env[key] : (process.env[key] = value);
    await f.cleanup();
  }
});

test("doctor makes stale and missing root panes blocking findings", async () => {
  const f = await fixture();
  try {
    f.missing.add(f.otherRoot.pane_id);
    const report = await f.tools
      .get("herdr_doctor")
      .execute("doctor", {}, undefined, undefined, f.context);
    const check = report.details.checks.find((entry) => entry.id === "root-identity");
    assert.equal(check.status, "fail");
    assert.match(check.detail, /root-a: agent_kind stored=claude live=pi/);
    assert.match(check.detail, /root-b/);
    assert.match(check.detail, /herdr_reconcile_root/);
    assert.equal(report.details.ok, false);
  } finally {
    await f.cleanup();
  }
});

test("doctor warns without blocking the current root when only another root is stale", async () => {
  const f = await fixture();
  try {
    const config = await f.config();
    config.orchestrators[0].root.agent_kind = "pi";
    await writeFile(join(f.configDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
    f.missing.add(f.otherRoot.pane_id);
    const report = await f.tools
      .get("herdr_doctor")
      .execute("doctor", {}, undefined, undefined, f.context);
    const check = report.details.checks.find((entry) => entry.id === "root-identity");
    assert.equal(check.status, "warn");
    assert.match(check.detail, /Current root identity matches/);
    assert.match(check.detail, /root-b/);
  } finally {
    await f.cleanup();
  }
});

test("root reconciliation refuses foreign and child-conflicting mappings", async () => {
  const foreign = await fixture({ foreign: true });
  try {
    await assert.rejects(
      foreign.tools.get("herdr_reconcile_root").execute("foreign", {}, undefined, undefined, foreign.context),
      /registered for a different project/,
    );
  } finally {
    await foreign.cleanup();
  }
  const child = await fixture({ childConflict: true });
  try {
    await assert.rejects(
      child.tools.get("herdr_reconcile_root").execute("child", {}, undefined, undefined, child.context),
      /registered as a child lane/,
    );
  } finally {
    await child.cleanup();
  }
});
