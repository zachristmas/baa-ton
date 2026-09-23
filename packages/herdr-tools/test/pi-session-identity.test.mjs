import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { resolvePiSessionIdentity, registerPiIdentityBridge, PI_ROOT_IDENTITY_CHANNEL } from "../pi-session-identity.mjs";

const id = "01a0b04d-0bef-7207-b486-d51d62f0e3dc";
async function fixture() {
  // realpath: macOS tmpdir() is a /var symlink to /private/var, and the proof
  // canonicalizes session paths.
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "baa-pi-identity-")));
  // Deliberately not a UUID filename: header and live runtime are the proof.
  const sessionFile = join(cwd, "session.jsonl");
  await writeFile(sessionFile, JSON.stringify({ type: "session", version: 3, id, cwd }) + "\n");
  const runtime = { getSessionId: () => id, getSessionFile: () => sessionFile };
  const agent = { agent: "pi", pane_id: "w1:p1", workspace_id: "w1", agent_session: { kind: "id", value: id } };
  return { cwd, sessionFile, runtime, agent, paneId: "w1:p1", workspaceId: "w1", env: {} };
}

test("Pi UUID and path metadata prove the same live runtime without PI_SESSION_FILE", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.sessionFile);
    const proof = await resolvePiSessionIdentity(f);
    assert.equal(proof.sessionId, id);
    assert.equal(proof.sessionPath, f.sessionFile);
    assert.equal(proof.source, "baa-ton-native-pi");
    f.agent.agent_session = { kind: "path", value: f.sessionFile };
    assert.equal((await resolvePiSessionIdentity(f)).sessionPath, proof.sessionPath);
    assert.deepEqual(await readFile(f.sessionFile), before);
  } finally { await rm(f.cwd, { recursive: true, force: true }); }
});

test("Pi ownership rejects conflicts, missing proof, filename guesses and session changes", async () => {
  const f = await fixture();
  try {
    for (const patch of [
      { agent: { ...f.agent, agent: "claude" } },
      { paneId: "other" }, { workspaceId: "other" },
      { agent: { ...f.agent, agent_session: { kind: "id", value: "01a0b04d-0bef-7207-b486-d51d62f0e3dd" } } },
      { agent: { ...f.agent, agent_session: { kind: "path", value: id } } },
      { agent: { ...f.agent, agent_session: { value: id } } },
      { runtime: { getSessionFile: () => f.sessionFile } },
      { env: { PI_SESSION_FILE: f.sessionFile + "\r" } },
      { env: { PI_SESSION_FILE: join(f.cwd, "missing") } },
    ]) await assert.rejects(resolvePiSessionIdentity({ ...f, ...patch }));
    const wrong = join(f.cwd, `2026-09-17_${id}.jsonl`);
    await writeFile(wrong, JSON.stringify({ type: "session", id: "wrong", cwd: f.cwd }) + "\n");
    await assert.rejects(resolvePiSessionIdentity({ ...f, runtime: { ...f.runtime, getSessionFile: () => wrong } }), /header differs/);
    for (const header of [{ type: "session", id, cwd: tmpdir() }, { type: "message", id, cwd: f.cwd }]) {
      await writeFile(wrong, JSON.stringify(header) + "\n");
      await assert.rejects(resolvePiSessionIdentity({ ...f, runtime: { ...f.runtime, getSessionFile: () => wrong } }), /header differs/);
    }
    let calls = 0;
    await assert.rejects(resolvePiSessionIdentity({ ...f, runtime: { ...f.runtime, getSessionId: () => ++calls === 1 ? id : "changed" } }), /changed during/);
  } finally { await rm(f.cwd, { recursive: true, force: true }); }
});

test("bridge uses only native lifecycle context; caller context is ignored and shutdown invalidates", async () => {
  const hooks = new Map(); let handler;
  registerPiIdentityBridge({ on: (name, fn) => hooks.set(name, fn), events: { on: (_name, fn) => { handler = fn; } } }, async ctx => ctx.cwd);
  const request = () => new Promise((resolve, reject) => handler({ ctx: { cwd: "forged" }, respond: result => Promise.resolve(result).then(resolve, reject) }));
  await assert.rejects(request(), /context unavailable/);
  hooks.get("session_start")({}, { cwd: "native" });
  assert.equal(await request(), "native");
  hooks.get("session_switch")({}, { cwd: "resumed" });
  assert.equal(await request(), "resumed");
  hooks.get("session_shutdown")();
  await assert.rejects(request(), /context unavailable/);
});

test("native tool, doctor, bridge and planning share UUID proof without changing registrations", async () => {
  const f = await fixture();
  const keys = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR", "PI_SESSION_FILE", "CLAUDE_CODE_SESSION_ID"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    const configDir = join(f.cwd, "config"); await mkdir(configDir);
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: f.paneId, HERDR_WORKSPACE_ID: f.workspaceId, HERDR_PLUGIN_CONFIG_DIR: configDir });
    delete process.env.PI_SESSION_FILE; delete process.env.CLAUDE_CODE_SESSION_ID;
    const manifestPath = join(f.cwd, ".baa-ton", "herdr-orchestrator", "manifest.json");
    await mkdir(join(f.cwd, ".baa-ton", "herdr-orchestrator"), { recursive: true });
    await writeFile(manifestPath, JSON.stringify({ version: 2, workflows: [] }));
    const config = JSON.stringify({ version: 2, owner: "herdr-orchestrator", orchestrators: [{ id: "root", root: { target: f.paneId, target_kind: "pane_id", pane_id: f.paneId, workspace_id: f.workspaceId, agent_kind: "pi" }, program: { id: f.cwd, workspace_id: f.workspaceId, parent_manifest_path: manifestPath }, workflows: [] }] });
    await writeFile(join(configDir, "config.json"), config, { mode: 0o600 });
    const tools = new Map(), hooks = new Map(); let handler;
    const jiti = createRequire(import.meta.url)("jiti")(import.meta.url);
    const { default: extension } = await jiti.import("../index.ts");
    extension({ on: (name, fn) => hooks.set(name, [...(hooks.get(name) ?? []), fn]), events: { on: (name, fn) => { assert.equal(name, PI_ROOT_IDENTITY_CHANNEL); handler = fn; } }, registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, async exec(_bin, args) {
      if (args[0] === "plugin" && args[1] === "config-dir") return { code: 0, stdout: configDir, stderr: "" };
      if (args[0] === "agent" && args[1] === "get") return { code: 0, stdout: JSON.stringify({ result: { type: "agent_info", agent: f.agent } }), stderr: "" };
      throw new Error(`Unexpected command: ${args}`);
    } });
    const ctx = { cwd: f.cwd, hasUI: false, sessionManager: f.runtime, modelRegistry: {} };
    const call = (name, args = {}) => tools.get(name).execute(name, args, undefined, undefined, ctx);
    const before = await readFile(manifestPath, "utf8");
    const proof = (await call("herdr_root_identity")).details;
    assert.equal(proof.sessionPath, f.sessionFile); assert.equal(proof.registrationId, "root");
    // Invoke just the bridge's context capture, without unrelated startup writes.
    hooks.get("session_switch")[0]({}, ctx);
    assert.deepEqual(await new Promise(resolve => handler({ respond: resolve })), proof);
    let report = await call("herdr_doctor");
    assert.equal(report.details.checks.find(c => c.id === "root-identity").status, "ok");
    f.agent.agent_session.value = "wrong";
    report = await call("herdr_doctor");
    assert.equal(report.details.checks.find(c => c.id === "root-identity").status, "fail");
    await assert.rejects(call("herdr_root_identity"), /UUID differs/);
    assert.equal(await readFile(manifestPath, "utf8"), before);
    assert.equal(await readFile(join(configDir, "config.json"), "utf8"), config);
    f.agent.agent_session.value = id;
    const planned = await call("herdr_plan", { objective: "Read-only identity regression", lanes: [{ objective: "Inspect README", readOnly: true }] });
    assert.equal(planned.details.workflow.taskBinding.rootSessionPath, f.sessionFile);
    assert.equal(planned.details.workflow.taskBinding.rootPaneId, f.paneId);
  } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(f.cwd, { recursive: true, force: true });
  }
});
