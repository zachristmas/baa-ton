/**
 * Who drives the spec loop (docs/SPEC-LOOP.md): the supervisor's spec host
 * (spec-host.mjs, one per root with a spec) or, as before, the root's own Pi
 * extension. The host runs on its own timer in a process the supervisor
 * restarts on every deploy, so the loop no longer depends on the root being
 * idle, reloaded or even responsive.
 *
 * Two files next to the manifest settle it without overlap:
 * - spec-driver-host.json: the host's lease { pid, startedAt, at }, renewed
 *   every HEARTBEAT_MS while the host process lives;
 * - spec-driver-defer.json: the root extension's hand-over { pid, at },
 *   written only between its own passes, while a live host holds the lease.
 * The host drives once the root has handed over since the host started (so
 * a root pass in flight finishes first), or when the root pane has no Pi
 * agent at all (`rootGone`, which the host records in its lease). After
 * that it never waits on the root: a root that is busy, hung or gone does
 * not stop the loop. A root on older code never hands over and keeps driving
 * until it reloads. When the host dies, its lease goes stale and the root
 * drives again.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const HOST_LEASE_FILE = "spec-driver-host.json";
export const DEFER_FILE = "spec-driver-defer.json";
export const HEARTBEAT_MS = 15_000;
export const FRESH_MS = 90_000;

function read(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function write(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function fresh(record, now, alive) {
  return Boolean(record) && Number.isFinite(Date.parse(record.at)) && now - Date.parse(record.at) < FRESH_MS && alive(record.pid);
}

/**
 * The host renews its lease; `startedAt` stays the host process's start.
 * `rootGone` and the last live `rootSession` ride along.
 */
export function renewHostLease(stateDir, { startedAt, now = Date.now(), pid = process.pid, commit, rootGone, rootSession } = {}) {
  write(join(stateDir, HOST_LEASE_FILE), {
    pid,
    startedAt,
    at: new Date(now).toISOString(),
    ...(commit ? { commit } : {}),
    ...(rootGone ? { rootGone: true } : {}),
    ...(rootSession?.file ? { rootSession } : {}),
  });
}

/** The previous host's lease, for the last recorded root session. */
export function readHostLease(stateDir) {
  return read(join(stateDir, HOST_LEASE_FILE));
}

/**
 * Whether this process may run a driver pass now. Returns undefined to
 * drive, or the reason to skip. The root side records its hand-over as a
 * side effect.
 */
export function specHandover(stateDir, { host = process.env.BAATON_SPEC_HOST === "1", now = Date.now(), pid = process.pid, alive = pidAlive } = {}) {
  const lease = read(join(stateDir, HOST_LEASE_FILE));
  if (host) {
    if (lease?.rootGone === true) return undefined;
    const defer = read(join(stateDir, DEFER_FILE));
    if (lease && defer && Date.parse(defer.at) >= Date.parse(lease.startedAt)) return undefined;
    return "waiting for the root's extension to hand the driver over (a root on older code keeps driving until it reloads)";
  }
  if (!fresh(lease, now, alive) || lease.pid === pid) return undefined;
  try {
    write(join(stateDir, DEFER_FILE), { pid, at: new Date(now).toISOString() });
  } catch {
    // Unwritable: still stand down; the host waits for the hand-over.
  }
  return `the supervisor's spec host (pid ${lease.pid}) drives the spec loop`;
}
