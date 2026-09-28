import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HOOK_QUEUE_DIR, createSpawnWatch, drainHookQueue } from "../controller.mjs";

const run = promisify(execFile);
const pluginRoot = fileURLToPath(new URL("..", import.meta.url));

test("the event hook only queues the event (no Node process), and the supervisor handles the queue in order, once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-hook-queue-"));
  try {
    const env = { PATH: process.env.PATH, HERDR_PLUGIN_CONFIG_DIR: directory, HERDR_PLUGIN_STATE_DIR: directory, HERDR_PLUGIN_EVENT: "pane.agent_status_changed" };
    // A `node` that fails the test if the hook ever starts it.
    const bin = join(directory, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "node"), "#!/bin/sh\necho node-started >&2\nexit 7\n", { mode: 0o755 });
    for (const status of ["working", "done"])
      await run("sh", ["hook.sh"], { cwd: pluginRoot, env: { ...env, PATH: `${bin}:${env.PATH}`, HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ data: { pane_id: "w1:p2", agent_status: status } }) } });
    const queued = (await readdir(join(directory, HOOK_QUEUE_DIR))).filter((name) => name.endsWith(".event"));
    assert.equal(queued.length, 2);
    // Ordered by queue time.
    await utimes(join(directory, HOOK_QUEUE_DIR, queued[0]), new Date(Date.now() - 2_000), new Date(Date.now() - 2_000));
    const seen = [];
    const result = await drainHookQueue({
      configDir: directory,
      stateDir: directory,
      log: () => undefined,
      handle: async ({ eventName, eventJson }) => {
        seen.push(`${eventName} ${JSON.parse(eventJson).data.agent_status}`);
        return { accepted: true };
      },
    });
    assert.equal(result.handled, 2);
    assert.equal(seen.length, 2);
    assert.match(seen[0], /^pane\.agent_status_changed /);
    assert.deepEqual(await readdir(join(directory, HOOK_QUEUE_DIR)), [], "handled events leave the queue");
    assert.equal((await drainHookQueue({ configDir: directory, stateDir: directory, log: () => undefined, handle: async () => assert.fail("nothing left") })).handled, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a queue nobody drains for 2 min makes the hook run the Node fallback, one at a time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-hook-fallback-"));
  try {
    const queue = join(directory, HOOK_QUEUE_DIR);
    await mkdir(queue, { recursive: true });
    await writeFile(join(queue, "old.event"), "pane.agent_status_changed\n{}");
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(join(queue, "old.event"), old, old);
    const bin = join(directory, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "node"), `#!/bin/sh\necho "$@" >> "${join(directory, "node-calls")}"\n`, { mode: 0o755 });
    const env = { PATH: `${bin}:${process.env.PATH}`, HERDR_PLUGIN_CONFIG_DIR: directory, HERDR_PLUGIN_EVENT: "pane.agent_status_changed", HERDR_PLUGIN_EVENT_JSON: "{}" };
    await run("sh", ["hook.sh"], { cwd: pluginRoot, env });
    const { readFile } = await import("node:fs/promises");
    assert.equal((await readFile(join(directory, "node-calls"), "utf8")).trim(), "controller.mjs hook-drain");
    // Another fallback is running: this hook only queues.
    await mkdir(`${queue}.fallback`);
    await run("sh", ["hook.sh"], { cwd: pluginRoot, env });
    assert.equal((await readFile(join(directory, "node-calls"), "utf8")).trim().split("\n").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the spawn watch records the probe, logs throttle changes and reports orphaned shells once an hour", async () => {
  const logs = [];
  const recorded = [];
  const anomalies = [];
  let clock = 0;
  let ms = 4_000;
  const watch = createSpawnWatch({
    log: (message) => logs.push(message),
    measure: async () => ms,
    record: (probe) => recorded.push(probe),
    table: async () => [{ pid: 42, ppid: 1, ageMs: 3 * 86_400_000, line: "-zsh HOME=/u" }],
    anomaly: async (value) => anomalies.push(value),
    clock: () => clock,
  });
  await watch.tick();
  assert.deepEqual(recorded.map((probe) => [probe.ms, probe.throttled]), [[4_000, true]]);
  assert.match(logs[0], /^spawn probe: 4000 ms; dispatch throttled: one lane at a time$/);
  assert.match(logs[1], /orphaned shells older than a day: -zsh 42 \(3 d\)/);
  assert.equal(anomalies[0].kind, "orphan-shells");
  clock = 60_000;
  ms = 300;
  await watch.tick();
  assert.match(logs.at(-1), /^spawn probe: 300 ms; dispatch normal \(was throttled\)$/);
  assert.equal(anomalies.length, 1, "orphans are checked once an hour");
  clock = 120_000;
  await watch.tick();
  assert.equal(logs.length, 3, "an unchanged state is logged every 10 min only");
});
