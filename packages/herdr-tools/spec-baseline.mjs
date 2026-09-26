/**
 * Baseline-relative suite gate. A target whose own tip fails the suite
 * (an upstream lint error, a flaky package) would make "SUITE: pass"
 * impossible, and the loop could never push. The driver records the
 * suite's failures at the target tip once per target SHA; an integration
 * passes when every failure it reports is already failing there, per
 * package and task.
 */

/** Keep the last few target SHAs' results. */
export const BASELINES_KEPT = 5;

const clean = (value) => String(value ?? "").trim().replace(/[`'",]+$/g, "").replace(/^[`'"]+/, "");

/** One failure's identity: package and task, lower-cased. */
export function failureKey(failure) {
  return `${clean(failure.package).toLowerCase()} ${clean(failure.task).toLowerCase()}`;
}

function add(found, pkg, task) {
  const failure = { package: clean(pkg), task: clean(task) };
  if (!failure.package || !failure.task) return;
  if (!found.some((other) => failureKey(other) === failureKey(failure))) found.push(failure);
}

/**
 * Failing package/task pairs in a receipt or suite output. The receipt
 * contract is `FAILED: <package> <task>`; Turborepo, pnpm and Nx summaries
 * are read too, so a lane pasting raw output still counts.
 */
export function suiteFailures(text) {
  const found = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
    let match;
    if ((match = /^\s*FAILED:\s*([^\s#]+)\s+([^\s#]+)\s*$/.exec(line))) add(found, match[1], match[2]);
    // Turborepo: "@scope/pkg#lint: command (...) exited (1)" and "Failed:    @a/b#lint, @c/d#test".
    else if ((match = /^\s*(?:ERROR\s+)?(@?[\w./-]+)#([\w:.-]+):\s*command\b.*exited \(\d+\)/.exec(line))) add(found, match[1], match[2]);
    else if ((match = /^\s*Failed:\s+(.+)$/.exec(line)))
      for (const part of match[1].split(/[,\s]+/)) {
        const turbo = /^(@?[\w./-]+)#([\w:.-]+)$/.exec(part);
        if (turbo) add(found, turbo[1], turbo[2]);
      }
    // pnpm: "ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @scope/pkg@1.2.3 lint: `eslint .`"
    else if ((match = /ERR_PNPM_\w*FAIL\w*\s+(@?[\w./-]+?)(?:@[\w.+-]+)?\s+([\w:.-]+):/.exec(line))) add(found, match[1], match[2]);
    // Nx: "✖  nx run pkg:lint" or "- pkg:lint" under "Failed tasks:".
    else if ((match = /^\s*[✖×x]\s+nx run ([\w@./-]+):([\w:.-]+)/.exec(line))) add(found, match[1], match[2]);
    else if ((match = /^\s*-\s+([\w@./-]+):([\w.-]+)\s*$/.exec(line)) && /nx|failed tasks/i.test(text)) add(found, match[1], match[2]);
  }
  return found;
}

/** The target's still-failing tasks: the baseline, minus what a fix lane fixed. */
export function knownFailures(baseline) {
  if (!baseline || baseline.unknown) return undefined;
  if (baseline.fix && Array.isArray(baseline.fix.remaining) && !baseline.fix.gaveUp) return baseline.fix.remaining;
  return Array.isArray(baseline.failures) ? baseline.failures : [];
}

/**
 * An integration's failures against the baseline: pass when every one is
 * known, otherwise the new ones.
 */
export function compareToBaseline(failures, known) {
  const keys = new Set(known.map(failureKey));
  const fresh = failures.filter((failure) => !keys.has(failureKey(failure)));
  return { pass: failures.length > 0 && fresh.length === 0, fresh, known: failures.filter((failure) => keys.has(failureKey(failure))) };
}

export const formatFailures = (failures) => failures.map((failure) => `${failure.package} ${failure.task}`).join(", ");

/** Parse a baseline lane's receipt: BASELINE: <sha>, SUITE: pass|fail and FAILED: lines. */
export function baselineResult(summary) {
  const text = String(summary ?? "");
  const sha = /^\s*BASELINE\s*:\s*([0-9a-f]{40})\s*$/im.exec(text)?.[1];
  const suite = /^\s*SUITE\s*:\s*(pass|fail)\b/im.exec(text)?.[1]?.toLowerCase();
  return { sha, suite, failures: suiteFailures(text) };
}

const REPORT_FAILURES =
  "For every failing package and task, add one line FAILED: <package> <task> (for example FAILED: @scope/api lint), whether or not it is expected; no FAILED lines when the suite passes.";

/** The baseline lane: run the suite at the target tip, change nothing. */
export function baselineObjective(spec, { sha }) {
  return [
    `Record the suite baseline of the target ${spec.target.remote}/${spec.target.branch} at ${sha}.`,
    `First put this worktree at exactly that commit: git checkout -q --detach ${sha}.`,
    spec.target.suite.length ? `Run the full suite: ${spec.target.suite.join("; ")}.` : "",
    "Run long suites synchronously with a long timeout, or with your harness's own tracked background mode, and wait for the result. Never use &, disown, nohup or setsid.",
    "Change nothing: no edits, no commits, no other branches, never push. Build outputs the suite itself writes may stay.",
    REPORT_FAILURES,
    `Finish with herdr_complete. The summary starts with BASELINE: ${sha} and SUITE: pass or SUITE: fail, then the FAILED lines.`,
  ].filter(Boolean).join("\n");
}

/** The fix-baseline lane: fix only the target's own failures, on the integration branch. */
export function fixBaselineObjective(spec, { sha, failures, integrationBranch }) {
  return [
    `Fix the target's own suite failures before any spec item is integrated. The target ${spec.target.remote}/${spec.target.branch} at ${sha} already fails: ${formatFailures(failures)}.`,
    `This worktree is on ${integrationBranch} (the target tip plus the items already integrated). Fix only those failures, with the smallest change and no behavior change, and commit each fix with a conventional header of 72 characters or fewer (for example fix(<scope>): <what>). The repository's hooks run and must pass. Local only: never push, never touch another branch, never git stash.`,
    spec.target.suite.length ? `Then run the full suite: ${spec.target.suite.join("; ")}.` : "",
    "Run long suites synchronously with a long timeout, or with your harness's own tracked background mode, and wait for the result. Never use &, disown, nohup or setsid.",
    REPORT_FAILURES,
    "Finish with herdr_complete. The summary starts with INTEGRATED: <full 40-character SHA of the resulting commit> and SUITE: pass or SUITE: fail, then the FAILED lines for anything still failing.",
  ].filter(Boolean).join("\n");
}

/** The integration objective's line about the known baseline failures. */
export function baselineNote(known, sha) {
  if (!known?.length) return REPORT_FAILURES;
  return `The target already fails these suite tasks at ${sha.slice(0, 12)} (its baseline): ${formatFailures(known)}. Do not fix them here. ${REPORT_FAILURES} Report SUITE: fail if anything fails, known or not.`;
}
