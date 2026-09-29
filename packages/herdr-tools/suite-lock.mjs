#!/usr/bin/env node
/**
 * One suite at a time per worktree (docs/SELF-HEALING.md). Two lanes ran the
 * full-repo lint at once in the same spec-integration worktree (a sync
 * validation and an integration), each starving the other. A lane runs its
 * long suite commands through this wrapper: it takes the worktree's lock,
 * waits its turn behind whoever holds it, runs the command with the lane's
 * own terminal and exit code, and releases the lock however the command ends.
 *
 * The lock is a directory next to the worktree's git metadata, held while its
 * owner (boot, pid, token: inbox/lock-owner.mjs) is alive: a wrapper that was
 * killed leaves a stale lock that the next one reclaims.
 *
 * Usage: node suite-lock.mjs [--wait-minutes N] [--label <text>] -- <command> [args...]
 * Exit codes: the command's; 75 when the lock was not free in time; 2 for usage.
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ownerHeldSync, ownerRecord, reclaimLockDir } from "./inbox/lock-owner.mjs";

export const DEFAULT_WAIT_MINUTES = 180;
export const POLL_MS = 2_000;
export const NOTICE_MS = 60_000;
export const EXIT_LOCK_TIMEOUT = 75;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** The lock directory of the worktree at `cwd`: inside its own git dir, else a temp path keyed by the directory. */
export async function suiteLockPath(cwd = process.cwd()) {
  try {
    const gitDir = execFileSync("git", ["-C", cwd, "rev-parse", "--git-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return join(isAbsolute(gitDir) ? gitDir : resolve(cwd, gitDir), "baa-ton-suite.lock");
  } catch {
    const key = createHash("sha256").update(await realpath(cwd).catch(() => resolve(cwd))).digest("hex").slice(0, 16);
    return join(tmpdir(), `baa-ton-suite-${key}.lock`);
  }
}

/**
 * Take the lock, waiting behind a live holder. Resolves to `release()`.
 * `onWait(owner, waitedMs)` is called about once a minute while waiting.
 * Rejects (code EXIT_LOCK_TIMEOUT) when it is not free within `waitMs`.
 */
export async function acquireSuiteLock(lockPath, { label = "", command = "", waitMs = DEFAULT_WAIT_MINUTES * 60_000, pollMs = POLL_MS, noticeMs = NOTICE_MS, onWait = () => undefined, held = (owner) => ownerHeldSync(owner) } = {}) {
  const started = Date.now();
  let lastNotice = 0;
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const owner = ownerRecord({ extra: { label, command: command.slice(0, 300), cwd: process.cwd() } });
      await writeFile(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      return async () => {
        // Only our own lock: one reclaimed from us (a clock step, a stall) is left to its new holder.
        const current = await readFile(join(lockPath, "owner.json"), "utf8").then((text) => JSON.parse(text), () => undefined);
        if (!current || current.token === owner.token) await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (await reclaimLockDir(lockPath, { held }).catch(() => false)) continue;
    const waited = Date.now() - started;
    if (waited >= waitMs) throw Object.assign(new Error(`the suite lock ${lockPath} was not free in ${Math.round(waitMs / 60_000)} min`), { code: EXIT_LOCK_TIMEOUT });
    if (Date.now() - lastNotice >= noticeMs) {
      lastNotice = Date.now();
      const owner = await readFile(join(lockPath, "owner.json"), "utf8").then((text) => JSON.parse(text), () => undefined);
      onWait(owner, waited);
    }
    await sleep(pollMs);
  }
}

/** Run `argv` holding the worktree's suite lock; resolves to the command's exit code. */
export async function runWithSuiteLock(argv, { cwd = process.cwd(), label = "", waitMs, pollMs, noticeMs, log = (line) => process.stderr.write(`${line}\n`), held } = {}) {
  const lockPath = await suiteLockPath(cwd);
  const release = await acquireSuiteLock(lockPath, {
    label,
    command: argv.join(" "),
    waitMs,
    pollMs,
    noticeMs,
    held,
    onWait: (owner, waited) =>
      log(`suite lock: waiting ${Math.round(waited / 1000)} s for ${owner?.label || owner?.command || "another suite"} in this worktree (pid ${owner?.pid ?? "?"}, since ${owner?.created_at ?? "?"}); one suite runs at a time here.`),
  });
  try {
    return await new Promise((resolveRun) => {
      const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", cwd });
      const forward = (signal) => () => child.kill(signal);
      const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [signal, forward(signal)]);
      for (const [signal, handler] of handlers) process.on(signal, handler);
      const done = (code) => {
        for (const [signal, handler] of handlers) process.off(signal, handler);
        resolveRun(code);
      };
      child.once("error", (error) => {
        log(`suite lock: could not run ${argv[0]}: ${error.message}`);
        done(127);
      });
      child.once("exit", (code, signal) => done(code ?? (signal ? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 }[signal] ?? 1) : 1)));
    });
  } finally {
    await release();
  }
}

export function parseSuiteLockArgs(args) {
  const split = args.indexOf("--");
  if (split < 0 || split === args.length - 1) throw new Error("usage: node suite-lock.mjs [--wait-minutes N] [--label <text>] -- <command> [args...]");
  const options = args.slice(0, split);
  const flag = (name) => {
    const index = options.indexOf(name);
    return index >= 0 ? options[index + 1] : undefined;
  };
  const minutes = flag("--wait-minutes");
  const waitMs = minutes === undefined ? undefined : Number(minutes) * 60_000;
  if (waitMs !== undefined && !(waitMs >= 0)) throw new Error("--wait-minutes must be a number of minutes");
  return { argv: args.slice(split + 1), label: flag("--label") ?? "", ...(waitMs === undefined ? {} : { waitMs }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { argv, label, waitMs } = parseSuiteLockArgs(process.argv.slice(2));
    process.exitCode = await runWithSuiteLock(argv, { label, ...(waitMs === undefined ? {} : { waitMs }) });
  } catch (error) {
    process.stderr.write(`suite lock: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error?.code === EXIT_LOCK_TIMEOUT ? EXIT_LOCK_TIMEOUT : 2;
  }
}
