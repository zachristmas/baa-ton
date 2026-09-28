/**
 * Migration journal order. drizzle applies a migration only when its journal
 * `when` is newer than the latest one a database has applied; a branch whose
 * migrations were generated before a newer one landed on the base keeps
 * older timestamps, and every database already past that newer migration
 * skips them silently (a preview crash-looped on a missing column).
 *
 * After an item is merged, every entry its merge added to a
 * `<dir>/meta/_journal.json` must be later than every entry before it.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
export const JOURNAL_PATH = /(?:^|\/)meta\/_journal\.json$/;

function entriesOf(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.entries) ? parsed.entries.filter((entry) => entry && typeof entry === "object") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Problems with the entries a merge added to one journal, as strings: each
 * new entry (by tag, not in `before`) must have a numeric `when` later than
 * every entry with a smaller idx. Existing entries are not judged.
 */
export function journalOrderProblems(beforeText, afterText, path = "meta/_journal.json") {
  const after = entriesOf(afterText);
  if (!after) return [`${path} is not a readable migration journal`];
  const known = new Set((entriesOf(beforeText ?? "") ?? []).map((entry) => entry.tag));
  const ordered = [...after].sort((left, right) => Number(left.idx) - Number(right.idx));
  const problems = [];
  let latest;
  for (const entry of ordered) {
    const when = Number(entry.when);
    if (!known.has(entry.tag)) {
      if (!Number.isFinite(when)) problems.push(`${path}: ${entry.tag ?? `entry ${entry.idx}`} has no numeric "when"`);
      else if (latest && when <= latest.when)
        problems.push(`${path}: ${entry.tag} (idx ${entry.idx}) has "when" ${when} (${new Date(when).toISOString()}), not later than ${latest.tag} (idx ${latest.idx}, ${latest.when}, ${new Date(latest.when).toISOString()})`);
    }
    if (Number.isFinite(when) && (!latest || when > latest.when)) latest = { tag: entry.tag, idx: entry.idx, when };
  }
  return problems;
}

/** Journal order problems a merge commit adds against a base, read from git. */
export async function mergeJournalProblems(repo, sha, base, { timeout = 30_000 } = {}) {
  const changed = (await execFile("git", ["-C", repo, "diff", "--name-only", base, sha], { timeout, maxBuffer: 16 * 1024 * 1024 })).stdout
    .split("\n")
    .filter((path) => JOURNAL_PATH.test(path));
  const problems = [];
  for (const path of changed) {
    const show = (ref) => execFile("git", ["-C", repo, "show", `${ref}:${path}`], { timeout, maxBuffer: 16 * 1024 * 1024 }).then((result) => result.stdout, () => undefined);
    const after = await show(sha);
    if (after === undefined) continue;
    problems.push(...journalOrderProblems(await show(base), after, path));
  }
  return problems;
}
