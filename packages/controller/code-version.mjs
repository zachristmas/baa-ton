/**
 * Which Baa-ton code a running piece loaded, compared with what is on disk.
 *
 * Every long-running piece (the controller supervisor, a root's extension,
 * each lane's MCP bridge) records the fingerprint of the checkout it loaded in
 * <controller config dir>/runtime/<role>-<pid>.json. herdr_doctor compares the
 * records with the installed checkout to find version skew, and the supervisor
 * re-execs itself when its own code changes on disk.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The checkout this module was loaded from. */
export const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function codeFiles(root) {
  const files = [];
  const add = (directory, pattern) => {
    let names;
    try {
      names = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of names.sort()) if (pattern.test(name)) files.push(join(directory, name));
  };
  add(join(root, "packages", "controller"), /\.(mjs|toml|sh)$/);
  add(join(root, "packages", "herdr-tools"), /\.(ts|mjs|json)$/);
  add(join(root, "packages", "herdr-tools", "inbox"), /\.mjs$/);
  return files;
}

/** Cheap change detector: sizes and modification times of the code files. */
export function codeStamp(root = checkoutRoot) {
  return codeFiles(root)
    .map((path) => {
      try {
        const details = statSync(path);
        return `${relative(root, path)}:${details.size}:${details.mtimeMs}`;
      } catch {
        return `${relative(root, path)}:missing`;
      }
    })
    .join("|");
}

/** Content fingerprint of the code files (12 hex characters). */
export function codeFingerprint(root = checkoutRoot) {
  const hash = createHash("sha256");
  for (const path of codeFiles(root)) {
    hash.update(relative(root, path));
    hash.update("\0");
    try {
      hash.update(readFileSync(path));
    } catch {
      hash.update("missing");
    }
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

/** The checkout's commit, or undefined outside a Git checkout. */
export function gitCommit(root = checkoutRoot) {
  const result = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000 });
  const commit = result.status === 0 ? result.stdout.trim() : "";
  return /^[0-9a-f]{40}$/.test(commit) ? commit : undefined;
}

/** What this process loaded, captured once when it starts. */
export function loadedCode(root = checkoutRoot) {
  return { checkout: root, fingerprint: codeFingerprint(root), commit: gitCommit(root), stamp: codeStamp(root) };
}

/**
 * A function answering "has my code changed on disk?". It re-hashes only
 * when the cheap stamp changes, and reports a change only once the new
 * fingerprint is stable across two checks, so a half-finished `git pull` is
 * never acted on.
 */
export function codeChangeWatcher(loaded, root = loaded.checkout ?? checkoutRoot) {
  let lastStamp = loaded.stamp;
  let pending;
  return () => {
    const stamp = codeStamp(root);
    if (stamp === lastStamp && pending === undefined) return undefined;
    lastStamp = stamp;
    const fingerprint = codeFingerprint(root);
    if (fingerprint === loaded.fingerprint) {
      pending = undefined;
      return undefined;
    }
    if (pending === fingerprint) return fingerprint;
    pending = fingerprint;
    return undefined;
  };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function runtimeDirectory(configDir) {
  return join(configDir, "runtime");
}

/**
 * Record a running piece. Returns a function that removes the record; it is
 * also removed when the process exits normally. Never throws.
 */
export function recordRuntime(configDir, record) {
  if (!configDir) return () => {};
  const directory = runtimeDirectory(configDir);
  const path = join(directory, `${record.role}-${process.pid}.json`);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${Date.now()}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ ...record, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(temporary, path);
  } catch {
    return () => {};
  }
  const remove = () => {
    try {
      rmSync(path, { force: true });
    } catch {
      // Best effort; stale records are ignored once their process is gone.
    }
  };
  process.once("exit", remove);
  return remove;
}

/** Records of pieces whose process is still alive. */
export function listRuntime(configDir) {
  if (!configDir) return [];
  let names;
  try {
    names = readdirSync(runtimeDirectory(configDir));
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(runtimeDirectory(configDir), name), "utf8"));
      if (Number.isSafeInteger(record.pid) && processAlive(record.pid)) records.push(record);
    } catch {
      // Unreadable records are skipped.
    }
  }
  return records.sort((a, b) => String(a.role).localeCompare(String(b.role)) || a.pid - b.pid);
}
