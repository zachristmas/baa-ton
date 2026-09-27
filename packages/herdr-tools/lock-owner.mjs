/**
 * Who holds a lock (docs/SELF-HEALING.md). A pid alone is not an identity:
 * after a reboot the supervisor lease still named pid 767, that pid was now
 * /usr/libexec/sharingd, and every supervisor start (the keepalive's
 * relaunches too) exited for 43 minutes believing another supervisor held it.
 *
 * An owner record carries the pid, the boot it was written in, a random token
 * and, where it is cheap enough to check, the process's own start time. A
 * record is held only while its boot is this boot, its pid is alive and (when
 * recorded) that pid's start time still matches. Anything else is stale.
 *
 * The boot time comes from os.uptime(), which libuv derives from the kernel's
 * boot time (kern.boottime on macOS), so it needs no process and does not
 * drift across sleep. A start time needs `ps`, one process start, so only the
 * rarely taken supervisor lease records it; the busy locks rely on boot + pid.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat } from "node:fs/promises";
import { uptime } from "node:os";
import { join } from "node:path";

/** Clock steps and rounding stay well inside this; reboots are further apart. */
export const BOOT_TOLERANCE_MS = 60_000;
/** `ps -o lstart` has one-second precision. */
export const START_TOLERANCE_MS = 2_000;
/** A lock whose owner file is missing or unreadable this long is abandoned (a live writer fills it at once). */
export const UNREADABLE_LOCK_MS = 30_000;

export function bootTimeMs(now = Date.now(), up = uptime()) {
  return Math.round(now - up * 1000);
}

export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** A live process's start time in ms, from `ps -o lstart=`; undefined when it cannot be read. */
export function processStartMs(pid, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { timeout: timeoutMs, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => {
      const at = error ? NaN : Date.parse(String(stdout).trim().replace(/\s+/g, " "));
      resolve(Number.isFinite(at) ? at : undefined);
    });
  });
}

/** The owner record a lock holder writes. `start` is this process's start (supervisor lease only). */
export function ownerRecord({ start, now = Date.now(), boot = bootTimeMs(now), extra } = {}) {
  return {
    pid: process.pid,
    boot: new Date(boot).toISOString(),
    token: randomUUID(),
    created_at: new Date(now).toISOString(),
    ...(Number.isFinite(start) ? { start: new Date(start).toISOString() } : {}),
    ...extra,
  };
}

function recordedAt(owner) {
  return Date.parse(owner?.created_at ?? owner?.createdAt ?? owner?.at ?? owner?.startedAt ?? "");
}

/**
 * Held by boot and pid: the check every lock can afford. A record from an
 * older writer (no `boot`) counts as this boot only when it was written after
 * this boot began.
 */
export function ownerHeldSync(owner, { alive = pidAlive, boot = bootTimeMs() } = {}) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  const recordedBoot = Date.parse(owner.boot ?? "");
  if (Number.isFinite(recordedBoot)) {
    if (Math.abs(recordedBoot - boot) > BOOT_TOLERANCE_MS) return false;
  } else {
    const written = recordedAt(owner);
    if (Number.isFinite(written) && written < boot - BOOT_TOLERANCE_MS) return false;
  }
  return alive(owner.pid);
}

/**
 * Held by boot, pid and, when the record has one, the pid's start time: a
 * reused pid in the same boot is another process. A start time that cannot
 * be read keeps the lock (never risk two holders).
 */
export async function ownerHeld(owner, { alive = pidAlive, boot = bootTimeMs(), startOf = processStartMs } = {}) {
  if (!ownerHeldSync(owner, { alive, boot })) return false;
  const recorded = Date.parse(owner.start ?? "");
  if (!Number.isFinite(recorded)) return true;
  const actual = await startOf(owner.pid);
  if (actual === undefined) return true;
  return Math.abs(actual - recorded) <= START_TOLERANCE_MS;
}

/**
 * Reclaim a lock directory whose owner (<lock>/owner.json) no longer holds
 * it. Atomic: the directory is renamed aside first, and if the owner that
 * was moved is not the one judged stale (another process reclaimed and took
 * the lock in between), it is put back. Returns true when the lock is free
 * to take again.
 */
export async function reclaimLockDir(lockPath, { held = (owner) => ownerHeldSync(owner), now = Date.now(), unreadableMs = UNREADABLE_LOCK_MS, log } = {}) {
  const read = async (dir) => {
    try {
      return JSON.parse(await readFile(join(dir, "owner.json"), "utf8"));
    } catch {
      return undefined;
    }
  };
  const owner = await read(lockPath);
  if (owner) {
    if (await held(owner)) return false;
  } else {
    const since = await stat(lockPath).then((details) => details.mtimeMs, () => undefined);
    if (since === undefined) return true;
    if (now - since < unreadableMs) return false;
  }
  const aside = `${lockPath}.stale-${randomUUID().slice(0, 8)}`;
  try {
    await rename(lockPath, aside);
  } catch (error) {
    return error?.code === "ENOENT";
  }
  const moved = await read(aside);
  const same = owner
    ? owner.token
      ? moved?.token === owner.token
      : moved?.pid === owner.pid && recordedAt(moved) === recordedAt(owner)
    : !moved;
  if (!same) {
    // Another process took the lock between our read and the rename: give it back.
    await rename(aside, lockPath).catch(() => undefined);
    return false;
  }
  await rm(aside, { recursive: true, force: true }).catch(() => undefined);
  log?.(`reclaimed stale lock ${lockPath}${owner ? ` (pid ${owner.pid}${owner.boot ? `, boot ${owner.boot}` : ""})` : " (no owner record)"}`);
  return true;
}
