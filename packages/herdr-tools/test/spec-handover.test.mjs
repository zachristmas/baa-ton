import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFER_FILE, FRESH_MS, HOST_LEASE_FILE, RESTART_GRACE_MS, renewHostLease, specHandover } from "../spec-handover.mjs";
import { headlessContext, headlessPi, rootSession, runSpecHost } from "../spec-host.mjs";
// A child process start can take minutes on a loaded machine (run-hermetic.mjs).
const CHILD_TIMEOUT_MS = Number(process.env.BAATON_HERDR_COMMAND_TIMEOUT_MS) || 120_000;

const T0 = Date.parse("2026-09-26T16:00:00.000Z");
const iso = (ms) => new Date(T0 + ms).toISOString();
const alive = () => true;

async function dir() {
  const path = await mkdtemp(join(tmpdir(), "baa-handover-"));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

test("the root drives without a host; with a live lease it stands down and records the hand-over", async () => {
  const d = await dir();
  try {
    assert.equal(specHandover(d.path, { host: false, now: T0, pid: 10, alive }), undefined, "no lease: the root drives");
    renewHostLease(d.path, { startedAt: iso(0), now: T0, pid: 20 });
    assert.match(specHandover(d.path, { host: false, now: T0 + 1000, pid: 10, alive }), /spec host \(pid 20\) drives/);
    const defer = JSON.parse(await readFile(join(d.path, DEFER_FILE), "utf8"));
    assert.deepEqual(defer, { pid: 10, at: iso(1000) });
    assert.equal(specHandover(d.path, { host: false, now: T0 + FRESH_MS + 1, pid: 10, alive }), undefined, "a stale lease: the root drives again");
    assert.equal(specHandover(d.path, { host: false, now: T0 + RESTART_GRACE_MS + 1000, pid: 10, alive: () => false }), undefined, "a dead host, past the restart grace: the root drives");
  } finally {
    await d.cleanup();
  }
});

test("the host drives only after a hand-over made since it started", async () => {
  const d = await dir();
  try {
    renewHostLease(d.path, { startedAt: iso(0), now: T0, pid: 20 });
    assert.match(specHandover(d.path, { host: true, now: T0, alive }), /waiting for the root's extension/);
    await writeFile(join(d.path, DEFER_FILE), JSON.stringify({ pid: 10, at: iso(-5000) }));
    assert.match(specHandover(d.path, { host: true, now: T0, alive }), /waiting/, "a hand-over to an earlier host does not count");
    await writeFile(join(d.path, DEFER_FILE), JSON.stringify({ pid: 10, at: iso(2000) }));
    assert.equal(specHandover(d.path, { host: true, now: T0 + 3000, alive }), undefined);
    assert.equal(specHandover(d.path, { host: true, now: T0 + 2000 + 10 * FRESH_MS, alive }), undefined, "once handed over, a busy, hung or gone root never stops the host");
  } finally {
    await d.cleanup();
  }
});

test("with no Pi agent in the root pane the host drives without a hand-over", async () => {
  const d = await dir();
  try {
    renewHostLease(d.path, { startedAt: iso(0), now: T0, pid: 20, rootGone: true, rootSession: { file: "/s/root.jsonl", id: "u1" } });
    assert.equal(specHandover(d.path, { host: true, now: T0, alive }), undefined);
    const lease = JSON.parse(await readFile(join(d.path, HOST_LEASE_FILE), "utf8"));
    assert.deepEqual(lease.rootSession, { file: "/s/root.jsonl", id: "u1" });
  } finally {
    await d.cleanup();
  }
});

test("the spec host renews its lease and runs herdr_spec advance headless on its timer", async () => {
  const d = await dir();
  const cwd = d.path;
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cwd, ".baa-ton", "herdr-orchestrator"), { recursive: true });
  const calls = [];
  let host;
  try {
    // A previous host saw the root live; this one starts with the root gone.
    await writeFile(join(cwd, ".baa-ton", "herdr-orchestrator", HOST_LEASE_FILE), JSON.stringify({ pid: 1, startedAt: iso(-1000), at: iso(-1000), rootSession: { file: "/s/root.jsonl", id: "u1" } }));
    host = await runSpecHost({
      cwd,
      readSession: async () => ({ gone: true }),
      now: () => T0,
      exit: () => undefined,
      timerOptions: { schedule: () => undefined, cancel: () => undefined, watch: undefined },
      loadExtension: async () => (pi) => {
        pi.registerTool({
          name: "herdr_spec",
          async execute(id, params, signal, update, ctx) {
            calls.push({ id, params, ctx });
            return { details: { actions: ["build A -> herdr-1"], rootAsks: [] } };
          },
        });
      },
    });
    const lease = JSON.parse(await readFile(join(cwd, ".baa-ton", "herdr-orchestrator", HOST_LEASE_FILE), "utf8"));
    assert.equal(lease.pid, process.pid);
    assert.deepEqual(lease.rootSession, { file: "/s/root.jsonl", id: "u1" }, "carried over from the previous host");
    assert.equal(lease.startedAt, iso(0));
    await host.timer.kick("test");
    assert.deepEqual(calls[0].params, { action: "advance" });
    assert.equal(calls[0].ctx.sessionManager.getSessionFile(), "/s/root.jsonl", "the last recorded root session, though the root is gone");
    const renewed = JSON.parse(await readFile(join(cwd, ".baa-ton", "herdr-orchestrator", HOST_LEASE_FILE), "utf8"));
    assert.equal(renewed.rootGone, true);
    assert.equal(calls[0].ctx.cwd, cwd);
    assert.equal(calls[0].ctx.hasUI, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const log = await readFile(join(cwd, ".baa-ton", "herdr-orchestrator", "spec-driver.log"), "utf8");
    assert.match(log, /"started":true/);
    assert.match(log, /build A -> herdr-1/);
  } finally {
    host?.stop();
    await d.cleanup();
  }
});

test("the headless Pi host runs commands and answers with Pi's exec shape", async () => {
  const pi = headlessPi();
  const ok = await pi.exec(process.execPath, ["-e", "process.stdout.write('hi')"], { timeout: CHILD_TIMEOUT_MS });
  assert.deepEqual({ stdout: ok.stdout, code: ok.code }, { stdout: "hi", code: 0 });
  const bad = await pi.exec(process.execPath, ["-e", "process.exit(3)"], { timeout: CHILD_TIMEOUT_MS });
  assert.equal(bad.code, 3);
  assert.equal(headlessContext("/x").ui.notify("anything"), undefined, "any UI call is a no-op");
});

test("a host that just died is given a restart grace before the root drives on its own (a deploy restart let the root's old code dispatch one pass)", async () => {
  const d = await dir();
  try {
    renewHostLease(d.path, { startedAt: iso(0), now: T0, pid: 20 });
    const dead = () => false;
    // Its process is gone, its lease seconds old: probably restarting.
    assert.match(specHandover(d.path, { host: false, now: T0 + 5_000, pid: 10, alive: dead }), /has just stopped and is probably restarting/);
    assert.match(specHandover(d.path, { host: false, now: T0 + RESTART_GRACE_MS - 1, pid: 10, alive: dead }), /probably restarting/);
    // Past the grace it really is dead: the root drives.
    assert.equal(specHandover(d.path, { host: false, now: T0 + RESTART_GRACE_MS + 1, pid: 10, alive: dead }), undefined);
    // A live host is still respected, and the root never waits on itself.
    assert.match(specHandover(d.path, { host: false, now: T0 + 5_000, pid: 10, alive }), /drives the spec loop/);
    assert.equal(specHandover(d.path, { host: false, now: T0 + 5_000, pid: 20, alive: dead }), undefined);
  } finally {
    await d.cleanup();
  }
});

test("a root of another harness is gone for the host, which still learns its session value", async () => {
  const agent = (extra) => ({ code: 0, stdout: JSON.stringify({ result: { agent: { pane_id: "p", workspace_id: "w", ...extra } } }), stderr: "" });
  const env = { paneId: "p", workspaceId: "w" };
  const claude = { exec: async () => agent({ agent: "claude", agent_session: { kind: "id", value: "sess-1" } }) };
  assert.deepEqual(await rootSession(claude, env), { gone: true, file: "sess-1", id: "sess-1" });
  const bare = { exec: async () => agent({ agent: "codex" }) };
  assert.deepEqual(await rootSession(bare, env), { gone: true });
});

test("the headless context carries the installed model registry Pi launches discover through", () => {
  const registry = { refresh: async () => ({}) };
  assert.equal(headlessContext("/p", {}, registry).modelRegistry, registry);
  assert.equal(headlessContext("/p", {}).modelRegistry, undefined);
});
