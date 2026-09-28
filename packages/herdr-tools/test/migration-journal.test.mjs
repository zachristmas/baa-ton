import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { journalOrderProblems, mergeJournalProblems } from "../migration-journal.mjs";

const journal = (...entries) => JSON.stringify({ version: "7", dialect: "postgresql", entries: entries.map(([idx, when, tag]) => ({ idx, version: "7", when, tag, breakpoints: true })) });
const base = [
  [50, 1788228311509, "0050_a"],
  [51, 1788236699816, "0051_b"],
  [52, 1790291684087, "0052_base_note"],
];

test("new journal entries must be later than every entry before them (the live 0053/0054 behind 0052)", () => {
  const before = journal(...base);
  const bad = journal(...base, [53, 1790242789349, "0053_group_rules"], [54, 1790268185667, "0054_group_shipping"]);
  const problems = journalOrderProblems(before, bad, "packages/database/migrations/meta/_journal.json");
  assert.equal(problems.length, 2);
  assert.match(problems[0], /0053_group_rules \(idx 53\) has "when" 1790242789349 .*not later than 0052_base_note \(idx 52/);
  assert.match(problems[1], /0054_group_shipping/);
  assert.deepEqual(journalOrderProblems(before, journal(...base, [53, 1790291684088, "0053_group_rules"], [54, 1790291684089, "0054_group_shipping"])), []);
  assert.equal(journalOrderProblems(before, journal(...base, [53, 1790291684087, "0053_same"])).length, 1, "strictly later: an equal time is skipped too");
  // Existing disorder on the base is not the item's to fix.
  const oldDisorder = journal([1, 200, "0001"], [2, 100, "0002"]);
  assert.deepEqual(journalOrderProblems(oldDisorder, journal([1, 200, "0001"], [2, 100, "0002"], [3, 300, "0003"])), []);
  assert.deepEqual(journalOrderProblems(undefined, journal([0, 100, "0000"], [1, 200, "0001"])), [], "a new journal in order");
  assert.match(journalOrderProblems(before, "{not json")[0], /not a readable migration journal/);
});

test("the merge check reads every journal the merge changed from git", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baa-journal-"));
  const git = (...args) => execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } });
  const path = join(dir, "db", "migrations", "meta", "_journal.json");
  try {
    git("init", "-q", "-b", "main");
    await mkdir(join(dir, "db", "migrations", "meta"), { recursive: true });
    await writeFile(path, journal(...base));
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const tip = git("rev-parse", "HEAD").trim();
    await writeFile(path, journal(...base, [53, 1790242789349, "0053_group_rules"]));
    await writeFile(join(dir, "other.txt"), "x\n");
    git("add", ".");
    git("commit", "-q", "-m", "item");
    const bad = git("rev-parse", "HEAD").trim();
    const problems = await mergeJournalProblems(dir, bad, tip);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^db\/migrations\/meta\/_journal\.json: 0053_group_rules/);
    await writeFile(path, journal(...base, [53, 1790291684090, "0053_group_rules"]));
    git("commit", "-q", "-am", "fixed");
    assert.deepEqual(await mergeJournalProblems(dir, git("rev-parse", "HEAD").trim(), tip), []);
    git("rm", "-q", "other.txt");
    git("commit", "-q", "-m", "no journal change");
    assert.deepEqual(await mergeJournalProblems(dir, git("rev-parse", "HEAD").trim(), git("rev-parse", "HEAD~1").trim()), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
