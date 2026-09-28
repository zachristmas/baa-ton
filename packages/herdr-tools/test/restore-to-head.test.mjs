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
const { cleanIntegrationWorktree, restoreToHead } = await jiti.import("../index.ts");

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

test("a half-done merge whose files a build rewrote after staging is saved as a patch and reset, where merge --abort refuses (the live D26 integrate)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baa-clean-integration-"));
  const git = (...args) => execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } });
  try {
    git("init", "-q", "-b", "spec-integration");
    await writeFile(join(dir, "openapi-spec.json"), '{"paths":{}}\n');
    await writeFile(join(dir, "index.ts"), "export * from './a';\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const head = git("rev-parse", "HEAD").trim();
    git("switch", "-q", "-c", "item");
    await writeFile(join(dir, "openapi-spec.json"), '{"paths":{"/item":{}}}\n');
    await writeFile(join(dir, "index.ts"), "export * from './item';\n");
    git("commit", "-q", "-am", "item");
    git("switch", "-q", "spec-integration");
    await writeFile(join(dir, "openapi-spec.json"), '{"paths":{"/other":{}}}\n');
    await writeFile(join(dir, "index.ts"), "export * from './other';\n");
    git("commit", "-q", "-am", "other");
    const tip = git("rev-parse", "HEAD").trim();
    assert.notEqual(tip, head);
    assert.throws(() => git("merge", "--no-ff", "-m", "spec(X): integrate", "item"));
    // The lane resolves both, stages them, then a build regenerates the spec
    // and a resolution edit is never staged.
    await writeFile(join(dir, "openapi-spec.json"), '{"paths":{"/item":{},"/other":{}}}\n');
    await writeFile(join(dir, "index.ts"), "export * from './item';\nexport * from './other';\n");
    git("add", "openapi-spec.json", "index.ts");
    await writeFile(join(dir, "openapi-spec.json"), '{"paths":{"/regenerated":{}}}\n');
    await writeFile(join(dir, "index.ts"), "export * from './item';\nexport * from './other';\nexport * from './banner';\n");
    await writeFile(join(dir, "notes.txt"), "an untracked file\n");
    assert.throws(() => git("merge", "--abort"), /not uptodate|would be overwritten|local changes/, "the live refusal");

    const patchPath = join(dir, "..", `${dir.split("/").at(-1)}-leftover`, "X.patch");
    const result = await cleanIntegrationWorktree({ worktree: dir, patchPath });
    assert.deepEqual(result, { merging: true, files: 2 });
    assert.equal(git("rev-parse", "HEAD").trim(), tip, "back at its last commit");
    assert.equal(git("status", "--porcelain", "--untracked-files=no"), "", "clean, no merge in progress");
    assert.throws(() => git("rev-parse", "-q", "--verify", "MERGE_HEAD"));
    assert.equal(await readFile(join(dir, "notes.txt"), "utf8"), "an untracked file\n", "untracked files are left alone");
    const patch = await readFile(patchPath, "utf8");
    assert.match(patch, /\/regenerated/);
    assert.match(patch, /\.\/banner/);
    assert.equal(await cleanIntegrationWorktree({ worktree: dir, patchPath }), undefined, "a clean worktree is left as it is");
    await rm(join(dir, "..", `${dir.split("/").at(-1)}-leftover`), { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
