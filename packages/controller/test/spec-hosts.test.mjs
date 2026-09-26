import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { HOST_RESTART_MAX_MS, HOST_RESTART_MIN_MS, ROOT_TURN_LIMIT_MS, createRootTurnWatch, createSpecHosts, specRoots } from "../spec-hosts.mjs";

const root = (id, { kind = "pi", project = `/p/${id}` } = {}) => ({ id, root: { pane_id: `${id}:p1`, workspace_id: id, agent_kind: kind }, program: { id: project, parent_manifest_path: `${project}/.baa-ton/herdr-orchestrator/manifest.json` } });

function fakeChild(pid) {
  const child = new EventEmitter();
  Object.assign(child, { pid, exitCode: null, signalCode: null, killed: [] });
  child.kill = (signal) => child.killed.push(signal);
  child.die = (code = 1) => {
    child.exitCode = code;
    child.emit("exit", code, null);
  };
  return child;
}

test("spec roots are Pi roots whose project has a spec", () => {
  const withSpec = new Set(["/p/a/.baa-ton/spec.json", "/p/c/.baa-ton/spec.json"]);
  const config = { orchestrators: [root("a"), root("b"), root("c", { kind: "claude" })] };
  assert.deepEqual(specRoots(config, (path) => withSpec.has(path)).map((o) => o.id), ["a"]);
});

test("one spec host per spec root: started, restarted with backoff, stopped with the supervisor", async () => {
  let clock = 0;
  const spawned = [];
  const lines = [];
  let config = { orchestrators: [root("a")] };
  const hosts = createSpecHosts({
    configDir: "/cfg",
    loadConfig: async () => config,
    exists: () => true,
    clock: () => clock,
    log: (line) => lines.push(line),
    spawnHost: ({ orchestrator, configDir }) => {
      const child = fakeChild(100 + spawned.length);
      spawned.push({ orchestrator: orchestrator.id, configDir, child });
      return child;
    },
  });
  await hosts.tick();
  await hosts.tick();
  assert.equal(spawned.length, 1, "one host, kept");
  assert.equal(spawned[0].configDir, "/cfg");
  // Dies right away: backs off, doubling.
  clock += 1_000;
  spawned[0].child.die(1);
  await hosts.tick();
  assert.equal(spawned.length, 1, "waits out the backoff");
  clock += 2 * HOST_RESTART_MIN_MS;
  await hosts.tick();
  assert.equal(spawned.length, 2);
  assert.match(lines.find((line) => /exited/.test(line)), /restarting in 60s/);
  for (let index = 0; index < 8; index += 1) {
    clock += 1_000;
    spawned.at(-1).child.die(1);
    clock += HOST_RESTART_MAX_MS;
    await hosts.tick();
  }
  assert.match(lines.filter((line) => /exited/.test(line)).at(-1), new RegExp(`restarting in ${HOST_RESTART_MAX_MS / 1000}s`), "capped");
  // The root loses its spec: its host stops.
  config = { orchestrators: [] };
  await hosts.tick();
  assert.deepEqual(spawned.at(-1).child.killed, ["SIGTERM"]);
  assert.equal(hosts.size, 0);
  config = { orchestrators: [root("a")] };
  await hosts.tick();
  hosts.stop();
  assert.deepEqual(spawned.at(-1).child.killed, ["SIGTERM"], "stop ends every host");
});

test("without the host script (an older checkout) nothing starts", async () => {
  let spawned = 0;
  const hosts = createSpecHosts({ configDir: "/cfg", loadConfig: async () => ({ orchestrators: [root("a")] }), exists: (path) => !/spec-host\.mjs$/.test(path), spawnHost: () => ((spawned += 1), fakeChild(1)) });
  await hosts.tick();
  assert.equal(spawned, 0);
});

test("a root turn of 30 minutes is interrupted once and reported; a turn that ends resets the clock", async () => {
  let clock = 0;
  let status = "working";
  const interrupts = [];
  const anomalies = [];
  const watch = createRootTurnWatch({
    loadConfig: async () => ({ orchestrators: [root("a")] }),
    status: async () => status,
    interrupt: async (paneId) => interrupts.push(paneId),
    anomaly: async (anomaly) => anomalies.push(anomaly),
    clock: () => clock,
  });
  await watch.tick();
  clock += ROOT_TURN_LIMIT_MS - 1;
  await watch.tick();
  assert.equal(interrupts.length, 0);
  clock += 1;
  await watch.tick();
  assert.deepEqual(interrupts, ["a:p1"]);
  assert.equal(anomalies[0].kind, "root-turn-too-long");
  assert.match(anomalies[0].summary, /30 min/);
  clock += 60_000;
  await watch.tick();
  assert.equal(interrupts.length, 1, "once per limit");
  // Idle, then a short turn: nothing.
  status = "idle";
  await watch.tick();
  status = "working";
  clock += 5 * 60_000;
  await watch.tick();
  clock += 10 * 60_000;
  await watch.tick();
  assert.equal(interrupts.length, 1);
  // Unknown status is not a turn.
  status = undefined;
  clock += ROOT_TURN_LIMIT_MS;
  await watch.tick();
  assert.equal(interrupts.length, 1);
});
