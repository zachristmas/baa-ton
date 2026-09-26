import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RELOAD_BUSY_MS, SELF_UPDATE_CHECK_MS, SPAWN_SLOW_MS, createSelfUpdater } from "../self-update.mjs";

// Hermetic git: no global or system config (signing, hooks, aliases).
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

async function repos() {
  const directory = await mkdtemp(join(tmpdir(), "baa-self-update-"));
  const origin = join(directory, "origin.git");
  const work = join(directory, "work");
  const installed = join(directory, "installed");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: GIT_ENV });
  execFileSync("git", ["clone", "-q", origin, work], { env: GIT_ENV });
  git(work, "checkout", "-q", "-b", "main");
  await writeFile(join(work, "a.txt"), "one\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-q", "-m", "one");
  git(work, "push", "-q", "origin", "main");
  execFileSync("git", ["clone", "-q", "-b", "main", origin, installed], { env: GIT_ENV });
  const advance = async (text) => {
    await writeFile(join(work, "a.txt"), text);
    git(work, "commit", "-q", "-am", text.trim());
    git(work, "push", "-q", "origin", "main");
    return git(work, "rev-parse", "HEAD");
  };
  return { directory, installed, advance, configDir: join(directory, "config"), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function clock(start = "2026-09-25T12:00:00.000Z") {
  let at = Date.parse(start);
  return { now: () => new Date(at).toISOString(), advance: (ms) => (at += ms) };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a new main is tested in a scratch worktree, then fast-forwarded into the installed checkout", async () => {
  const r = await repos();
  try {
    const target = await r.advance("two\n");
    const time = clock();
    const notes = [];
    const runs = [];
    const updater = createSelfUpdater({
      configDir: r.configDir,
      ownCheckout: r.installed,
      now: time.now,
      env: {},
      notify: async (note) => notes.push(note),
      startTests: async ({ dir, install }) => {
        runs.push({ dir, install, file: await readFile(join(dir, "a.txt"), "utf8") });
        return { ok: true, output: "# pass 1" };
      },
    });
    const first = await updater.tick();
    assert.deepEqual(first.events, [`testing ${target.slice(0, 12)} before deploying`]);
    assert.equal(runs[0].file, "two\n", "the tests run on the new commit, not the installed one");
    assert.equal(runs[0].install, false, "no lockfile change: no install");
    assert.equal(git(r.installed, "rev-parse", "HEAD") === target, false, "nothing applied before the tests finish");
    await settle();
    const second = await updater.tick();
    assert.equal(git(r.installed, "rev-parse", "HEAD"), target);
    assert.ok(second.events.some((event) => event.includes(`-> ${target.slice(0, 12)}`)));
    assert.equal(notes.at(-1).title, "Baa-ton updated");
    const state = JSON.parse(await readFile(join(r.configDir, "self-update.json"), "utf8"));
    assert.equal(state.tested[target].result, "pass");
    assert.equal(state.updatedTo, target);
    // Nothing new: the next check does nothing, and not before the interval.
    time.advance(60_000);
    assert.deepEqual((await updater.tick()).events, []);
  } finally {
    await r.cleanup();
  }
});

test("a commit that fails its tests three times is never applied and is reported once", async () => {
  const r = await repos();
  try {
    const before = git(r.installed, "rev-parse", "HEAD");
    await r.advance("broken\n");
    const time = clock();
    const notes = [];
    let runs = 0;
    const updater = createSelfUpdater({
      configDir: r.configDir,
      ownCheckout: r.installed,
      now: time.now,
      env: {},
      notify: async (note) => notes.push(note),
      startTests: async () => {
        runs += 1;
        return { ok: false, output: "not ok 3 - something" };
      },
    });
    await updater.tick();
    await settle();
    const result = await updater.tick();
    assert.ok(result.events.some((event) => /failed npm test \(run 1 of 3\); retrying/.test(event)), "a red run may be the machine: it is retried");
    assert.equal(notes.length, 0, "nothing reported before the last run");
    for (const run of [2, 3]) {
      time.advance(SELF_UPDATE_CHECK_MS + 1);
      await updater.tick();
      await settle();
      const next = await updater.tick();
      if (run === 3) assert.ok(next.events.some((event) => /failed npm test 3 times; not deployed/.test(event)));
    }
    assert.equal(git(r.installed, "rev-parse", "HEAD"), before);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].title, "Baa-ton update failed its tests");
    time.advance(SELF_UPDATE_CHECK_MS + 1);
    await updater.tick();
    await settle();
    await updater.tick();
    assert.equal(runs, 3, "a commit red three times is not retested");
    assert.equal(notes.length, 1, "nor reported again");
  } finally {
    await r.cleanup();
  }
});

test("a dirty or diverged checkout is left alone; the switch turns it all off", async () => {
  const r = await repos();
  try {
    await r.advance("two\n");
    await writeFile(join(r.installed, "a.txt"), "local edit\n");
    let runs = 0;
    const updater = createSelfUpdater({ configDir: r.configDir, ownCheckout: r.installed, env: {}, startTests: async () => ((runs += 1), { ok: true, output: "" }) });
    const result = await updater.tick();
    assert.ok(result.events.some((event) => event.endsWith("has uncommitted changes")));
    assert.equal(runs, 0);
    const off = createSelfUpdater({ configDir: r.configDir, ownCheckout: r.installed, env: { BAATON_SELF_UPDATE: "0" } });
    assert.deepEqual(await off.tick(), { disabled: true });
  } finally {
    await r.cleanup();
  }
});

test("a root on older code gets /reload when idle or done and no dialog is open; it retries until the record confirms it", async () => {
  const r = await repos();
  try {
    const old = git(r.installed, "rev-parse", "HEAD");
    const target = await r.advance("two\n");
    git(r.installed, "pull", "-q", "--ff-only");
    const time = clock();
    let status = "working";
    let dialog = false;
    let loaded = old;
    const prompts = [];
    const notes = [];
    const updater = createSelfUpdater({
      configDir: r.configDir,
      ownCheckout: r.installed,
      env: {},
      now: time.now,
      notify: async (note) => notes.push(note),
      startTests: async () => ({ ok: true, output: "" }),
      runtime: () => [
        { role: "extension", checkout: r.installed, commit: loaded, paneId: "w1:p1", agentKind: "pi" },
        // A Pi lane runs the same extension: never reloaded by the updater.
        { role: "extension", checkout: r.installed, commit: old, paneId: "w1:p40", agentKind: "pi" },
      ],
      rootPanes: async () => new Set(["w1:p1"]),
      dialogOpen: async () => dialog,
      ready: async (paneId, expected) => {
        assert.deepEqual(expected, { pane_id: "w1:p1", agent_kind: "pi" });
        return { ok: true, agent: { agent_status: status } };
      },
      prompt: async (paneId, text) => prompts.push({ paneId, text }),
    });
    await updater.tick();
    assert.equal(prompts.length, 0, "never mid-turn");
    status = "done";
    dialog = true;
    let result = await updater.tick();
    assert.equal(prompts.length, 0, "never into a dialog");
    assert.ok(result.events.includes("root reload in w1:p1 waits: a dialog is on screen"));
    dialog = false;
    time.advance(61_000);
    result = await updater.tick();
    assert.deepEqual(prompts, [{ paneId: "w1:p1", text: "/reload" }]);
    assert.ok(result.events.includes(`sent /reload to the root in w1:p1 onto ${target.slice(0, 12)} (attempt 1)`));
    await updater.tick();
    assert.equal(prompts.length, 1, "it waits a minute for the runtime record to confirm");
    // The record still shows the old commit: the reload did not take; retry.
    time.advance(61_000);
    await updater.tick();
    assert.equal(prompts.length, 2);
    loaded = target;
    result = await updater.tick();
    assert.ok(result.events.includes(`root reload in w1:p1 confirmed on ${target.slice(0, 12)}`));
    time.advance(120_000);
    await updater.tick();
    assert.equal(prompts.length, 2, "confirmed: no more reloads");
    assert.equal(notes.filter((note) => note.title === "Baa-ton: root did not reload").length, 0);
  } finally {
    await r.cleanup();
  }
});

test("a reload that never shows up is tried 5 times, then the user is told once", async () => {
  const r = await repos();
  try {
    const old = git(r.installed, "rev-parse", "HEAD");
    await r.advance("two\n");
    git(r.installed, "pull", "-q", "--ff-only");
    const time = clock();
    const prompts = [];
    const notes = [];
    const updater = createSelfUpdater({
      configDir: r.configDir,
      ownCheckout: r.installed,
      env: {},
      now: time.now,
      notify: async (note) => notes.push(note),
      startTests: async () => ({ ok: true, output: "" }),
      runtime: () => [{ role: "extension", checkout: r.installed, commit: old, paneId: "w1:p1", agentKind: "pi" }],
      rootPanes: async () => new Set(["w1:p1"]),
      ready: async () => ({ ok: true, agent: { agent_status: "idle" } }),
      prompt: async (paneId, text) => prompts.push({ paneId, text }),
    });
    for (let step = 0; step < 8; step += 1) {
      await updater.tick();
      time.advance(61_000);
    }
    assert.equal(prompts.length, 5);
    assert.equal(notes.filter((note) => note.title === "Baa-ton: root did not reload").length, 1);
  } finally {
    await r.cleanup();
  }
});

test("while starting a process is slow the test run waits, then runs once the machine recovers", async () => {
  const r = await repos();
  try {
    await r.advance("two\n");
    const time = clock();
    let delay = SPAWN_SLOW_MS + 20_000;
    let runs = 0;
    const updater = createSelfUpdater({
      configDir: r.configDir,
      ownCheckout: r.installed,
      env: {},
      now: time.now,
      spawnProbe: async () => delay,
      startTests: async () => ((runs += 1), { ok: true, output: "" }),
    });
    const first = await updater.tick();
    assert.ok(first.events.some((event) => /waits: starting a process takes 25s/.test(event)));
    assert.equal(runs, 0);
    time.advance(SELF_UPDATE_CHECK_MS + 1);
    const second = await updater.tick();
    assert.equal(second.events.length, 0, "the wait is logged once");
    delay = 50;
    time.advance(SELF_UPDATE_CHECK_MS + 1);
    await updater.tick();
    await settle();
    await updater.tick();
    assert.equal(runs, 1);
    assert.equal(git(r.installed, "rev-parse", "HEAD"), git(r.installed, "rev-parse", "origin/main"));
  } finally {
    await r.cleanup();
  }
});

test("a root that never goes idle for /reload is reported once, not waited on in silence", async () => {
  const r = await repos();
  try {
    const old = git(r.installed, "rev-parse", "HEAD");
    await r.advance("two\n");
    git(r.installed, "pull", "-q", "--ff-only");
    const time = clock();
    const anomalies = [];
    const prompts = [];
    let status = "working";
    const updater = createSelfUpdater({
      configDir: r.configDir,
      ownCheckout: r.installed,
      env: {},
      now: time.now,
      startTests: async () => ({ ok: true, output: "" }),
      runtime: () => [{ role: "extension", checkout: r.installed, commit: old, paneId: "w1:p1", agentKind: "pi" }],
      rootPanes: async () => new Set(["w1:p1"]),
      ready: async () => ({ ok: true, agent: { agent_status: status } }),
      prompt: async (paneId, text) => prompts.push({ paneId, text }),
      anomaly: async (anomaly) => anomalies.push(anomaly),
    });
    await updater.tick();
    time.advance(RELOAD_BUSY_MS - 60_000);
    await updater.tick();
    assert.equal(anomalies.length, 0);
    time.advance(60_000);
    const due = await updater.tick();
    assert.ok(due.events.some((event) => /still waiting: the root has been working for 30 min/.test(event)));
    time.advance(60_000);
    await updater.tick();
    assert.equal(anomalies.length, 1, "reported once");
    assert.equal(anomalies[0].kind, "reload-unconfirmed");
    assert.equal(prompts.length, 0, "never typed into a working root");
    status = "idle";
    await updater.tick();
    assert.equal(prompts.length, 1, "sent as soon as the root is idle");
  } finally {
    await r.cleanup();
  }
});

test("runtime records of ended processes are pruned", async () => {
  const { pruneRuntime, listRuntime } = await import("../code-version.mjs");
  const directory = await mkdtemp(join(tmpdir(), "baa-runtime-"));
  try {
    const { mkdir: makeDir } = await import("node:fs/promises");
    await makeDir(join(directory, "runtime"), { recursive: true });
    await writeFile(join(directory, "runtime", `bridge-${process.pid}.json`), JSON.stringify({ role: "bridge", pid: process.pid }));
    // A child that has already exited: its pid is gone.
    const { spawnSync } = await import("node:child_process");
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
    await writeFile(join(directory, "runtime", `bridge-${dead}.json`), JSON.stringify({ role: "bridge", pid: Number(dead) }));
    await writeFile(join(directory, "runtime", "extension-99999999.json"), "not json");
    assert.equal(pruneRuntime(directory), 2);
    assert.deepEqual(listRuntime(directory).map((record) => record.pid), [process.pid], "the live record stays");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
