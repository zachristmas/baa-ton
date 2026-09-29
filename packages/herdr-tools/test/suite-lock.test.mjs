import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SUITE_LOCK_TOOL, integrateObjective, syncObjective, verifyObjective } from "../spec-driver.mjs";
import { validateSpec } from "../spec.mjs";
import { EXIT_LOCK_TIMEOUT, acquireSuiteLock, parseSuiteLockArgs, runWithSuiteLock, suiteLockPath } from "../suite-lock.mjs";

const tool = fileURLToPath(new URL("../suite-lock.mjs", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } });

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "baa-suite-lock-"));
  const main = join(root, "main");
  await mkdir(main);
  git(main, "init", "-q", "-b", "main");
  await writeFile(join(main, "a.txt"), "a\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  return { root, main, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const runCli = (cwd, args) =>
  new Promise((resolveRun) => {
    const child = spawn(process.execPath, [tool, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => resolveRun({ code, stderr }));
  });

test("two suites started together in one worktree run one after the other, never at once (sync validation and an integration linted concurrently)", async () => {
  const r = await repo();
  try {
    const log = join(r.root, "order.log");
    const suite = (name) => ["--label", name, "--", process.execPath, "-e", `const fs=require("fs");fs.appendFileSync(${JSON.stringify(log)},"${name} start\\n");setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)},"${name} end\\n")},1200)`];
    const first = runCli(r.main, suite("sync"));
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    const second = runCli(r.main, suite("integrate"));
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual([a.code, b.code], [0, 0]);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), ["sync start", "sync end", "integrate start", "integrate end"]);
    assert.equal(existsSync(await suiteLockPath(r.main)), false, "released");
  } finally {
    await r.cleanup();
  }
});

test("the command's exit code comes back, and the lock is released however it ended", async () => {
  const r = await repo();
  try {
    assert.equal(await runWithSuiteLock([process.execPath, "-e", "process.exit(3)"], { cwd: r.main }), 3);
    assert.equal(existsSync(await suiteLockPath(r.main)), false);
    assert.equal(await runWithSuiteLock(["definitely-not-a-command-xyz"], { cwd: r.main, log: () => undefined }), 127);
    assert.equal(existsSync(await suiteLockPath(r.main)), false);
    assert.equal(await runWithSuiteLock([process.execPath, "-e", "process.kill(process.pid,'SIGTERM')"], { cwd: r.main }), 143);
    assert.equal(existsSync(await suiteLockPath(r.main)), false);
  } finally {
    await r.cleanup();
  }
});

test("a lock left by a wrapper that was killed is reclaimed at once; a live holder is waited on and reported", async () => {
  const r = await repo();
  try {
    const lockPath = await suiteLockPath(r.main);
    const dead = spawnSync(process.execPath, ["-e", ""]);
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: dead.pid, boot: new Date(Date.now() - 1000).toISOString(), token: "gone", created_at: new Date().toISOString(), label: "killed lane" }));
    assert.equal(await runWithSuiteLock([process.execPath, "-e", ""], { cwd: r.main, waitMs: 5_000 }), 0, "stale: taken over");
    // A live holder (this process): the next waits, says who it waits for, and gives up on time.
    const release = await acquireSuiteLock(lockPath, { label: "long suite", command: "pnpm turbo run lint" });
    const notices = [];
    await assert.rejects(
      acquireSuiteLock(lockPath, { waitMs: 400, pollMs: 50, noticeMs: 0, onWait: (owner, waited) => notices.push([owner.label, owner.pid, waited >= 0]) }),
      (error) => error.code === EXIT_LOCK_TIMEOUT && /was not free in/.test(error.message),
    );
    assert.deepEqual(notices[0], ["long suite", process.pid, true]);
    assert.equal(existsSync(lockPath), true, "the holder's lock is untouched");
    await release();
    assert.equal(existsSync(lockPath), false);
    // The CLI exits 75 when it can not get the lock in time.
    const held = await acquireSuiteLock(lockPath, { label: "holder" });
    const timedOut = await runCli(r.main, ["--wait-minutes", "0.01", "--", process.execPath, "-e", "process.exit(0)"]);
    assert.equal(timedOut.code, EXIT_LOCK_TIMEOUT);
    assert.match(timedOut.stderr, /suite lock: .*was not free/);
    await held();
  } finally {
    await r.cleanup();
  }
});

test("each worktree has its own lock; a plain folder gets a temp one; arguments are checked", async () => {
  const r = await repo();
  try {
    const linked = join(r.root, "linked");
    git(r.main, "worktree", "add", "-q", "-b", "other", linked);
    const [a, b] = [await suiteLockPath(r.main), await suiteLockPath(linked)];
    assert.notEqual(a, b, "lanes in different worktrees never wait on each other");
    assert.match(a, /\.git\/baa-ton-suite\.lock$/);
    assert.match(b, /\.git\/worktrees\/linked\/baa-ton-suite\.lock$/);
    const plain = join(r.root, "plain");
    await mkdir(plain);
    assert.match(await suiteLockPath(plain), /baa-ton-suite-[0-9a-f]{16}\.lock$/);
    // Two worktrees really run at once.
    const log = join(r.root, "both.log");
    const script = (name) => ["--", process.execPath, "-e", `const fs=require("fs");fs.appendFileSync(${JSON.stringify(log)},"${name} start\\n");setTimeout(()=>fs.appendFileSync(${JSON.stringify(log)},"${name} end\\n"),600)`];
    await Promise.all([runCli(r.main, script("main")), runCli(linked, script("linked"))]);
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    assert.deepEqual(lines.slice(0, 2).sort(), ["linked start", "main start"], "both started before either ended");
    assert.deepEqual(parseSuiteLockArgs(["--wait-minutes", "5", "--label", "x", "--", "pnpm", "test"]), { argv: ["pnpm", "test"], label: "x", waitMs: 300_000 });
    assert.deepEqual(parseSuiteLockArgs(["--", "ls"]), { argv: ["ls"], label: "" });
    assert.throws(() => parseSuiteLockArgs(["pnpm", "test"]), /usage/);
    assert.throws(() => parseSuiteLockArgs(["--"]), /usage/);
    assert.throws(() => parseSuiteLockArgs(["--wait-minutes", "soon", "--", "ls"]), /number of minutes/);
    void appendFile;
  } finally {
    await r.cleanup();
  }
});

test("the lane objectives that run suites tell the lane to run them through the worktree's suite lock", () => {
  assert.equal(SUITE_LOCK_TOOL, tool, "the path lanes are given is the tool itself");
  const spec = validateSpec({ version: 1, target: { repo: ".", remote: "origin", branch: "main", suite: ["pnpm turbo run typecheck lint test"] }, items: [{ id: "A", title: "Item", acceptance: { text: "a", tests: ["npm test"] } }] });
  const item = spec.items[0];
  for (const objective of [
    integrateObjective(spec, item, { integrationBranch: "spec-integration", itemBranch: "spec/A" }),
    syncObjective(spec, { targetSha: "e".repeat(40), integrationBranch: "spec-integration" }),
    verifyObjective(spec, item, { reportPath: "", tests: ["npm test"], testsOnly: true }),
  ]) {
    assert.match(objective, new RegExp(`through this worktree's suite lock[\\s\\S]*node "${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" -- <command>`));
    assert.match(objective, /put environment assignments such as DATABASE_URL=\.\.\. before node/);
    assert.match(objective, /never remove it, and never stop another lane's suite/);
  }
});
