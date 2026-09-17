import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveFastForward, parseFastForward } from "../fast-forward-approval.mjs";
const exec = promisify(execFile);
const sha = "a".repeat(40);

test("only exact standalone fast-forwards are approval candidates", () => {
  for (const prefix of ["git", "rtk git", "rtk proxy git"])
    assert.deepEqual(parseFastForward(`${prefix} -C '/tmp/sample project' merge --ff-only ${sha}`), { cwd: "/tmp/sample project", commit: sha });
  for (const command of [
    `git merge-base --is-ancestor ${sha} HEAD`, `git merge ${sha}`,
    `git merge --ff-only main`, `git merge --ff-only ${sha.slice(0, 7)}`,
    `git merge --ff-only ${sha}; git push`, `git merge --ff-only ${sha}\ngit push`,
    `git merge --ff-only ${sha} && echo ok`, `git merge --ff-only ${sha} > out`,
    `git merge --ff-only ${sha} &`, `git -c core.hooksPath=/tmp merge --ff-only ${sha}`,
    `git -C "$(echo /tmp)" merge --ff-only ${sha}`, `git -C "$HOME" merge --ff-only ${sha}`,
    `git merge --ff-only ${sha} --no-verify`,
  ]) assert.equal(parseFastForward(command), null, command);
});

test("approval is root-only, exact, fresh, clean and non-mutating", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baa-ff-"));
  const git = async (args) => (await exec("git", args, { env: { ...process.env,
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
  } })).stdout.trim();
  const run = (...args) => git(["-C", dir, ...args]);
  try {
    await run("init", "-b", "main");
    await writeFile(join(dir, "status.txt"), "pending\n");
    await run("add", "status.txt"); await run("commit", "-m", "base");
    const base = await run("rev-parse", "HEAD");
    await run("checkout", "-b", "writer");
    await writeFile(join(dir, "status.txt"), "ready\n");
    await run("commit", "-am", "writer");
    const target = await run("rev-parse", "HEAD");
    await run("checkout", "main");
    const command = `git -C '${dir}' merge --ff-only ${target}`;
    let owner = "root-one", prompts = 0, response = true;
    let onConfirm = async () => {};
    const ctx = { cwd: dir, mode: "tui", hasUI: true, ui: { async confirm(title, body) {
      prompts++; assert.match(title, /fast-forward/);
      for (const value of [dir, base, target, "refs/heads/main", command]) assert.ok(body.includes(value));
      await onConfirm(); return response;
    } } };
    const ports = { git, rootIdentity: () => owner };
    const check = () => approveFastForward(command, ctx, ports);
    owner = null; await assert.rejects(check, /verified controller/); assert.equal(prompts, 0);
    owner = "root-one"; ctx.hasUI = false;
    await assert.rejects(check, /native TUI/); assert.equal(prompts, 0); ctx.hasUI = true;
    response = false; assert.equal(await check(), false);
    response = true; assert.equal(await check(), true);
    assert.equal(await run("rev-parse", "HEAD"), base, "approval never executes the merge");
    onConfirm = async () => { owner = "root-two"; };
    await assert.rejects(check, /registration changed/); owner = "root-one";
    onConfirm = async () => { await writeFile(join(dir, "untracked"), "changed"); };
    await assert.rejects(check, /must be clean/);
    const count = prompts; await assert.rejects(check, /must be clean/); assert.equal(prompts, count);
    await rm(join(dir, "untracked"));
    onConfirm = async () => { await run("checkout", "-b", "different"); };
    await assert.rejects(check, /Checkout changed/);
    await run("checkout", "main");
    onConfirm = async () => {};
    await writeFile(join(dir, "other.txt"), "diverged\n");
    await run("add", "other.txt"); await run("commit", "-m", "divergence");
    const before = prompts; await assert.rejects(check); assert.equal(prompts, before, "non-fast-forward rejected before approval");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
