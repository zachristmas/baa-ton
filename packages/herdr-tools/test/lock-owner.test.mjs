import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bootTimeMs, ownerHeld, ownerHeldSync, ownerRecord, processStartMs, reclaimLockDir } from "../lock-owner.mjs";

// Pid 1 (launchd, init) is always alive and never a Baa-ton process: the
// shape of the reboot outage, where pid 767 had become sharingd.
const LIVE_STRANGER = 1;
const BOOT = Date.parse("2026-09-27T12:57:39.000Z");
const EARLIER_BOOT = Date.parse("2026-09-26T08:10:00.000Z");

async function lockDir(owner) {
  const directory = await mkdtemp(join(tmpdir(), "baa-lock-owner-"));
  const lock = join(directory, "supervisor.lock");
  await mkdir(lock);
  if (owner) await writeFile(join(lock, "owner.json"), JSON.stringify(owner));
  return { directory, lock, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("an owner is held only in its own boot, by a live pid, with its recorded start time", async () => {
  const boot = bootTimeMs();
  const mine = ownerRecord();
  assert.equal(ownerHeldSync(mine), true, "this process, this boot");
  assert.ok(Math.abs(Date.parse(mine.boot) - boot) < 60_000);
  assert.match(mine.token, /^[0-9a-f-]{36}$/);
  // The outage: a lease from before the reboot naming a pid that is alive again as another process.
  assert.equal(ownerHeldSync({ pid: LIVE_STRANGER, boot: new Date(EARLIER_BOOT).toISOString() }, { boot: BOOT }), false, "a different boot is stale, even with a live pid");
  assert.equal(ownerHeldSync({ pid: LIVE_STRANGER, created_at: "2026-09-27T02:23:22.910Z" }, { boot: BOOT }), false, "an older writer's lease from before this boot is stale");
  assert.equal(ownerHeldSync({ pid: 2 ** 30, boot: new Date(BOOT).toISOString() }, { boot: BOOT }), false, "a dead pid");
  assert.equal(ownerHeldSync({ pid: process.pid, created_at: new Date(BOOT + 60_000 * 5).toISOString() }, { boot: BOOT }), true, "an older writer after this boot, pid alive");
  // Same boot, pid alive, but another process: its start time differs.
  const sameBoot = { pid: LIVE_STRANGER, boot: new Date(BOOT).toISOString(), start: "2026-09-27T13:43:26.000Z" };
  assert.equal(await ownerHeld(sameBoot, { boot: BOOT, startOf: async () => BOOT + 2_000 }), false, "a reused pid in the same boot");
  assert.equal(await ownerHeld(sameBoot, { boot: BOOT, startOf: async () => Date.parse(sameBoot.start) + 900 }), true, "the recorded start matches");
  assert.equal(await ownerHeld(sameBoot, { boot: BOOT, startOf: async () => undefined }), true, "an unreadable start keeps the lock");
});

test("ps reads a live process's own start time", async () => {
  const start = await processStartMs(process.pid);
  assert.ok(Number.isFinite(start), "ps -o lstart parsed");
  assert.ok(Math.abs(start - (Date.now() - process.uptime() * 1000)) < 10 * 60_000, "close to this process's start");
});

test("a stale lock is reclaimed by renaming it aside; a live one, or one being written, is kept", async () => {
  const stranger = await lockDir({ pid: LIVE_STRANGER, boot: new Date(EARLIER_BOOT).toISOString(), token: "old" });
  try {
    const logs = [];
    assert.equal(await reclaimLockDir(stranger.lock, { held: (owner) => ownerHeldSync(owner, { boot: BOOT }), log: (line) => logs.push(line) }), true);
    await assert.rejects(stat(stranger.lock), /ENOENT/, "the stale lock is gone");
    assert.match(logs[0], /reclaimed stale lock .* \(pid 1, boot 2026-09-26/);
  } finally {
    await stranger.cleanup();
  }
  const live = await lockDir(ownerRecord());
  try {
    assert.equal(await reclaimLockDir(live.lock), false);
    assert.equal(JSON.parse(await readFile(join(live.lock, "owner.json"), "utf8")).pid, process.pid);
  } finally {
    await live.cleanup();
  }
  const writing = await lockDir();
  try {
    assert.equal(await reclaimLockDir(writing.lock), false, "an owner file not yet written is kept at first");
    const old = new Date(Date.now() - 60_000);
    await utimes(writing.lock, old, old);
    assert.equal(await reclaimLockDir(writing.lock), true, "and reclaimed once it is abandoned");
  } finally {
    await writing.cleanup();
  }
});

test("a reclaim that raced a new holder puts its lock back", async () => {
  const race = await lockDir({ pid: LIVE_STRANGER, boot: new Date(EARLIER_BOOT).toISOString(), token: "old" });
  try {
    // Between the read and the rename, another process reclaimed and took the lock.
    const held = async () => {
      await writeFile(join(race.lock, "owner.json"), JSON.stringify(ownerRecord()));
      return false;
    };
    assert.equal(await reclaimLockDir(race.lock, { held }), false);
    assert.equal(JSON.parse(await readFile(join(race.lock, "owner.json"), "utf8")).pid, process.pid, "the new holder keeps its lock");
  } finally {
    await race.cleanup();
  }
});
