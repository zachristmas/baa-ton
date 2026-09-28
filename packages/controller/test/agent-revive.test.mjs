import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { REVIVE_CONFIRM_MS, REVIVE_INTERVAL_MS, REVIVE_MAX_PER_HOUR, createAgentReviver, reviveCommand } from "../agent-revive.mjs";
import { revivePaneState } from "../controller.mjs";
import { registerAgent } from "../../herdr-tools/operator-api.mjs";

async function store(agents) {
  const directory = await mkdtemp(join(tmpdir(), "baa-revive-"));
  const path = join(directory, "operator.json");
  await writeFile(path, JSON.stringify({ version: 1, agents, messages: [] }));
  return { env: { BAATON_OPERATOR_STORE: path }, path, read: async () => JSON.parse(await readFile(path, "utf8")), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const admin = { paneId: "w2F:p2", cwd: "/work/it's here", sessionId: "s-1", resume: "claude --resume s-1" };

test("registration records the Claude session and, with --resume, the relaunch command", async () => {
  const s = await store({});
  try {
    const env = { ...s.env, CLAUDE_CODE_SESSION_ID: "s-9", HERDR_PANE_ID: "w1:p3" };
    const plain = await registerAgent({ name: "helper", cwd: "/w", env });
    assert.equal(plain.sessionId, "s-9");
    assert.equal(plain.resume, undefined, "no relaunch unless asked");
    const resumable = await registerAgent({ name: "lane-admin", cwd: "/w", resume: true, env });
    assert.equal(resumable.resume, "claude --resume s-9");
    const custom = await registerAgent({ name: "other", cwd: "/w", resume: "claude --resume s-9 --permission-mode auto", env });
    assert.equal(custom.resume, "claude --resume s-9 --permission-mode auto");
    await assert.rejects(registerAgent({ name: "nosession", cwd: "/w", resume: true, env: { ...s.env, HERDR_PANE_ID: "w1:p4" } }), /needs a Claude Code session/);
    assert.equal((await s.read()).agents.nosession, undefined, "a refused registration writes nothing");
  } finally {
    await s.cleanup();
  }
});

test("the relaunch command changes to the agent's folder, quoted", () => {
  assert.equal(reviveCommand(admin), `cd '/work/it'\\''s here' && claude --resume s-1`);
  assert.equal(reviveCommand({ paneId: "p", sessionId: "s" }), undefined, "not resumable without a resume command");
});

test("a dead pane is relaunched once confirmed, rate-limited, budget kept in the store, and reported to lane-admin", async () => {
  const s = await store({ "lane-admin": admin, helper: { paneId: "w1:p3", sessionId: "s-2" } });
  try {
    let clock = Date.parse("2026-09-26T15:00:00.000Z");
    let dead = true;
    const runs = [];
    const anomalies = [];
    const notes = [];
    const states = [];
    const reviver = createAgentReviver({
      env: s.env,
      paneState: async (agent) => (states.push(agent.paneId), { dead, reason: "pane_shows_shell_prompt" }),
      run: async (paneId, command) => runs.push([paneId, command]),
      anomaly: async (anomaly) => anomalies.push(anomaly),
      notify: async (note) => notes.push(note),
      clock: () => clock,
    });
    await reviver.tick();
    assert.deepEqual(runs, [], "first sighting only starts the confirmation window");
    assert.deepEqual(states, ["w2F:p2"], "agents without a resume command are never checked");
    clock += REVIVE_CONFIRM_MS;
    const first = await reviver.tick();
    assert.deepEqual(runs, [["w2F:p2", reviveCommand(admin)]]);
    assert.match(first.events[0], /relaunched with "claude --resume s-1"/);
    assert.equal(anomalies[0].kind, "agent-relaunched");
    assert.equal((await s.read()).agents["lane-admin"].revives.length, 1);
    // Still dead right after: waits the interval.
    clock += REVIVE_CONFIRM_MS;
    await reviver.tick();
    clock += REVIVE_CONFIRM_MS;
    await reviver.tick();
    assert.equal(runs.length, 1, "no second relaunch inside the interval");
    for (let round = 2; round <= REVIVE_MAX_PER_HOUR; round += 1) {
      clock += REVIVE_INTERVAL_MS;
      await reviver.tick();
      clock += REVIVE_CONFIRM_MS;
      await reviver.tick();
    }
    assert.equal(runs.length, REVIVE_MAX_PER_HOUR);
    const events = [];
    clock += REVIVE_INTERVAL_MS;
    events.push(...(await reviver.tick()).events);
    clock += REVIVE_CONFIRM_MS;
    events.push(...(await reviver.tick()).events);
    events.push(...(await reviver.tick()).events);
    assert.equal(runs.length, REVIVE_MAX_PER_HOUR, "the hourly budget holds");
    assert.equal(events.length, 1);
    assert.match(events[0], /still dead after 3 relaunches/);
    assert.equal(notes.length, 1, "one notice when the budget runs out");
    // A fresh reviver (a supervisor restart) reads the same budget.
    const restarted = createAgentReviver({ env: s.env, paneState: async () => ({ dead: true, reason: "x" }), run: async (...args) => runs.push(args), clock: () => clock });
    await restarted.tick();
    clock += REVIVE_CONFIRM_MS;
    await restarted.tick();
    assert.equal(runs.length, REVIVE_MAX_PER_HOUR, "a restart does not reset the budget");
    // Alive again: nothing happens.
    dead = false;
    clock += 2 * 60 * 60_000;
    await reviver.tick();
    clock += REVIVE_CONFIRM_MS;
    await reviver.tick();
    assert.equal(runs.length, REVIVE_MAX_PER_HOUR);
  } finally {
    await s.cleanup();
  }
});

test("after a Herdr restart: a session live in another pane is followed, a gone pane is reported once, and a failed relaunch is never logged as relaunched", async () => {
  // The session moved: w2F:p2 is gone and s-1 now runs in w2K:p1.
  const s = await store({ "lane-admin": { ...admin } });
  try {
    let clock = 0;
    const runs = [];
    const reviver = createAgentReviver({ env: s.env, clock: () => clock, paneState: async () => ({ dead: true, reason: "agent_not_found" }), sessionPane: async (agent) => (agent.sessionId === "s-1" ? { paneId: "w2K:p1", workspaceId: "w2K" } : undefined), run: async (...args) => runs.push(args) });
    const { events } = await reviver.tick();
    assert.match(events[0], /its session s-1 runs in pane w2K:p1; registration moved from w2F:p2/);
    assert.equal((await s.read()).agents["lane-admin"].paneId, "w2K:p1");
    assert.equal((await s.read()).agents["lane-admin"].workspaceId, "w2K");
    assert.equal(runs.length, 0, "never a second copy of a live session");
  } finally {
    await s.cleanup();
  }
  // The pane is gone and the session runs nowhere: one report, no relaunch attempts.
  const g = await store({ "lane-admin": { ...admin } });
  try {
    let clock = 0;
    const runs = [];
    const notes = [];
    const reviver = createAgentReviver({ env: g.env, clock: () => clock, paneState: async () => ({ dead: true, reason: "agent_not_found" }), paneExists: async () => false, run: async (...args) => runs.push(args), notify: async (note) => notes.push(note) });
    await reviver.tick();
    clock = REVIVE_CONFIRM_MS + 1;
    const first = await reviver.tick();
    assert.match(first.events[0], /pane w2F:p2 no longer exists and its session runs nowhere; not relaunched/);
    clock += REVIVE_INTERVAL_MS + 1;
    assert.deepEqual((await reviver.tick()).events, [], "reported once");
    assert.equal(runs.length, 0);
    assert.equal(notes.length, 1);
  } finally {
    await g.cleanup();
  }
  // The relaunch command fails: a failure event, no "relaunched" and no anomaly.
  const f = await store({ "lane-admin": { ...admin } });
  try {
    let clock = 0;
    const anomalies = [];
    const reviver = createAgentReviver({ env: f.env, clock: () => clock, paneState: async () => ({ dead: true, reason: "agent_not_found" }), run: async () => { throw new Error("pane_not_found"); }, anomaly: async (value) => anomalies.push(value) });
    await reviver.tick();
    clock = REVIVE_CONFIRM_MS + 1;
    const { events } = await reviver.tick();
    assert.deepEqual(events, ["lane-admin: relaunch in pane w2F:p2 failed: pane_not_found"]);
    assert.equal(anomalies.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("a pane that looks dead once and then alive is left alone", async () => {
  const s = await store({ "lane-admin": admin });
  try {
    let clock = 0;
    const sequence = [true, false, true];
    const runs = [];
    const reviver = createAgentReviver({ env: s.env, paneState: async () => ({ dead: sequence.shift() ?? false, reason: "r" }), run: async (...args) => runs.push(args), clock: () => clock });
    for (let index = 0; index < 4; index += 1) {
      await reviver.tick();
      clock += REVIVE_CONFIRM_MS;
    }
    assert.deepEqual(runs, []);
  } finally {
    await s.cleanup();
  }
});

test("pane state: a bare shell is dead, a busy pane is not, and no agent counts only when process info is unavailable", async () => {
  const shell = { process_info: { shell_pid: 10, foreground_processes: [{ pid: 10 }] } };
  const busy = { process_info: { shell_pid: 10, foreground_processes: [{ pid: 11 }] } };
  const herdr = (info, agent) => ({
    processInfo: async () => {
      if (!info) throw new Error("unavailable");
      return info;
    },
    request: async () => agent,
  });
  assert.equal((await revivePaneState(herdr(shell, {}), "p")).dead, true);
  assert.equal((await revivePaneState(herdr(busy, {}), "p")).dead, false, "something else in the foreground is never relaunched over");
  assert.equal((await revivePaneState(herdr(undefined, { type: "agent_info", agent: {} }), "p")).dead, true);
  assert.equal((await revivePaneState(herdr(undefined, { type: "agent_info", agent: { agent: "claude", pane_id: "p", agent_status: "working" } }), "p")).dead, false);
  const broken = { processInfo: async () => { throw new Error("x"); }, request: async () => { throw new Error("socket closed"); } };
  assert.equal(await revivePaneState(broken, "p"), undefined, "unreadable is not dead");
});
