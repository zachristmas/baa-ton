/**
 * Keepalive for the supervisor (docs/SELF-HEALING.md). Herdr runs the
 * plugin's startup command only when Herdr itself starts, so a supervisor
 * that dies stays dead until the next Herdr restart. The runner writes a
 * heartbeat every tick; the pane.agent_status_changed hook, which fires all
 * the time, checks it. A heartbeat older than HEARTBEAT_STALE_MS is reported
 * once as an anomaly, and when no live process holds the supervisor lease the
 * hook starts the launcher again, detached, with its output in a file
 * (never a pipe that can close under it). At most one relaunch per
 * RELAUNCH_INTERVAL_MS; the lease keeps a single instance either way.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const HEARTBEAT_FILE = "supervisor-heartbeat.json";
export const HEARTBEAT_STALE_MS = 2 * 60_000;
export const RELAUNCH_INTERVAL_MS = 60_000;
const RELAUNCH_FILE = "supervisor-relaunch.json";
const LEASE = join("supervisor.lock", "owner.json");

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

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** The runner records that it is alive; called every tick, never throws. */
export function writeHeartbeat(configDir, { pid = process.pid, at = new Date().toISOString(), commit } = {}) {
  try {
    write(join(configDir, HEARTBEAT_FILE), { pid, at, ...(commit ? { commit } : {}) });
  } catch {
    // Best effort: the keepalive treats a missing heartbeat as stale.
  }
}

function defaultLaunch({ configDir, env }) {
  const script = fileURLToPath(new URL("./controller.mjs", import.meta.url));
  const out = openSync(join(configDir, "supervisor.out.log"), "a", 0o600);
  try {
    const child = spawn(process.execPath, [script, "supervisor"], { detached: true, stdio: ["ignore", out, out], env, cwd: configDir });
    child.unref();
    return child.pid;
  } finally {
    closeSync(out);
  }
}

/**
 * One keepalive check. Returns what it did: "alive", "hung" (stale heartbeat
 * but the lease holder lives: reported, not duplicated), "relaunched",
 * "waiting" (relaunched a moment ago) or "skipped".
 */
export async function ensureSupervisor({
  configDir,
  env = process.env,
  now = Date.now(),
  alive = processAlive,
  launch = defaultLaunch,
  anomaly = async () => undefined,
} = {}) {
  if (!configDir || env.BAA_TON_NO_SUPERVISOR_KEEPALIVE === "1") return { status: "skipped" };
  const heartbeat = read(join(configDir, HEARTBEAT_FILE));
  const beat = Date.parse(heartbeat?.at ?? "");
  if (Number.isFinite(beat) && now - beat < HEARTBEAT_STALE_MS && alive(heartbeat.pid)) return { status: "alive" };
  const owner = read(join(configDir, LEASE));
  const holder = owner && alive(owner.pid) ? owner.pid : undefined;
  // A runner that took the lease a moment ago (a restart on new code) has
  // not written its first heartbeat yet; the last one is its predecessor's.
  // It gets the full HEARTBEAT_STALE_MS from when it took the lease.
  const leased = Date.parse(owner?.created_at ?? "");
  if (holder && heartbeat?.pid !== holder && Number.isFinite(leased) && now - leased < HEARTBEAT_STALE_MS) return { status: "starting", pid: holder };
  // Between one runner releasing the lease and the next taking it nobody
  // holds it: a recent heartbeat means a restart in progress, not a death.
  if (!holder && Number.isFinite(beat) && now - beat < HEARTBEAT_STALE_MS) return { status: "restarting" };
  const since = Number.isFinite(beat) ? new Date(beat).toISOString() : "never";
  const minutes = Number.isFinite(beat) ? Math.round((now - beat) / 60_000) : undefined;
  await Promise.resolve(
    anomaly({
      kind: "supervisor-down",
      signature: `supervisor-down:${since}`,
      summary: `the supervisor's heartbeat is ${minutes === undefined ? "missing" : `${minutes} min old`} (last ${since}); ${holder ? `pid ${holder} still holds the lease (hung?)` : "no process holds its lease, so the hook relaunched it"}`,
      evidence: [`heartbeat: ${JSON.stringify(heartbeat ?? null)}`, `lease owner: ${JSON.stringify(owner ?? null)}`],
    }),
  ).catch(() => undefined);
  if (holder) return { status: "hung", pid: holder };
  const last = read(join(configDir, RELAUNCH_FILE));
  if (last && now - Date.parse(last.at) < RELAUNCH_INTERVAL_MS) return { status: "waiting" };
  write(join(configDir, RELAUNCH_FILE), { at: new Date(now).toISOString(), pid: process.pid });
  const pid = launch({ configDir, env });
  return { status: "relaunched", pid };
}
