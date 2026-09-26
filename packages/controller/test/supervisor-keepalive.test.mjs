import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { guardSupervisorProcess } from "../controller.mjs";
import { HEARTBEAT_FILE, HEARTBEAT_STALE_MS, RELAUNCH_INTERVAL_MS, ensureSupervisor, writeHeartbeat } from "../supervisor-keepalive.mjs";

const T0 = Date.parse("2026-09-26T19:13:16.000Z");

async function dir() {
  const path = await mkdtemp(join(tmpdir(), "baa-keepalive-"));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

async function lease(path, pid) {
  await mkdir(join(path, "supervisor.lock"), { recursive: true });
  await writeFile(join(path, "supervisor.lock", "owner.json"), JSON.stringify({ pid, created_at: new Date(T0).toISOString() }));
}

test("a fresh heartbeat is alive; a stale one with no lease holder is relaunched once and reported (a live outage)", async () => {
  const d = await dir();
  try {
    const launched = [];
    const anomalies = [];
    const alive = (pid) => pid === 42;
    const run = (now) => ensureSupervisor({ configDir: d.path, env: {}, now, alive, launch: ({ configDir }) => (launched.push(configDir), 777), anomaly: async (anomaly) => anomalies.push(anomaly) });
    writeHeartbeat(d.path, { pid: 42, at: new Date(T0).toISOString() });
    assert.equal((await run(T0 + 30_000)).status, "alive");
    // The supervisor (pid 42) and its launcher died: the heartbeat goes stale and nobody holds the lease.
    writeHeartbeat(d.path, { pid: 41, at: new Date(T0).toISOString() });
    await lease(d.path, 41);
    const first = await run(T0 + HEARTBEAT_STALE_MS + 1);
    assert.deepEqual(first, { status: "relaunched", pid: 777 });
    assert.deepEqual(launched, [d.path]);
    assert.equal(anomalies[0].kind, "supervisor-down");
    assert.match(anomalies[0].summary, /heartbeat is 2 min old .* no process holds its lease, so the hook relaunched it/);
    assert.equal((await run(T0 + HEARTBEAT_STALE_MS + 2)).status, "waiting", "one relaunch per interval");
    assert.equal(launched.length, 1);
    assert.equal((await run(T0 + HEARTBEAT_STALE_MS + RELAUNCH_INTERVAL_MS + 2)).status, "relaunched", "tried again after the interval");
    assert.equal(anomalies.every((anomaly) => anomaly.signature === anomalies[0].signature), true, "one incident, one signature");
  } finally {
    await d.cleanup();
  }
});

test("a runner that just took the lease after a restart is starting, not hung (a live false alarm)", async () => {
  const d = await dir();
  try {
    // The old runner (41) wrote the last heartbeat, then exited to restart on
    // new code; the new runner (42) took the lease 39 s later.
    writeHeartbeat(d.path, { pid: 41, at: new Date(T0).toISOString() });
    await mkdir(join(d.path, "supervisor.lock"), { recursive: true });
    await writeFile(join(d.path, "supervisor.lock", "owner.json"), JSON.stringify({ pid: 42, created_at: new Date(T0 + 39_000).toISOString() }));
    const anomalies = [];
    const run = (now) => ensureSupervisor({ configDir: d.path, env: {}, now, alive: (pid) => pid === 42, launch: () => 1, anomaly: async (anomaly) => anomalies.push(anomaly) });
    assert.deepEqual(await run(T0 + 60_000), { status: "starting", pid: 42 });
    assert.equal(anomalies.length, 0, "no report during a restart");
    // In the gap before anyone holds the lease, a recent heartbeat means a restart too.
    const gap = await ensureSupervisor({ configDir: d.path, env: {}, now: T0 + 20_000, alive: () => false, launch: () => { throw new Error("no relaunch in a restart gap"); }, anomaly: async (anomaly) => anomalies.push(anomaly) });
    assert.deepEqual(gap, { status: "restarting" });
    assert.equal(anomalies.length, 0);
    // Still no heartbeat of its own 2 min after taking the lease: now it is hung.
    assert.equal((await run(T0 + 39_000 + HEARTBEAT_STALE_MS + 1)).status, "hung");
    assert.equal(anomalies.length, 1);
  } finally {
    await d.cleanup();
  }
});

test("a stale heartbeat while a live process holds the lease is reported as hung, never duplicated; tests and a missing config dir skip", async () => {
  const d = await dir();
  try {
    writeHeartbeat(d.path, { pid: 42, at: new Date(T0).toISOString() });
    await lease(d.path, 42);
    const launched = [];
    const anomalies = [];
    const result = await ensureSupervisor({ configDir: d.path, env: {}, now: T0 + 10 * 60_000, alive: () => true, launch: () => launched.push(1), anomaly: async (anomaly) => anomalies.push(anomaly) });
    assert.deepEqual(result, { status: "hung", pid: 42 });
    assert.equal(launched.length, 0);
    assert.match(anomalies[0].summary, /pid 42 still holds the lease \(hung\?\)/);
    assert.equal((await ensureSupervisor({ configDir: d.path, env: { BAA_TON_NO_SUPERVISOR_KEEPALIVE: "1" } })).status, "skipped");
    assert.equal((await ensureSupervisor({ configDir: undefined, env: {} })).status, "skipped");
    assert.equal(JSON.parse(await readFile(join(d.path, HEARTBEAT_FILE), "utf8")).pid, 42);
  } finally {
    await d.cleanup();
  }
});

test("a supervisor process logs why it ends and survives a closed stderr, a hangup and an unhandled rejection", () => {
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdout = new EventEmitter();
  const exits = [];
  proc.exit = (code) => exits.push(code);
  const lines = [];
  guardSupervisorProcess("runner", "/cfg", { proc, log: (line) => lines.push(line) });
  proc.stderr.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  proc.emit("SIGHUP");
  proc.emit("unhandledRejection", new Error("late notify failed"));
  assert.deepEqual(exits, [], "none of those ends it");
  proc.emit("uncaughtException", new Error("boom"));
  assert.deepEqual(exits, [1], "an uncaught exception exits non-zero, so the launcher restarts it");
  proc.emit("exit", 1);
  assert.match(lines.join("\n"), /runner: received SIGHUP; ignored/);
  assert.match(lines.join("\n"), /runner: unhandled rejection \(kept running\): Error: late notify failed/);
  assert.match(lines.join("\n"), /runner: crashed: Error: boom/);
  assert.match(lines.join("\n"), /runner: exiting with code 1/);
});
