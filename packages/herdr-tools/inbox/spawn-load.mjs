/**
 * How slowly this machine starts processes, measured by the supervisor and
 * shared through a file (docs/SELF-HEALING.md). When the OS vets every exec
 * slowly, lane startup waits scale with the probe (a slow machine means
 * slower lanes, not failed ones) and the spec driver starts one lane at a
 * time until the probe recovers.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Above this probe, dispatch starts at most one lane at a time. */
export const SPAWN_THROTTLE_MS = 2_000;
/** A startup wait is at least its base and at most this. */
export const STARTUP_WAIT_CAP_MS = 5 * 60_000;
/** A probe older than this is not used. */
export const SPAWN_PROBE_MAX_AGE_MS = 10 * 60_000;
export const SPAWN_PROBE_FILE = "spawn-probe.json";

export function spawnProbePath(env = process.env) {
  const dir = env.HERDR_PLUGIN_CONFIG_DIR || join(env.HOME || homedir(), ".config", "herdr", "plugins", "config", "herdr-orchestrator-controller");
  return join(dir, SPAWN_PROBE_FILE);
}

/** Milliseconds to start and end a bare Node process. */
export function measureSpawn({ execPath = process.execPath, timeoutMs = 5 * 60_000 } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(execPath, ["-e", "0"], { timeout: timeoutMs }, () => resolve(Date.now() - started));
  });
}

export function recordSpawnProbe(probe, env = process.env) {
  const path = spawnProbePath(env);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(probe)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // Best effort: readers fall back to the base waits.
  }
}

/** The last probe in ms, or undefined when there is none or it is stale. */
export function readSpawnProbe(env = process.env, { now = Date.now(), maxAgeMs = SPAWN_PROBE_MAX_AGE_MS } = {}) {
  if (env.BAA_TON_NO_SPAWN_PROBE === "1") return undefined;
  try {
    const probe = JSON.parse(readFileSync(spawnProbePath(env), "utf8"));
    const at = Date.parse(probe?.at ?? "");
    if (!Number.isFinite(probe?.ms) || !Number.isFinite(at) || now - at > maxAgeMs) return undefined;
    return probe.ms;
  } catch {
    return undefined;
  }
}

/** A startup wait on this machine: 3x the probe, never under `baseMs`, never over 5 min. */
export function startupWait(baseMs, probeMs) {
  if (!Number.isFinite(probeMs) || probeMs <= 0) return baseMs;
  return Math.max(baseMs, Math.min(STARTUP_WAIT_CAP_MS, 3 * probeMs));
}

export function spawnThrottled(probeMs) {
  return Number.isFinite(probeMs) && probeMs > SPAWN_THROTTLE_MS;
}
