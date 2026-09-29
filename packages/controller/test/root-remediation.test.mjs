import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { HerdrApiError, runRootWatch, runSupervisorTick } from "../controller.mjs";
import { ROOT_DEAD_CONFIRM_MS, ROOT_DRIFT_ADOPT_MS, SPEC_RESTART_MIN_MS, advanceRootHealth, classifyRootPane, recordRelaunch, relaunchAllowed, rootRelaunchCommand, specProgress } from "../root-watch.mjs";

const T0 = Date.parse("2026-09-29T08:00:00.000Z");
const at = (ms) => new Date(T0 + ms).toISOString();
const ROOT = { target: "w2J:p1", target_kind: "pane_id", pane_id: "w2J:p1", workspace_id: "w2J", agent_kind: "pi" };

function goal({ status = "review-requested", supervisor = "stopped" } = {}) {
  return {
    version: 1,
    id: "parent-cic",
    objective: "Finish the spec.",
    status,
    nextAction: "Review durable done event.",
    signals: [],
    createdAt: at(0),
    updatedAt: at(0),
    supervisor: { version: 1, state: supervisor, intervalSeconds: 60, nudgeCount: 0, nextNudgeAt: supervisor === "running" ? at(0) : null, createdAt: at(0), updatedAt: at(0) },
  };
}

/** A v2 project like the real ones: root, program, parent manifest, a spec and its state. */
async function project({ root = ROOT, parentGoal = goal(), items = { D01: "done", D02: "pending" }, runState, agents = { "lane-admin": { paneId: "w9:p9", agentKind: "claude" } } } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "baa-root-remediation-"));
  const stateDir = join(directory, "state");
  const projectDir = join(directory, "project");
  const manifestPath = join(projectDir, ".baa-ton", "herdr-orchestrator", "manifest.json");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
  const id = `orchestrator:${root.workspace_id}:${root.pane_id}:${projectDir}`;
  await writeFile(manifestPath, `${JSON.stringify({ version: 2, parentGoal, workflows: [] }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(dirname(dirname(manifestPath)), "spec.json"), JSON.stringify({ version: 1, items: Object.keys(items).map((itemId) => ({ id: itemId })) }));
  await writeFile(join(dirname(manifestPath), "spec-state.json"), JSON.stringify({ version: 1, items: Object.fromEntries(Object.entries(items).map(([itemId, state]) => [itemId, { state }])) }));
  const config = { version: 2, owner: "herdr-orchestrator", orchestrators: [{ id, root, program: { id: projectDir, workspace_id: root.workspace_id, parent_manifest_path: manifestPath }, workflows: [] }] };
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const storePath = join(directory, "operator.json");
  await writeFile(storePath, JSON.stringify({ version: 1, agents, messages: [], ...(runState ? { runState } : {}) }));
  const saved = process.env.BAATON_OPERATOR_STORE;
  process.env.BAATON_OPERATOR_STORE = storePath;
  return {
    stateDir,
    projectDir,
    manifestPath,
    id,
    manifest: async () => JSON.parse(await readFile(manifestPath, "utf8")),
    config: async () => JSON.parse(await readFile(join(stateDir, "config.json"), "utf8")),
    store: async () => JSON.parse(await readFile(storePath, "utf8")),
    async cleanup() {
      if (saved === undefined) delete process.env.BAATON_OPERATOR_STORE;
      else process.env.BAATON_OPERATOR_STORE = saved;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** A Herdr with one agent in the root pane (agent: null for none), recording prompts. */
function herdr({ agent = { agent: "pi", name: "w2J:p1", agent_status: "idle" }, shell = false } = {}) {
  const api = {
    agent,
    shell,
    prompts: [],
    async request(method, params = {}) {
      if (method === "pane.report_metadata") return { result: {} };
      if (method === "agent.prompt") {
        api.prompts.push(params);
        return { result: { type: "agent_prompted" } };
      }
      if (method === "agent.get") {
        if (!api.agent) throw new HerdrApiError("agent_not_found", "no agent in the pane");
        return { type: "agent_info", agent: { pane_id: ROOT.pane_id, workspace_id: ROOT.workspace_id, interactive_ready: true, ...api.agent } };
      }
      throw new Error(`Unexpected Herdr method ${method}`);
    },
    async processInfo() {
      return { result: { process_info: { shell_pid: 10, foreground_processes: [{ pid: api.shell ? 10 : 99 }] } } };
    },
  };
  return api;
}

test("spec progress counts what is left; classification tells drift from a dead pane", async () => {
  const p = await project({ items: { D01: "done", D02: "resolved", D03: "deferred", D04: "verifying", D05: "failed" } });
  try {
    assert.deepEqual(specProgress(p.manifestPath), { total: 5, done: 2, deferred: 1, open: 2 });
    assert.equal(specProgress(join(p.stateDir, "nowhere", "manifest.json")), undefined, "no spec");
  } finally {
    await p.cleanup();
  }
  const info = (agent) => ({ type: "agent_info", agent });
  assert.deepEqual(classifyRootPane({ shell: false, info: info({ agent: "pi", agent_status: "idle" }), root: ROOT }).status, "ok");
  const drift = classifyRootPane({ shell: false, info: info({ agent: "claude", agent_status: "done", agent_session: { value: "b9d80eda" } }), root: ROOT });
  assert.deepEqual([drift.status, drift.registered, drift.live], ["drift", "pi", { kind: "claude", status: "done", session: "b9d80eda" }]);
  assert.deepEqual(classifyRootPane({ shell: false, info: undefined, root: ROOT }), { status: "dead", reason: "no_agent_in_pane" });
  assert.deepEqual(classifyRootPane({ shell: true, info: info({ agent: "pi" }), root: ROOT }), { status: "dead", reason: "pane_shows_shell_prompt" });
  assert.equal(classifyRootPane({ shell: false, info: info({ agent: "claude" }), root: { ...ROOT, agent_kind: undefined } }).status, "ok", "no registered kind: nothing to drift from");
});

test("a root health episode adopts a drifted harness after 5 minutes and relaunches a dead pane only with a configured command, within its budget", () => {
  const entry = {};
  const drift = { status: "drift", live: { kind: "claude" }, registered: "pi" };
  assert.deepEqual(advanceRootHealth(entry, drift, { timestamp: at(0) }), {});
  assert.equal(entry.rootHealth.since, at(0));
  assert.deepEqual(advanceRootHealth(entry, drift, { timestamp: at(ROOT_DRIFT_ADOPT_MS - 1) }), {});
  assert.deepEqual(advanceRootHealth(entry, drift, { timestamp: at(ROOT_DRIFT_ADOPT_MS) }), { adopt: "claude", anomaly: "root-harness-drift" });
  assert.equal(entry.rootHealth.since, at(0), "one episode");
  assert.deepEqual(advanceRootHealth(entry, { status: "ok" }, { timestamp: at(ROOT_DRIFT_ADOPT_MS + 1000) }), {});
  assert.equal(entry.rootHealth, undefined, "recovered: the episode ends");

  const dead = { status: "dead", reason: "no_agent_in_pane" };
  const bare = {};
  assert.deepEqual(advanceRootHealth(bare, dead, { timestamp: at(0), resumable: false }), {});
  assert.deepEqual(advanceRootHealth(bare, dead, { timestamp: at(ROOT_DEAD_CONFIRM_MS), resumable: false }), { anomaly: "root-dead" }, "nothing to relaunch with: flagged at once");
  const resumable = {};
  advanceRootHealth(resumable, dead, { timestamp: at(0), resumable: true });
  assert.deepEqual(advanceRootHealth(resumable, dead, { timestamp: at(ROOT_DEAD_CONFIRM_MS), resumable: true }), { relaunch: true }, "relaunch first, flag later");
  assert.deepEqual(advanceRootHealth(resumable, dead, { timestamp: at(2 * ROOT_DEAD_CONFIRM_MS), resumable: true }), { relaunch: true, anomaly: "root-dead" });

  // Budget: three an hour, ten minutes apart.
  const budget = {};
  assert.equal(relaunchAllowed(budget, at(0)), true);
  recordRelaunch(budget, at(0));
  assert.equal(relaunchAllowed(budget, at(5 * 60_000)), false);
  assert.equal(relaunchAllowed(budget, at(11 * 60_000)), true);
  recordRelaunch(budget, at(11 * 60_000));
  recordRelaunch(budget, at(22 * 60_000));
  assert.equal(relaunchAllowed(budget, at(40 * 60_000)), false, "three in the hour");
  assert.equal(relaunchAllowed(budget, at(61 * 60_000)), true, "the first has aged out");
  assert.equal(rootRelaunchCommand({ resume_command: "pi --continue" }, "/work/cic"), "cd '/work/cic' && pi --continue");
  assert.equal(rootRelaunchCommand({}, "/work/cic"), undefined);
});

test("a root that stopped its own supervision while the spec has unfinished items is put back on the nudge loop, and lane-admin hears about it (cic: not-running for 11 hours)", async () => {
  const p = await project();
  const api = herdr();
  try {
    const tick = (ms) => runSupervisorTick({ stateDir: p.stateDir, herdr: api, timestamp: at(ms) });
    const first = await tick(0);
    assert.notEqual(first.results[0].status, "not-running");
    let manifest = await p.manifest();
    assert.equal(manifest.parentGoal.supervisor.state, "running");
    assert.equal(manifest.rootSupervision[0].specRestart.count, 1);
    assert.equal(manifest.rootSupervision[0].specRestart.open, 1);
    assert.ok(manifest.rootSupervision[0].alerts.some((alert) => alert.kind === "supervision-restarted" && /1 of 2 item\(s\) unfinished/.test(alert.text)));
    const anomalies = Object.values((await p.store()).anomalies ?? {});
    assert.deepEqual(anomalies.map((anomaly) => anomaly.kind), ["supervision-stopped-with-work"]);
    assert.ok((await p.store()).messages.some((message) => message.target === "lane-admin" && /supervision was stopped while the spec has 1 of 2/.test(message.text)));

    // Stopped again at once: not restarted more than every SPEC_RESTART_MIN_MS.
    manifest.parentGoal.supervisor.state = "stopped";
    await writeFile(p.manifestPath, JSON.stringify(manifest));
    assert.equal((await tick(60_000)).results[0].status, "not-running");
    assert.equal((await tick(SPEC_RESTART_MIN_MS + 1000)).results[0].status === "not-running", false, "and after the gap it restarts again");
    assert.equal((await p.manifest()).rootSupervision[0].specRestart.count, 2);
  } finally {
    await p.cleanup();
  }
});

test("supervision is left stopped when nothing is left to do, when an operator paused the run, and a completed goal with work left is escalated, not reopened", async () => {
  // Every item finished: the stop stands.
  let p = await project({ items: { D01: "done", D02: "deferred" } });
  try {
    assert.equal((await runSupervisorTick({ stateDir: p.stateDir, herdr: herdr(), timestamp: at(0) })).results[0].status, "not-running");
    assert.equal((await p.manifest()).parentGoal.supervisor.state, "stopped");
  } finally {
    await p.cleanup();
  }
  // Only an operator pauses the run.
  p = await project({ runState: { state: "paused", reason: "night", by: "zach", at: at(-3_600_000) } });
  try {
    assert.equal((await runSupervisorTick({ stateDir: p.stateDir, herdr: herdr(), timestamp: at(0) })).results[0].status, "not-running");
    assert.equal((await p.manifest()).parentGoal.supervisor.state, "stopped");
  } finally {
    await p.cleanup();
  }
  // Completed with work left: an anomaly and a notification, once; the goal is not reopened.
  p = await project({ parentGoal: goal({ status: "completed" }) });
  const notices = [];
  try {
    const { runSupervisorTick: tickFn } = await import("../controller.mjs");
    const originalStore = process.env.BAATON_OPERATOR_STORE;
    void originalStore;
    for (const ms of [0, 60_000]) assert.equal((await tickFn({ stateDir: p.stateDir, herdr: herdr(), timestamp: at(ms), notify: async (notice) => notices.push(notice) })).results[0].status, "not-running");
    const manifest = await p.manifest();
    assert.equal(manifest.parentGoal.status, "completed");
    assert.equal(manifest.parentGoal.supervisor.state, "stopped");
    assert.deepEqual(Object.values((await p.store()).anomalies ?? {}).map((anomaly) => anomaly.kind), ["goal-completed-with-work"]);
    assert.equal(notices.length, 1, "the user hears once");
    assert.match(notices[0].body, /recorded as completed, but the spec has 1 of 2 item\(s\) unfinished/);
  } finally {
    await p.cleanup();
  }
});

test("a Claude root is nudged: only a Pi root needs the Pi turn proof, any other is judged by Herdr's live status (a root that switched to Claude was never nudged)", async () => {
  const claude = { ...ROOT, agent_kind: "claude" };
  const p = await project({ root: claude, parentGoal: goal({ status: "active", supervisor: "running" }) });
  const api = herdr({ agent: { agent: "claude", name: "claude", agent_status: "idle" } });
  try {
    const result = await runSupervisorTick({ stateDir: p.stateDir, herdr: api, timestamp: at(0) });
    assert.notEqual(result.results[0].status, "root-turn-not-idle");
    assert.ok(api.prompts.length >= 1, "a wake went into the Claude pane");
    // Herdr's live status still vetoes a working root.
    const busy = await project({ root: claude, parentGoal: goal({ status: "active", supervisor: "running" }) });
    const working = herdr({ agent: { agent: "claude", name: "claude", agent_status: "working" } });
    try {
      const skipped = await runSupervisorTick({ stateDir: busy.stateDir, herdr: working, timestamp: at(0) });
      assert.equal(working.prompts.length, 0);
      assert.equal(skipped.results[0].status, "root-not-idle");
    } finally {
      await busy.cleanup();
    }
  } finally {
    await p.cleanup();
  }
  // A Pi root still needs its settled proof.
  const pi = await project({ parentGoal: goal({ status: "active", supervisor: "running" }) });
  const piApi = herdr();
  try {
    assert.equal((await runSupervisorTick({ stateDir: pi.stateDir, herdr: piApi, timestamp: at(0) })).results[0].status, "root-turn-not-idle");
    assert.equal(piApi.prompts.length, 0);
  } finally {
    await pi.cleanup();
  }
});

test("the root watch adopts a live harness that drifted from the registered one, tells the root and the user, and never touches a config that changed under it (Pi exited, plain Claude took the pane)", async () => {
  const p = await project({ parentGoal: goal({ status: "active", supervisor: "running" }) });
  const notices = [];
  const api = herdr({ agent: { agent: "claude", name: "claude", agent_status: "done", agent_session: { value: "b9d80eda" } } });
  const watch = (ms) => runRootWatch({ stateDir: p.stateDir, herdr: api, timestamp: at(ms), notify: async (notice) => notices.push(notice), paneRun: async () => assert.fail("nothing to relaunch: an agent is live") });
  try {
    await watch(0);
    let manifest = await p.manifest();
    assert.equal(manifest.rootSupervision[0].rootHealth.status, "drift");
    assert.equal((await p.config()).orchestrators[0].root.agent_kind, "pi", "not yet");
    await watch(ROOT_DRIFT_ADOPT_MS - 1000);
    assert.equal((await p.config()).orchestrators[0].root.agent_kind, "pi");
    await watch(ROOT_DRIFT_ADOPT_MS);
    assert.equal((await p.config()).orchestrators[0].root.agent_kind, "claude", "adopted the live kind");
    manifest = await p.manifest();
    assert.equal(manifest.rootSupervision[0].rootHealth, undefined, "the episode ended with the adoption");
    const alert = manifest.rootSupervision[0].alerts.find((item) => item.kind === "root-harness-adopted");
    assert.match(alert.text, /runs claude \(the root was registered as pi\)[\s\S]*baa-ton-start[\s\S]*herdr_bootstrap_root/);
    const store = await p.store();
    const anomaly = Object.values(store.anomalies).find((item) => item.kind === "root-harness-drift");
    assert.match(anomaly.summary, /runs claude but was registered as pi/);
    assert.ok(store.messages.some((message) => message.target === "lane-admin" && /root-harness-drift/.test(message.text)));
    assert.equal(notices.filter((notice) => notice.title === "Baa-ton: the root's harness changed").length, 1);
    await watch(ROOT_DRIFT_ADOPT_MS + 60_000);
    assert.equal(notices.length, 1, "once");
  } finally {
    await p.cleanup();
  }

  // A person bootstrapped the root meanwhile (the config already says claude): nothing is rewritten, no episode.
  const q = await project({ root: { ...ROOT, agent_kind: "claude" }, parentGoal: goal({ status: "active", supervisor: "running" }) });
  try {
    await runRootWatch({ stateDir: q.stateDir, herdr: api, timestamp: at(0), notify: async () => assert.fail("healthy root"), paneRun: async () => assert.fail("healthy root") });
    assert.equal((await q.manifest()).rootSupervision, undefined, "an ok root leaves no trace");
  } finally {
    await q.cleanup();
  }
});

test("a root pane left with no agent is relaunched with the configured resume command, rate limited, and flagged; without one it is only flagged", async () => {
  const withCommand = { ...ROOT, resume_command: "pi --session /work/root.jsonl" };
  const p = await project({ root: withCommand, parentGoal: goal({ status: "active", supervisor: "running" }) });
  const ran = [];
  const notices = [];
  const api = herdr({ agent: null, shell: true });
  const watch = (ms) => runRootWatch({ stateDir: p.stateDir, herdr: api, timestamp: at(ms), notify: async (notice) => notices.push(notice), paneRun: async (paneId, command) => ran.push([paneId, command]) });
  try {
    await watch(0);
    assert.equal(ran.length, 0, "confirmed first");
    await watch(ROOT_DEAD_CONFIRM_MS);
    assert.deepEqual(ran, [["w2J:p1", `cd '${p.projectDir}' && pi --session /work/root.jsonl`]]);
    await watch(ROOT_DEAD_CONFIRM_MS + 60_000);
    assert.equal(ran.length, 1, "not again within ten minutes");
    await watch(2 * ROOT_DEAD_CONFIRM_MS);
    const store = await p.store();
    const anomaly = Object.values(store.anomalies).find((item) => item.kind === "root-dead");
    assert.match(anomaly.summary, /no agent \(pane_shows_shell_prompt\)/);
    assert.match(anomaly.evidence[0], /relaunched 1 time\(s\) with the configured resume_command; the pane still has no agent/);
    assert.equal(notices.filter((notice) => notice.title === "Baa-ton: the root has stopped").length, 1);
    assert.equal((await p.manifest()).rootSupervision[0].rootRelaunches.length, 1);
  } finally {
    await p.cleanup();
  }
  const bare = await project({ parentGoal: goal({ status: "active", supervisor: "running" }) });
  const none = [];
  try {
    const noAgent = herdr({ agent: null });
    for (const ms of [0, ROOT_DEAD_CONFIRM_MS]) await runRootWatch({ stateDir: bare.stateDir, herdr: noAgent, timestamp: at(ms), notify: async () => undefined, paneRun: async (...args) => none.push(args) });
    assert.equal(none.length, 0, "no command configured");
    const anomaly = Object.values((await bare.store()).anomalies).find((item) => item.kind === "root-dead");
    assert.match(anomaly.evidence[0], /no resume_command is configured/);
  } finally {
    await bare.cleanup();
  }
  // An operator's pause stands down the watch too.
  const paused = await project({ runState: { state: "paused", by: "zach", at: at(-1000) }, parentGoal: goal({ status: "active", supervisor: "running" }) });
  try {
    await runRootWatch({ stateDir: paused.stateDir, herdr: herdr({ agent: null }), timestamp: at(0), notify: async () => assert.fail("paused"), paneRun: async () => assert.fail("paused") });
    assert.equal((await paused.manifest()).rootSupervision, undefined);
  } finally {
    await paused.cleanup();
  }
});
