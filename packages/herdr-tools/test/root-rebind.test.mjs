import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, rm, writeFile, mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

const root = (paneId, workspaceId) => ({ target: paneId, target_kind: "pane_id", pane_id: paneId, workspace_id: workspaceId, agent_kind: "pi" });

// After a Herdr server restart: the root was w22:p1, its pane is gone, and
// the same Pi session came back as w2J:p1.
async function fixture({ liveSession = "sess-01a0cc67" } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "baa-root-rebind-")));
  const cwd = join(directory, "project");
  const configDir = join(directory, "config");
  const manifestDir = join(cwd, ".baa-ton", "herdr-orchestrator");
  const manifestPath = join(manifestDir, "manifest.json");
  const oldRoot = root("w22:p1", "w22");
  const newRoot = root("w2J:p1", "w2J");
  const oldId = `orchestrator:w22:w22:p1:${cwd}`;
  const config = {
    version: 2,
    owner: "herdr-orchestrator",
    orchestrators: [{ id: oldId, root: oldRoot, program: { id: cwd, workspace_id: "w22", parent_manifest_path: manifestPath }, workflows: [] }],
  };
  const manifest = {
    version: 2,
    // A lane that was running when Herdr restarted: not quiescent, ended with its pane.
    workflows: [{ id: "herdr-live", status: "running", taskBinding: { rootPaneId: "w22:p1", workspaceId: "w22" }, lanes: [{ id: "lane-1", status: "working", paneId: "w22:p9" }], ownership: { paneIds: ["w22:p9"] }, evidence: [] }],
    rootSessionLogs: [
      { rootId: oldId, root: oldRoot, kind: "root", sessionRef: { provider: "pi", sessionId: "sess-01a0cc67", nativeHandle: { kind: "id", value: "sess-01a0cc67" } }, startedAt: "2026-09-27T02:00:00.000Z", status: "idle", paneId: "w22:p1", workspaceId: "w22" },
    ],
  };
  await mkdir(manifestDir, { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(configDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const saved = Object.fromEntries(["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR", "CLAUDE_CODE_SESSION_ID"].map((key) => [key, process.env[key]]));
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
      if (args[0] === "workspace" && args[1] === "list") return ok({ workspaces: [{ workspace_id: "w2J" }] });
      if (args[0] === "agent" && args[1] === "get") {
        if (args[2] !== newRoot.pane_id)
          return { code: 1, stderr: "", stdout: JSON.stringify({ error: { code: "agent_not_found", message: `agent target ${args[2]} not found` } }) };
        return ok({ type: "agent_info", agent: { agent: "pi", name: "pi-root", pane_id: newRoot.pane_id, workspace_id: "w2J", agent_session: { kind: "id", value: liveSession }, agent_status: "idle" } });
      }
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
