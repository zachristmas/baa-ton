import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SELF_UPDATE_CHECK_MS, createSelfUpdater } from "../self-update.mjs";

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

test("a commit that fails its tests is never applied and is reported once", async () => {
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
    assert.ok(result.events.some((event) => /failed npm test; not deployed/.test(event)));
    assert.equal(git(r.installed, "rev-parse", "HEAD"), before);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].title, "Baa-ton update failed its tests");
    time.advance(SELF_UPDATE_CHECK_MS + 1);
    await updater.tick();
    await settle();
    await updater.tick();
    assert.equal(runs, 1, "the same red commit is not retested");
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

test("an idle Pi root on older code gets /reload once per commit; a busy one waits", async () => {
  const r = await repos();
  try {
    const old = git(r.installed, "rev-parse", "HEAD");
    const target = await r.advance("two\n");
    git(r.installed, "pull", "-q", "--ff-only");
    let status = "working";
    const prompts = [];
    const updater = createSelfUpdater({
      configDir: r.configDir,
      ownCheckout: r.installed,
      env: {},
      startTests: async () => ({ ok: true, output: "" }),
      runtime: () => [{ role: "extension", checkout: r.installed, commit: old, paneId: "w1:p1", agentKind: "pi" }],
      ready: async (paneId, expected) => {
        assert.deepEqual(expected, { pane_id: "w1:p1", agent_kind: "pi" });
        return { ok: true, agent: { agent_status: status } };
      },
      prompt: async (paneId, text) => prompts.push({ paneId, text }),
    });
    await updater.tick();
    assert.equal(prompts.length, 0, "never mid-turn");
    status = "idle";
    const result = await updater.tick();
    assert.deepEqual(prompts, [{ paneId: "w1:p1", text: "/reload" }]);
    assert.ok(result.events.includes(`reloaded the root in w1:p1 onto ${target.slice(0, 12)}`));
    await updater.tick();
    assert.equal(prompts.length, 1, "once per commit");
  } finally {
    await r.cleanup();
  }
});
