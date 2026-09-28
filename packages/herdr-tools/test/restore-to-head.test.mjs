import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { restoreToHead } = await jiti.import("../index.ts");

test("restoring to HEAD puts a modified file back and removes a staged new file that HEAD does not have (a held D16 build)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baa-restore-head-"));
  const git = (...args) => execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } });
  try {
    git("init", "-q");
    await writeFile(join(dir, "kept.ts"), "original\n");
    git("add", "kept.ts");
    git("commit", "-q", "-m", "init");
    await writeFile(join(dir, "kept.ts"), "changed\n");
    await writeFile(join(dir, "added.tsx"), "new file\n");
    git("add", "added.tsx");
    assert.match(git("status", "--porcelain"), /^A  added\.tsx/m);
    await restoreToHead(dir, ["kept.ts", "added.tsx"]);
    assert.equal(await readFile(join(dir, "kept.ts"), "utf8"), "original\n");
    assert.equal(existsSync(join(dir, "added.tsx")), false);
    assert.equal(git("status", "--porcelain"), "", "a clean worktree");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
