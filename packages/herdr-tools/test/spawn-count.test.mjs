import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createSpawnCountReader, formatSpawnCounts, installSpawnCounter, spawnKey } from "../inbox/spawn-count.mjs";

test("every process a Baa-ton process starts is counted by command, flushed as one line, and summed per minute by the supervisor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-spawn-count-"));
  try {
    const path = join(directory, "spawn-counts.jsonl");
    // The hermetic runner turns counting off; this test turns it on for itself.
    const flush = installSpawnCounter("spec-host", { env: {}, path });
    await promisify(execFile)(process.execPath, ["-e", "0"]);
    await promisify(execFile)(process.execPath, ["-e", "0"]);
    await new Promise((resolve) => spawn("sh", ["-c", "true"]).once("close", resolve));
    flush();
    const reader = createSpawnCountReader({ path });
    const counted = reader.read();
    assert.equal(counted.byRole["spec-host"][basename(process.execPath)], 2);
    assert.equal(counted.byRole["spec-host"]["sh -c true"], 1);
    assert.equal(counted.total, 3);
    assert.deepEqual(reader.read(), { total: 0, byRole: {} }, "each line is read once");
    assert.equal(formatSpawnCounts(counted, { "hook events": 4 }), `spawns in the last minute: 7 (spec-host: ${basename(process.execPath)} 2, sh -c true 1; hook events 4)`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lane shells are counted apart from other herdr calls", () => {
  assert.equal(spawnKey("/usr/local/bin/herdr", ["tab", "create", "--workspace", "w1"]), "lane-shell (herdr tab create)");
  assert.equal(spawnKey("herdr", ["agent", "get", "w1:p1"]), "herdr agent get");
  assert.equal(spawnKey("/usr/bin/git", ["-C", "/w", "status", "--porcelain"]), "git status");
  assert.equal(spawnKey("/bin/sh", ["-c", "pnpm test"]), "sh -c pnpm");
});
