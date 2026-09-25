/**
 * Adopt a live run into the spec loop: write the first spec-state.json from
 * the work that already exists, so the driver continues it instead of
 * rebuilding every item from scratch.
 *
 * Per item, the optional `adopt` field in spec.json names what exists:
 *   { worktree, branch, report, workflow, review, accepted }
 * and the starting state follows, first match wins:
 *   0. `resolved: "<reason>"` (settled by a decision)    -> resolved
 *   1. acceptance says deferred and `owns` is empty      -> deferred
 *   2. `accepted: true`, or a VERDICT: PASS receipt on the
 *      adopted or review workflow                          -> integrating
 *   3. the adopted workflow still has a live lane         -> building (attached)
 *   4. a build receipt, or the evidence report exists     -> reviewing
 *   5. otherwise                                          -> pending
 * The report's SHA-256 and image count are recorded at adopt time; an
 * adopted report may live outside the target repository.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { reviewVerdict } from "./spec-driver.mjs";
import { SPEC_STATE_PATH, loadSpec, reportImageCount, targetRepo } from "./spec.mjs";

const TERMINAL_WORKFLOW = new Set(["completed", "closed", "operator-closed", "superseded", "retired", "close-cleanup-pending"]);
const TERMINAL_LANE = new Set(["completion-reported", "completed", "operator-closed", "superseded", "retired", "closed", "failed"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Files that are never staged by the spec loop, tracked or not. */
export function isSecretPath(path) {
  const name = basename(String(path));
  return /secret/i.test(name) || /^\.env(\.|$)/i.test(name) || /\.lane-secrets\.json$/i.test(name);
}

/** A glob as a regular expression: `**` any depth, `*` and `?` within a segment. */
export function globToRegExp(glob) {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      pattern += glob[index + 2] === "/" ? "(?:.*/)?" : ".*";
      index += glob[index + 2] === "/" ? 2 : 1;
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * Sort an adopted worktree's uncommitted changes (`git status
 * --porcelain=v1`, which leaves out ignored files) for integration:
 *   paths:   item-owned (`owns` or `sharedTouch`), the explicit list to commit
 *   secrets: secret-looking files, never staged whatever they match
 *   outside: every other change; any of these blocks integration
 * An item with no `owns` commits nothing: all its changes are outside, so
 * the root decides instead of the whole worktree being swept in.
 */
export function itemOwnedChanges(porcelain, owns = [], sharedTouch = []) {
  const patterns = owns.length ? [...owns, ...sharedTouch].map(globToRegExp) : [];
  const paths = [];
  const secrets = [];
  const outside = [];
  for (const line of String(porcelain ?? "").split("\n")) {
    if (line.length < 4) continue;
    let path = line.slice(3);
    if (path.includes(" -> ")) path = path.split(" -> ").pop();
    path = path.replace(/^"(.*)"$/, "$1");
    if (isSecretPath(path)) secrets.push(path);
    else if (patterns.some((pattern) => pattern.test(path))) paths.push(path);
    else outside.push(path);
  }
  return { paths, secrets, outside };
}

/** Deferred: the acceptance says so and the item owns no files. */
export function itemDeferred(item) {
  return /\bdeferred\b/i.test(item.acceptance.text) && item.owns.length === 0;
}

function receipts(workflow) {
  return (Array.isArray(workflow?.lanes) ? workflow.lanes : [])
    .map((lane) => lane?.completionReceipt?.summary)
    .filter((summary) => typeof summary === "string");
}

/**
 * Propose starting states. `readReport(path)` resolves a Buffer or
 * undefined; `now` is an ISO timestamp. Pure apart from reading reports.
 */
export async function proposeAdoption({ spec, manifest, repo, now, readReport = (path) => readFile(path).catch(() => undefined) }) {
  const workflows = new Map((Array.isArray(manifest?.workflows) ? manifest.workflows : []).map((workflow) => [workflow.id, workflow]));
  const items = {};
  const rows = [];
  for (const item of spec.items) {
    const adopt = item.adopt ?? {};
    const warnings = [];
    const record = {};
    if (adopt.worktree) record.worktree = adopt.worktree;
    if (adopt.branch) record.branch = adopt.branch;
    if (Object.keys(adopt).length) record.adopted = { ...adopt, at: now };
    const workflow = adopt.workflow ? workflows.get(adopt.workflow) : undefined;
    if (adopt.workflow && !workflow) warnings.push(`workflow ${adopt.workflow} is not in the manifest`);
    const review = adopt.review ? workflows.get(adopt.review) : undefined;
    if (adopt.review && !review) warnings.push(`review workflow ${adopt.review} is not in the manifest`);
    const reportPath = adopt.report ?? (item.acceptance.evidence ? join(repo, item.acceptance.evidence.report) : undefined);
    const report = reportPath ? await readReport(reportPath) : undefined;
    if (adopt.report && !report) warnings.push(`report ${adopt.report} is missing`);
    if (report)
      record.evidence = {
        path: reportPath,
        sha256: createHash("sha256").update(report).digest("hex"),
        images: reportImageCount(reportPath, report),
        adoptedAt: now,
      };
    if (report && item.acceptance.evidence && (record.evidence.images ?? 0) < item.acceptance.evidence.minImages)
      warnings.push(`report has ${record.evidence.images ?? 0} of ${item.acceptance.evidence.minImages} images`);
    const buildReceipts = receipts(workflow);
    const verdicts = [...buildReceipts, ...receipts(review)].map(reviewVerdict);
    const liveLane =
      workflow && !TERMINAL_WORKFLOW.has(workflow.status)
        ? workflow.lanes?.find((lane) => !lane.completionReceipt && !TERMINAL_LANE.has(lane.status))
        : undefined;
    let state;
    let reason;
    if (typeof adopt.resolved === "string") {
      state = "resolved";
      reason = `resolved by decision: ${adopt.resolved}`;
      record.resolution = { reason: adopt.resolved, at: now };
    } else if (itemDeferred(item)) {
      state = "deferred";
      reason = "acceptance says deferred and it owns no files";
    } else if (adopt.accepted === true || verdicts.includes("pass")) {
      state = "integrating";
      reason = adopt.accepted === true ? "accepted" : "a review receipt says VERDICT: PASS";
    } else if (liveLane) {
      state = "building";
      record.lane = { workflowId: workflow.id, laneId: liveLane.id };
      record.buildWorkflows = [workflow.id];
      reason = `attached to live workflow ${workflow.id}/${liveLane.id}`;
    } else if (buildReceipts.length || report) {
      state = "reviewing";
      if (buildReceipts.length) record.buildSummary = buildReceipts.at(-1);
      reason = buildReceipts.length ? `workflow ${workflow.id} has a build receipt` : "the evidence report exists and nothing reviewed it";
    } else {
      state = "pending";
      reason = record.worktree ? "no work recorded yet; builds reuse the adopted worktree" : "no existing work";
    }
    if (verdicts.includes("fail") && state !== "integrating") warnings.push("a review receipt says VERDICT: FAIL");
    items[item.id] = { ...record, state, attempts: state === "pending" || state === "deferred" ? 0 : 1, since: now, history: [{ at: now, from: "adopt", to: state, note: reason }] };
    rows.push({ id: item.id, state, reason, warnings });
  }
  // Every resolution is a decision the user can overturn: log it.
  const decisions = rows
    .filter((row) => row.state === "resolved")
    .map((row) => ({ at: now, itemId: row.id, decision: "resolved", reason: items[row.id].resolution.reason, by: "adopt" }));
  return { state: { version: 1, items, ...(decisions.length ? { decisions } : {}) }, rows, resolved: decisions };
}

export function adoptionTable(rows) {
  const width = Math.max(4, ...rows.map((row) => row.id.length));
  const stateWidth = Math.max(5, ...rows.map((row) => row.state.length));
  const counts = new Map();
  for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  return [
    `adopt ${rows.length} item(s): ${[...counts].map(([state, count]) => `${count} ${state}`).join(" · ")}`,
    "",
    `${"item".padEnd(width)}  ${"state".padEnd(stateWidth)}  reason`,
    ...rows.map((row) => `${row.id.padEnd(width)}  ${row.state.padEnd(stateWidth)}  ${row.reason}${row.warnings.length ? `  [warning: ${row.warnings.join("; ")}]` : ""}`),
  ].join("\n");
}

async function withManifestLock(cwd, action) {
  const lockPath = join(cwd, ".baa-ton", "herdr-orchestrator", ".manifest.json.herdr-orchestrator.lock");
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() > deadline) throw new Error(`Cannot take the manifest lock: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    return await action();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

/**
 * Adopt the project's run. With dryRun, only propose. Refuses to replace a
 * spec-state.json that already tracks items unless `force`.
 */
export async function adoptSpec({ cwd, dryRun = false, force = false, now = new Date().toISOString(), readReport } = {}) {
  const spec = await loadSpec(cwd);
  if (!spec) throw new Error(`No .baa-ton/spec.json in ${cwd}.`);
  const readJson = async (path) => JSON.parse(await readFile(path, "utf8").catch(() => "null"));
  const manifest = (await readJson(join(cwd, ".baa-ton", "herdr-orchestrator", "manifest.json"))) ?? { workflows: [] };
  const proposal = await proposeAdoption({ spec, manifest, repo: targetRepo(spec, cwd), now, ...(readReport ? { readReport } : {}) });
  if (dryRun) return { ...proposal, written: false };
  await withManifestLock(cwd, async () => {
    const path = join(cwd, SPEC_STATE_PATH);
    const existing = await readJson(path);
    if (!force && isRecord(existing?.items) && Object.keys(existing.items).length)
      throw new Error(`${SPEC_STATE_PATH} already tracks ${Object.keys(existing.items).length} item(s); adopt only starts a run (pass force to replace it).`);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(proposal.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  });
  return { ...proposal, written: true };
}
