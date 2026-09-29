import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { busyPorts, elapsedMs, killLaneProcesses, laneProcesses, orphanShells, parseProcessTable, portListening } from "../inbox/lane-processes.mjs";
import { readSpawnProbe, recordSpawnProbe, spawnThrottled, startupWait } from "../inbox/spawn-load.mjs";

const INTENT = "/state/herdr-d03-lane-1-startup.json";
const TABLE = [
  `  100     1   5-02:00:00 /bin/zsh -l HOME=/u`,
  `  200   100      10:00 node claude --model x BAA_STARTUP_INTENT=${INTENT} HOME=/u`,
  `  300     1    3:30:00 pnpm dev BAA_STARTUP_INTENT=${INTENT} HOME=/u`,
  `  301   300    3:30:00 vite --port 5173 HOME=/u`,
  `  400     1    3:30:00 pnpm dev BAA_STARTUP_INTENT=${INTENT}.other HOME=/u`,
  `  500     1   2-00:00:01 gitstatusd-darwin-arm64 -s 1 HOME=/u`,
  `  600   555      00:05 grep BAA_STARTUP_INTENT=${INTENT}x`,
].join("\n");

test("a lane's process tree: every process carrying its exact marker, reparented ones too, and their children", () => {
  const rows = parseProcessTable(TABLE);
  assert.equal(elapsedMs("5-02:00:00"), (5 * 24 + 2) * 3_600_000);
  assert.equal(elapsedMs("10:00"), 600_000);
  assert.deepEqual(laneProcesses(rows, INTENT, { self: 999 }).map((row) => row.pid), [200, 300, 301]);
  assert.deepEqual(laneProcesses(rows, INTENT, { self: 301 }).map((row) => row.pid), [200], "never this process or its ancestors");
  assert.deepEqual(laneProcesses(rows, undefined), []);
});

test("retire kills the tree: SIGTERM, then SIGKILL for what is left", async () => {
  let rows = parseProcessTable(TABLE);
  const signals = [];
  const result = await killLaneProcesses({
    intentPath: INTENT,
    table: async () => rows,
    kill: (pid, name) => {
      signals.push(`${name} ${pid}`);
      if (name === "SIGTERM" && pid !== 301) rows = rows.filter((row) => row.pid !== pid);
      if (name === "SIGKILL") rows = rows.filter((row) => row.pid !== pid);
    },
    delay: async () => undefined,
  });
  assert.deepEqual(signals, ["SIGTERM 200", "SIGTERM 300", "SIGTERM 301", "SIGKILL 301"]);
  assert.deepEqual(result.killed, [301]);
  assert.deepEqual(result.survivors, []);
});

test("ports are checked free after retire", async () => {
  const server = net.createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    assert.equal(await portListening(port), true);
    assert.deepEqual(await busyPorts([port]), [port]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(await busyPorts([port]), []);
});

test("orphaned shells older than a day are reported, live terminal shells are not", () => {
  const found = orphanShells(parseProcessTable(TABLE));
  assert.deepEqual(found.map((item) => item.pid), [100, 500]);
  assert.ok(found.every((item) => item.laneOwned === false), "unmarked shells are not lane-owned");
  assert.equal(orphanShells([{ pid: 9, ppid: 1, ageMs: 2 * 86_400_000, line: "-zsh BAA_STARTUP_INTENT=/x" }])[0].laneOwned, true);
});

test("startup waits scale with the process-start probe; over 2 s dispatch is throttled", async () => {
  assert.equal(startupWait(60_000, undefined), 60_000);
  assert.equal(startupWait(60_000, 50), 60_000, "a fast machine keeps the base wait");
  assert.equal(startupWait(60_000, 40_000), 120_000, "3x the probe");
  assert.equal(startupWait(60_000, 400_000), 300_000, "capped at 5 min");
  assert.equal(spawnThrottled(2_000), false);
  assert.equal(spawnThrottled(2_001), true);
  const directory = await mkdtemp(join(tmpdir(), "baa-probe-"));
  try {
    const env = { HERDR_PLUGIN_CONFIG_DIR: directory };
    recordSpawnProbe({ ms: 31_000, at: "2026-09-27T03:00:00.000Z" }, env);
    assert.equal(JSON.parse(await readFile(join(directory, "spawn-probe.json"), "utf8")).ms, 31_000);
    assert.equal(readSpawnProbe(env, { now: Date.parse("2026-09-27T03:05:00.000Z") }), 31_000);
    assert.equal(readSpawnProbe(env, { now: Date.parse("2026-09-27T03:20:00.000Z") }), undefined, "a stale probe is not used");
    assert.equal(readSpawnProbe({ ...env, BAA_TON_NO_SPAWN_PROBE: "1" }, { now: Date.parse("2026-09-27T03:05:00.000Z") }), undefined);
    await writeFile(join(directory, "spawn-probe.json"), "not json");
    assert.equal(readSpawnProbe(env), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
