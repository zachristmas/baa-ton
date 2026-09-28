/**
 * Spec loop, part 2: the item state machine (docs/SPEC-LOOP.md sections 2,
 * 4 and 6) as a pure function. The extension's driver runs it on every
 * settled root turn, performs the actions it returns (worktree, plan,
 * dispatch) and saves the new state; code decides, not the root LLM.
 *
 *   pending -> ready -> building -> reviewing -> integrating (PR 3) ...
 *
 * - An item is ready when every dependency is integrating, verifying or
 *   done. Without that it waits as pending with a named reason.
 * - A ready item builds only while fewer than maxParallel items are in a
 *   stage, the root has no capacity gate waiting, and its `owns` and
 *   `sharedTouch` do not overlap an in-flight builder's `owns`.
 * - A build lane's completion receipt moves the item to review (a fresh
 *   lane). A review receipt must start with VERDICT: PASS or VERDICT: FAIL.
 *   PASS moves on to integrating; FAIL rebuilds with the findings until
 *   maxBuildAttempts, then the item fails and the root is asked.
 * - A lane that ends without a receipt counts as a failed attempt.
 */
import { fileURLToPath } from "node:url";
import { BASELINES_KEPT, baselineNote, baselineResult, compareToBaseline, formatFailures, knownFailures, suiteFailures } from "./spec-baseline.mjs";
import { demoOnPreview, previewHealthUrl } from "./spec.mjs";

/** How build and integration lanes run a suite that outlasts a normal command timeout. */
const LONG_COMMANDS =
  "Run long suites synchronously with a long timeout, or with your harness's own tracked background mode (Claude: the Bash tool's run_in_background; Pi: its equivalent), and wait for the result. Never use &, disown, nohup or setsid: a detached job is invisible to Herdr and Baa-ton.";

/** States that hold a lane (and a maxParallel slot). */
export const ACTIVE_STATES = new Set(["building", "reviewing", "integrating", "verifying"]);
const AFTER_INTEGRATION = new Set(["integrating", "awaiting-push", "verifying", "done", "resolved"]);
const INTEGRATED = new Set(["awaiting-push", "verifying", "done", "resolved"]);
/** How long a lane that went idle without its receipt has to answer the ask. */
export const RECEIPT_ASK_TIMEOUT_MS = 30 * 60_000;
/** A lane that answers the ask with a status message is still working: ask
 * again after this long (doubling each time it answers with a status). */
export const RECEIPT_REASK_BASE_MS = 60 * 60_000;
/**
 * A lane that finished its turn without a receipt: asked, then one pointed
 * ask after this interval, then its receipt is inferred from its final
 * report after another. Past the first interval it holds no maxParallel slot.
 */
export const RECEIPT_ASK_INTERVAL_MS = 10 * 60_000;
const RECEIPT_FORMAT = {
  decide: "QUESTION: lines for anything still open (none when settled), OWNS: and MIGRATIONS: if they differ",
  build: "the commit SHA, the checks you ran and their results, and the evidence report path",
  review: "a first line of exactly VERDICT: PASS or VERDICT: FAIL, then the findings",
  integrate: "the lines INTEGRATED: <full SHA> and SUITE: pass or SUITE: fail, plus FAILED: <package> <task> for each failing task",
  verify: "one PREVIEW: <spec> pass|fail line per spec and REPORT: <path>",
};
const STAGE_OF = { deciding: "decide", building: "build", reviewing: "review", integrating: "integrate", verifying: "verify" };
/** Workflow statuses after which a lane no longer occupies its worktree. */
const CLOSED_WORKFLOW = new Set(["closed", "completed", "operator-closed", "superseded", "retired"]);
/** Per-lane receipt and background bookkeeping on an item record. */
export const LANE_BOOKKEEPING = [
  "receiptAskedAt",
  "receiptPointedAt",
  "receiptInferRequestedAt",
  "receiptInferred",
  "receiptInferFailedAt",
  "receiptEscalatedAt",
  "receiptAskAfter",
  "receiptStatusReplies",
  "backgroundWork",
  "backgroundSince",
  "backgroundStaleAt",
];

/**
 * Bookkeeping from before the item's current stage (records written before
 * move() cleared it): any timestamp older than `since` belongs to an earlier
 * lane. Cleared once; the counters go with them.
 */
function dropStaleBookkeeping(item) {
  const since = Date.parse(item?.since ?? "");
  if (!Number.isFinite(since)) return;
  const stamp = (value) => Date.parse(typeof value === "string" ? value : value?.at ?? "");
  let dropped = false;
  for (const key of LANE_BOOKKEEPING) {
    const at = stamp(item[key]);
    if (Number.isFinite(at) && at < since) {
      delete item[key];
      dropped = true;
    }
  }
  if (dropped && !LANE_BOOKKEEPING.some((key) => key !== "receiptStatusReplies" && key !== "backgroundWork" && item[key] !== undefined)) {
    delete item.receiptStatusReplies;
    delete item.backgroundWork;
  }
}
const LANE_ENDED = new Set(["operator-closed", "superseded", "dispatch-failed", "failed", "closed"]);

/** Static prefix of a glob (everything before the first wildcard). */
function globPrefix(pattern) {
  const index = pattern.search(/[*?[{]/);
  return (index < 0 ? pattern : pattern.slice(0, index)).replace(/\/+$/, "");
}

/** Conservative overlap test: two globs may overlap when one prefix contains the other. */
export function globsOverlap(left, right) {
  const a = globPrefix(left);
  const b = globPrefix(right);
  if (!a || !b) return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`) || (a.startsWith(b) && /[*?[{]/.test(right)) || (b.startsWith(a) && /[*?[{]/.test(left));
}

function anyOverlap(patterns, others) {
  return patterns.some((pattern) => others.some((other) => globsOverlap(pattern, other)));
}

/** Parse a review lane's receipt summary. */
export function reviewVerdict(summary) {
  const match = /^\s*(?:\*\*)?\s*VERDICT\s*:\s*(PASS|FAIL)\b/i.exec(String(summary ?? ""));
  return match ? match[1].toLowerCase() : undefined;
}

/**
 * A conventional-commit header (commitlint config-conventional accepts it:
 * type "spec", the item as scope), at most 72 characters.
 */
export function specCommitMessage(itemId, subject) {
  const header = `spec(${itemId}): ${subject}`;
  return header.length <= 72 ? header : header.slice(0, 72).trimEnd();
}

/** Parse a decide lane's receipt: QUESTION:, OWNS: and MIGRATIONS: lines. */
export function decideResult(summary) {
  const lines = String(summary ?? "").split("\n");
  const questions = lines
    .map((line) => /^\s*(?:[-*]\s*)?QUESTION\s*:\s*(.+)$/i.exec(line)?.[1]?.trim())
    .filter(Boolean);
  const owns = lines
    .map((line) => /^\s*OWNS\s*:\s*(.+)$/i.exec(line)?.[1])
    .filter(Boolean)
    .flatMap((value) => value.split(",").map((part) => part.trim()).filter(Boolean));
  const migrations = lines.map((line) => /^\s*MIGRATIONS\s*:\s*(\d+)\s*$/i.exec(line)?.[1]).find(Boolean);
  return {
    questions,
    ...(owns.length ? { owns } : {}),
    ...(migrations !== undefined ? { migrations: Number(migrations) } : {}),
  };
}

/** Parse a verify lane's receipt: PREVIEW: <spec> pass|fail|blocked, TEST: <command> pass|fail|blocked and REPORT: <path> lines. */
export function verifyResult(summary) {
  const lines = String(summary ?? "").split("\n");
  const previews = lines
    .map((line) => /^\s*PREVIEW\s*:\s*(\S+)\s+(pass|fail|blocked)\b/i.exec(line))
    .filter(Boolean)
    .map((match) => ({ spec: match[1], result: match[2].toLowerCase() }));
  const tests = lines
    .map((line) => /^\s*TEST\s*:\s*(.+?)\s+(pass|fail|blocked)\b(?:\s*[.:;,(\u2014-].*)?$/i.exec(line))
    .filter(Boolean)
    .map((match) => ({ command: match[1].replace(/^`(.*)`$/, "$1").trim(), result: match[2].toLowerCase() }));
  const report = lines.map((line) => /^\s*REPORT\s*:\s*(\S+)\s*$/i.exec(line)?.[1]).find(Boolean);
  return { previews, tests, ...(report ? { report } : {}) };
}

/** Parse a demo run's receipt: DEMO: <id> written|blocked [reason] lines, and DEMO-STACK: blocked <why>. */
export function demoRunResult(summary) {
  const lines = String(summary ?? "").split("\n");
  const items = new Map();
  for (const line of lines) {
    const match = /^\s*DEMO\s*:\s*([\w.-]+)\s+(written|done|blocked|skipped)\b[\s:,-]*(.*)$/i.exec(line);
    if (match) items.set(match[1], { result: /^(written|done)$/i.test(match[2]) ? "written" : "blocked", reason: match[3].trim() });
  }
  const stackBlocked = lines.map((line) => /^\s*DEMO-STACK\s*:\s*blocked\b[\s:,-]*(.*)$/i.exec(line)?.[1]).find((reason) => reason !== undefined);
  return { items, ...(stackBlocked !== undefined ? { stackBlocked: stackBlocked.trim() || "blocked" } : {}) };
}

/** The demo runner lane's objective: one dev stack, each item's demo in turn. */
export function demoRunObjective(spec, items, { worktree, sha, reports, pins }) {
  const reset = spec.defaults.demoRunner?.seedReset;
  return [
    `Run the feature demos of ${items.length} spec item(s), one after another, on one local dev stack at commit ${sha} (the target tip; it contains every item below).`,
    worktree ? `Your worktree is ${worktree} (a detached checkout of that commit), and you start in it: run every command from it with relative paths, never cd into a retyped absolute path.` : "",
    "Start the dev stack once, on your leased ports and databases (and the demo pins below), and keep it up for the whole run. Never restart it between items; restart it only if it crashed, and say so in your receipt.",
    reset
      ? `Before each item, reset the seed data with ${reset} against the running database; the stack stays up.`
      : "Before each item, reset the seed data against the running database with the project's own seed or reset script, without restarting the stack.",
    "Stop the stack when every item is done.",
    LONG_COMMANDS,
    "The items, in order:",
    ...items.map((item, index) => {
      const report = reports[item.id];
      return [
        `${index + 1}. ${item.id}: ${item.title}. Acceptance: ${item.acceptance.text}`,
        `   ${demoRule(report.path, item.acceptance.evidence.minImages, report.preview)}`,
      ].join("\n");
    }),
    ...(pins?.length ? pins : []),
    "Write each item's report (the .docx and its steps manifest) as soon as its demo is done, before you start the next item: the driver picks each one up and verifies it right away. Keep each item's screenshots in its own steps directory.",
    "If one item's demo cannot be done, say why and move on to the next; do not stop the run for it.",
    "Do not change code or Git state; this lane only runs demos.",
    "Finish with herdr_complete. In the summary, one line per item: DEMO: <id> written, or DEMO: <id> blocked <why>. If the stack could not be started at all, a line DEMO-STACK: blocked <why>.",
  ].filter(Boolean).join("\n");
}

/** Env-dependent suites run against the lane's own leased database, never fail for want of one. */
export const LANE_DATABASE_RULE =
  "Tests that need a database run against your own leased database: create it if needed, run the migrations, and set DATABASE_URL (and the other connection variables the tests read) to it for the test command. Never use another lane's or a shared database. A suite that fails only because DATABASE_URL was missing has not been run.";

/** The package and task a test command runs (turbo run <task> --filter=<pkg>, pnpm --filter <pkg> <task>). */
export function testTarget(command) {
  const text = String(command ?? "");
  const pkg = /--filter[=\s]+["']?([^\s"']+)/.exec(text)?.[1];
  const task = /\bturbo\s+(?:run\s+)?([\w:.-]+)/.exec(text)?.[1] ?? /--filter[=\s]+\S+\s+(?:run\s+)?([\w:.-]+)/.exec(text)?.[1] ?? (/\btest\b/.test(text) ? "test" : undefined);
  return pkg && task ? { package: pkg.replace(/^\.\//, ""), task } : undefined;
}

/** Whether a failing test command fails on a recorded suite baseline too (same package and task). */
export function knownBaselineFailure(command, baselines) {
  const target = testTarget(command);
  if (!target) return undefined;
  const same = (name) => name === target.package || name.split("/").at(-1) === target.package.split("/").at(-1);
  for (const [sha, baseline] of Object.entries(baselines ?? {}))
    if (baseline?.suite === "fail" && Array.isArray(baseline.failures) && baseline.failures.some((failure) => failure.task === target.task && same(String(failure.package))))
      return { sha, package: target.package, task: target.task };
  return undefined;
}

/** An item's acceptance tests with no run recorded at its integrated commit
 * (an item a batch lane merged is integrated with none). A recording at the
 * item's own integrated commit stays valid however far the target moves. */
export function untestedAtIntegration(item, current) {
  if (!current?.integratedSha) return [];
  const runs = Array.isArray(current.tests) ? current.tests : [];
  return item.acceptance.tests.filter((command) => !runs.some((run) => run.command === command && run.sha === current.integratedSha));
}

/** The demo generator lanes use (absolute path, for their Playwright runs). */
export const DEMO_TOOL = fileURLToPath(new URL("./demo-report.mjs", import.meta.url));

/** The feature demo rule for build and verify lanes. */
export function demoRule(report, minImages, preview) {
  return [
    `Required output: the feature demo ${report}, a Word document with a screenshot for every navigation or action (page visit, click, fill, submit, and the resulting state), each captioned with its step number, the action and what it shows${minImages > 0 ? `; at least ${minImages} screenshots` : ""}.`,
    `Record it from your Playwright run with the demo recorder: import { createDemoRecorder } from ${JSON.stringify(DEMO_TOOL)}; call demo.step(page, "<action>", "<what it shows>") after each navigation or action, then demo.finish({ out: ${JSON.stringify(report)}, title: "<item>: <feature>" }). It writes the .docx and ${report}.steps.json, which the verifier checks (every screenshot captioned, one per recorded step). From saved screenshots: node ${JSON.stringify(DEMO_TOOL)} --steps <steps.json> --out ${report}.`,
    "Write that command on one line, with no backslash line continuations, and keep --steps and --out inside your worktree: then it runs without a permission prompt.",
    preview?.health
      ? [
          `This demo shows the preview, so it is evidence only when the preview's health was checked, and healthy, at every screenshot (step 1 included); a report without that check at every step fails the verifier, however good it looks.`,
          `With Playwright: const demo = createDemoRecorder({ dir: "<steps dir>", previewUrl: ${JSON.stringify(preview.health)}${preview.wakePattern ? `, wakePattern: ${JSON.stringify(preview.wakePattern)}` : ""} }); then await demo.step(page, "<action>", "<what it shows>") after each navigation or action. Each step checks the preview's health first and throws, capturing nothing, when it is down (not HTTP 200, or a wake page).`,
          `With any other screenshot tool (a browser MCP, a script): right after each screenshot, record it with node ${JSON.stringify(DEMO_TOOL)} --record <steps.json> --image <png> --action "<action>" --shows "<what it shows>" --url <page url> --preview-url ${JSON.stringify(preview.health)}, which checks the preview's health at that moment; then build the report with node ${JSON.stringify(DEMO_TOOL)} --steps <steps.json> --out <report> --preview-url ${JSON.stringify(preview.health)}, which refuses steps without a healthy check. Never assemble a preview demo from screenshots taken without it.`,
          "A crash-looping, asleep or unreachable preview is never a pass: if it does not come up healthy, report the preview blocked with what you saw.",
        ].join(" ")
      : "",
  ].filter(Boolean).join(" ");
}

/** Every spec lane's last instruction: the work ends with the receipt tool call, not a plain-text report. */
export const RECEIPT_RULE =
  "Your last action when the work is done (or blocked) is the herdr_complete call with the receipt lines this task asks for, plus the outcome, blockers and report path. A plain-text final report is not a receipt. If herdr_complete returns an error, send the error and your receipt text with herdr_message.";

/** Every spec lane's instruction for declining, so a decline is a receipt, never a stall in chat. */
export const DECLINE_RULE =
  "If you will not do this work, do not stop in chat: finish with herdr_complete whose summary starts with DECLINED: <the specific reason>. If only one step is impossible, do the rest and name that step in your receipt instead of declining the whole task.";

const DECLINE_LANGUAGE =
  /\b(I (?:must |have to |will |need to |'ll )?declin\w*|I(?: am|'m) declining|I (?:can(?:no|')t|won't|will not|am unable to|am not able to) (?:do|proceed|complete|perform|carry out|continue|take on)|refus(?:e|ing) to)\b/i;

/**
 * Why a lane declined its work, from its receipt: an explicit DECLINED:
 * line, or (for stages whose receipt has required lines, when they are
 * missing) plain decline language. undefined when it did not decline.
 */
export function declineReason(summary, stage) {
  const text = String(summary ?? "");
  const explicit = /^\s*DECLINED\s*:\s*(.+)$/im.exec(text)?.[1];
  if (explicit) return explicit.trim();
  const required = {
    review: /^\s*VERDICT\s*:/im,
    integrate: /^\s*INTEGRATED\s*:/im,
    verify: /^\s*(PREVIEW|REPORT)\s*:/im,
  }[stage];
  if (!required || required.test(text)) return undefined;
  const head = text.slice(0, 1200);
  const match = DECLINE_LANGUAGE.exec(head);
  if (!match) return undefined;
  const sentence = head.slice(Math.max(0, head.lastIndexOf(".", match.index) + 1)).split(/(?<=[.!?])\s/)[0];
  return sentence.trim().slice(0, 500);
}

/**
 * The profile for the next attempt after `count` declines of a stage:
 * index 0 is the stage's own profile, then spec.stages[stage].fallbackProfiles
 * in order, each for defaults.maxDeclines attempts. undefined when every
 * configured profile has declined.
 */
export function profileAfterDeclines(spec, stage, count) {
  const per = spec.defaults.maxDeclines ?? 2;
  const fallbacks = spec.stages?.[stage]?.fallbackProfiles ?? [];
  const index = Math.floor(count / per);
  if (index > fallbacks.length) return undefined;
  return index === 0 ? { index } : { index, profile: fallbacks[index - 1] };
}

/**
 * The commit that integrated item `id`, from `git log --format=%H%x09%s`
 * output of the integration branch (newest first): its own spec(<id>)
 * commit, or a merge or integrate commit naming it. The id must match
 * exactly (D1 never matches D12).
 */
export function integrationCommitFor(log, id) {
  const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`);
  const own = new RegExp(`^\\w+\\(${escaped}\\)!?:`);
  let merged;
  for (const line of String(log ?? "").split("\n")) {
    const [sha, ...rest] = line.split("\t");
    const subject = rest.join("\t");
    if (!/^[0-9a-f]{40}$/.test(sha ?? "")) continue;
    if (own.test(subject)) return sha;
    if (!merged && named.test(subject) && /\b(merge|integrat)/i.test(subject)) merged = sha;
  }
  return merged;
}

/**
 * Retry kinds caused by the infrastructure or harness, not the lane's work:
 * a lane that never started (startup attestation, shell, bridge, a dirty
 * worktree at dispatch). They never count toward exhausting a stage; they
 * retry with backoff instead.
 */
export const INFRA_KINDS = new Set(["never started", "infrastructure"]);
/** A lane that could not start at all: an infrastructure error, not an attempt. */
export const INFRA_FAILURE = /shell did not become ready|native session reference missing|attestation incomplete or unavailable|agent_not_ready|runtime launch (?:was )?(?:blocked|denied)|could not launch its stack/i;
/** A decline about the lane's environment (its stack or tooling), not the work. */
export const ENVIRONMENT_DECLINE = /runtime launch|pnpm dev|dev server|browser (?:automation|tooling)|playwright|demo-recorder|environment|could(?: not|n't) (?:start|launch|run)|tooling (?:is )?(?:not )?available|no browser/i;
/** A verify lane that could not bring its stack up: infrastructure, not a failed preview. */
export const STACK_LAUNCH_FAILURE = /runtime launch (?:was )?(?:blocked|denied|not answered|refused)|could(?: not|n't) (?:start|launch|bring up|run) (?:the |its |my )?(?:app|stack|dev server|server|services?|preview)|cannot (?:start|launch) (?:the |its )?(?:app|stack|dev server|server|services?|pnpm dev|npm run dev)|failed to (?:start|launch) (?:the |its )?(?:app|stack|dev server|server|services?)|(?:dev server|stack|app|services?) (?:did not|didn't|never) (?:start|come up)|ECONNREFUSED|EADDRINUSE|address already in use/i;
export const INFRA_BACKOFF_MAX_MS = 30 * 60_000;
/** The wait before retry number `failures` (1, 2, ...) after an infrastructure error. */
export function infraBackoffMs(failures) {
  return Math.min(60_000 * 2 ** Math.max(0, failures - 1), INFRA_BACKOFF_MAX_MS);
}
/** Declines that count toward a stage's ladder (real lane outcomes only). */
export function countedDeclines(declines, stage) {
  return (Array.isArray(declines) ? declines : []).filter((entry) => entry.stage === stage && !INFRA_KINDS.has(entry.kind)).length;
}

/** Parse an integration lane's receipt: INTEGRATED: <sha> and SUITE: pass|fail lines. */
export function integrationResult(summary) {
  const text = String(summary ?? "");
  const sha = /^\s*INTEGRATED\s*:\s*([0-9a-f]{40})\s*$/im.exec(text)?.[1];
  const suite = /^\s*SUITE\s*:\s*(pass|fail)\b/im.exec(text)?.[1]?.toLowerCase();
  return { sha, suite };
}

/**
 * How long a done lane's background work may run before the driver stops
 * waiting on it and asks for the receipt: a hung test run (near-zero CPU for
 * hours) must not hold a slot forever.
 */
export const BACKGROUND_STALE_MS = 60 * 60_000;

/** Whether the item's lane has had background work for BACKGROUND_STALE_MS; notes it once. */
function staleBackground(current, now) {
  // Records from before the clock existed: the start of the trailing run of
  // "idle while its background work runs" notes.
  if (!current.backgroundSince) {
    let since;
    for (const entry of [...(current.history ?? [])].reverse()) {
      if (!String(entry?.note ?? "").startsWith("idle while its background work runs")) break;
      since = entry.at;
    }
    current.backgroundSince = since ?? now;
  }
  const minutes = Math.round((Date.parse(now) - Date.parse(current.backgroundSince)) / 60_000);
  if (Date.parse(now) - Date.parse(current.backgroundSince) < BACKGROUND_STALE_MS) return false;
  if (!current.backgroundStaleAt) {
    current.backgroundStaleAt = now;
    (current.history ??= []).push({ at: now, from: current.state, to: current.state, note: `background work ran ${minutes} min with the agent idle (${current.backgroundWork ?? "unknown"}); asking for its receipt` });
  }
  return true;
}

/**
 * @param {object} input
 * @param {object} input.spec       validated spec
 * @param {object} input.state      spec-state (not mutated)
 * @param {(ref: {workflowId: string, laneId: string}) => {status?: string, receipt?: {summary: string}} | undefined} input.lane
 * @param {boolean} [input.capacityWaiting] the root has a capacity gate waiting
 * @param {Set<string>} [input.pushed] integration SHAs the target branch already contains
 * @param {Map<string, string>} [input.released] item id -> preview release SHA that contains its commit
 * @param {Set<string>} [input.dirty] items whose worktree has uncommitted changes
 * @param {Map<string, string>} [input.background] "workflowId/laneId" -> the background work a lane is still running
 * @param {string} [input.integrationLive] a live integrate/verify lane found in Herdr (it reserves the integration worktree)
 * @param {string} [input.targetSha] the target tip's SHA (the suite baseline is recorded per SHA)
 * @param {Map<string, string>} [input.contained] queued items whose branch is already on the integration branch -> containing commit
 * @param {string} input.now        ISO timestamp
 * @returns {{ state: object, actions: Array<{kind: "build"|"review", itemId: string, attempt: number, findings?: string}>, rootAsks: Array<{itemId: string, reason: string}>, waits: Record<string, string> }}
 */
export function advanceSpec({
  spec,
  state,
  lane,
  journalProblems = new Map(),
  capacityWaiting = false,
  pushed = new Set(),
  released = new Map(),
  dirty = new Set(),
  background = new Map(),
  integrationLive,
  contained = new Map(),
  targetSha,
  now,
}) {
  const next = structuredClone(state ?? { version: 1, items: {} });
  next.items ??= {};
  for (const item of Object.values(next.items)) dropStaleBookkeeping(item);
  const actions = [];
  const rootAsks = [];
  const rollbacks = [];
  const reclaimed = [];
  const waits = {};
  const record = (id) => (next.items[id] ??= { state: "pending" });
  const move = (id, to, extra = {}, note) => {
    const item = record(id);
    const from = item.state ?? "pending";
    // A new stage gets a new lane: the last lane's receipt and background
    // bookkeeping does not carry over.
    if (from !== to) for (const key of LANE_BOOKKEEPING) delete item[key];
    Object.assign(item, extra, { state: to, since: now });
    if (to !== "blocked") delete item.blockedReason;
    (item.history ??= []).push({ at: now, from, to, ...(note ? { note } : {}) });
    if (item.history.length > 50) item.history.splice(0, item.history.length - 50);
  };

  /**
   * A stage whose lane did not finish for a mechanical reason (it declined,
   * went idle without a receipt, sent an unclear receipt, or never started)
   * is retried with a fresh lane, then with the stage's fallback profiles.
   * Only an exhausted ladder is held, as "exhausted" (human-gate is for
   * push, deploy, production and scope), and the root is told once.
   * Returns false when the ladder is exhausted.
   */
  const STATE_OF = { decide: "deciding", build: "building", review: "reviewing", integrate: "integrating", verify: "verifying" };
  const retryStage = (item, current, stage, kind, reason) => {
    const declines = (current.declines ??= []);
    declines.push({ at: now, stage, kind, reason: String(reason).slice(0, 500), ...(current.lane ? { lane: current.lane } : {}), ...(current.declined?.profile ? { profile: current.declined.profile } : {}) });
    if (declines.length > 20) declines.splice(0, declines.length - 20);
    const infra = INFRA_KINDS.has(kind);
    const count = countedDeclines(declines, stage);
    const choice = profileAfterDeclines(spec, stage, count);
    const from = current.lane?.workflowId;
    delete current.lane;
    delete current.receiptAskedAt;
    delete current.receiptEscalatedAt;
    delete current.receiptAskAfter;
    if (infra) {
      // Not the lane's fault: never exhausts, retries after a growing wait.
      current.infraFailures = (current.infraFailures ?? 0) + 1;
      current.infraRetryAfter = new Date(Date.parse(now) + infraBackoffMs(current.infraFailures)).toISOString();
      if (current.infraFailures >= 5 && !current.infraAlertedAt) {
        current.infraAlertedAt = now;
        rootAsks.push({ itemId: item.id, reason: `${item.id}: its ${stage} lanes failed to start ${current.infraFailures} times in a row (${String(reason).slice(0, 200)}); the driver keeps retrying every ${Math.round(INFRA_BACKOFF_MAX_MS / 60_000)} min, check the harness` });
      }
      if (current.state !== STATE_OF[stage]) move(item.id, STATE_OF[stage], {}, `recovered for a fresh ${stage} lane`);
      current.declined = { stage, kind, reason: String(reason).slice(0, 500), count, ...(current.declined?.stage === stage && current.declined.profile ? { profile: current.declined.profile } : choice?.profile ? { profile: choice.profile } : {}) };
      (current.history ??= []).push({ at: now, from: current.state, to: current.state, note: `${stage} lane${from ? ` ${from}` : ""} never started (${String(reason).slice(0, 160)}): an infrastructure error, not counted; retrying after ${current.infraRetryAfter}` });
      return true;
    }
    if (!choice) {
      move(item.id, "blocked", { blockedReason: "exhausted", note: `${stage}: ${count} lane(s) did not finish (${kind}) with every configured profile: ${String(reason).slice(0, 200)}` }, `${stage} retries exhausted`);
      rootAsks.push({ itemId: item.id, reason: `${item.id}: ${count} ${stage} lane(s) did not finish, with every profile in spec.stages.${stage} (profile, fallbackProfiles). Last: ${kind}: ${String(reason).slice(0, 300)}. Add a fallback profile or decide how to proceed.` });
      return false;
    }
    if (current.state !== STATE_OF[stage]) move(item.id, STATE_OF[stage], {}, `recovered for a fresh ${stage} lane`);
    current.declined = { stage, kind, reason: String(reason).slice(0, 500), count, ...(choice.profile ? { profile: choice.profile } : {}) };
    (current.history ??= []).push({ at: now, from: current.state, to: current.state, note: `${stage} lane${from ? ` ${from}` : ""} did not finish (${kind}, ${count}): ${String(reason).slice(0, 160)}; retrying${choice.profile ? ` with profile ${choice.profile}` : " with a fresh lane"}` });
    return true;
  };

  // A0. Demos that failed only for want of a preview health check (lanes
  // assembled them from screenshots taken without one) get a fresh demo
  // lane now, under the recorder that checks it, rather than after their backoff.
  for (const item of spec.items) {
    const current = next.items[item.id];
    if (current?.state !== "verifying" || current.lane || current.healthRuleRearmedAt) continue;
    if (!/no preview health check at capture/.test(current.evidenceProblem ?? "")) continue;
    current.healthRuleRearmedAt = now;
    delete current.evidenceRetryAfter;
    (current.history ??= []).push({ at: now, from: current.state, to: current.state, note: "re-armed: its demo lacked the preview health check; a fresh demo lane records it with the checking recorder" });
  }

  // A. Items an older driver held at the human gate for a mechanical reason
  // (an idle lane, an unclear receipt) go back on the retry ladder.
  for (const item of spec.items) {
    const current = next.items[item.id];
    if (current?.state !== "blocked" || current.blockedReason !== "human-gate" || current.blockedCause) continue;
    // Held on a recorded test failure (test failures are never a human
    // gate): the runs are dropped and the tests run again, on a prepared
    // checkout with the lane's own database, under the baseline-relative gate.
    if (/^test failed at the integrated commit/.test(current.note ?? "")) {
      const sha = current.integratedSha;
      current.tests = (Array.isArray(current.tests) ? current.tests : []).filter((run) => !(run.sha === sha && run.result === "fail"));
      move(item.id, "verifying", { note: undefined }, "re-armed: a recorded test failure is not a human gate; its tests run again, judged against the suite baseline");
      delete current.note;
      delete current.blockedReason;
      continue;
    }
    const idle = /^(decide|build|review|integrate|verify) lane is idle without a receipt, even after being asked$/.exec(current.note ?? "")?.[1];
    const unclear = /^integration receipt has no INTEGRATED/.test(current.note ?? "") ? "integrate" : /^review receipt has no VERDICT/.test(current.note ?? "") ? "review" : undefined;
    const stage = idle ?? unclear;
    if (!stage) continue;
    delete current.blockedReason;
    retryStage(item, current, stage, idle ? "idle without a receipt" : "unclear receipt", current.note);
    delete current.note;
  }

// A3. An item resolved by decision whose spec now asks for evidence (its
// adopt.resolved removed, acceptance.evidence added) no longer counts as
// done: it is verified like any other, against the target tip when it has
// no integrated commit of its own (no code changed), so its demo is made.
for (const item of spec.items) {
  const current = next.items[item.id];
  if (current?.state !== "resolved" || !item.acceptance.evidence || item.adopt?.resolved) continue;
  const sha = current.integratedSha ?? (typeof targetSha === "string" && targetSha ? targetSha : undefined);
  if (!sha) continue;
  delete current.resolution;
  move(item.id, "verifying", { integratedSha: sha }, "the spec now requires evidence: resolved by decision no longer counts; verified with a demo");
}

  // A2. Items parked or failed by an infrastructure error (a shell that was
  // not ready, a session reference missing, a runtime launch nobody
  // answered, a stack that would not start) before those counted as
  // infrastructure go back on the retry ladder, once per item. A human gate
  // for push, deploy, production or scope is never touched.
  for (const item of spec.items) {
    const current = next.items[item.id];
    if (!current || current.rearmed) continue;
    const lastDecline = (current.declines ?? []).at(-1);
    const verifySummary = current.verifyLane ? lane(current.verifyLane)?.receipt?.summary : undefined;
    let stage;
    let reason;
    if (current.state === "blocked" && current.blockedReason === "human-gate" && /^preview (?:failed|not run)/.test(current.note ?? "")) {
      const launch = verifySummary && (/^\s*PREVIEW\s*:\s*\S+\s+blocked\b/im.test(verifySummary) || STACK_LAUNCH_FAILURE.test(verifySummary));
      const declined = lastDecline?.stage === "verify" && ["declined", "never started", "infrastructure"].includes(lastDecline.kind);
      if (launch || declined) {
        stage = "verify";
        reason = launch ? "the verify lane could not launch its stack" : `the verify lane did not run the previews (${lastDecline.kind}: ${String(lastDecline.reason).slice(0, 160)})`;
      }
    } else if (current.state === "blocked" && current.blockedReason === "exhausted") {
      const exhaustedStage = /^(decide|build|review|integrate|verify):/.exec(current.note ?? "")?.[1];
      const stageDeclines = (current.declines ?? []).filter((entry) => entry.stage === exhaustedStage && !INFRA_KINDS.has(entry.kind));
      if (exhaustedStage && stageDeclines.length && stageDeclines.every((entry) => ENVIRONMENT_DECLINE.test(String(entry.reason)))) {
        stage = exhaustedStage;
        reason = "every lane declined for an environment problem (runtime launch, dev server or browser tooling), not the work";
      }
    } else if (current.state === "failed" && INFRA_FAILURE.test(current.note ?? "")) {
      stage = /^(decide|build|review|integrate|verify) failed:/.exec(current.note ?? "")?.[1] ?? current.laneStage;
      reason = `it failed on an infrastructure error, not its work: ${String(current.note).slice(0, 160)}`;
      // The attempts spent on lanes that never started do not count.
      if (stage === "build" && (current.attempts ?? 0) >= spec.defaults.maxBuildAttempts) current.attempts = spec.defaults.maxBuildAttempts - 1;
    }
    if (!stage || !STATE_OF[stage]) continue;
    current.rearmed = { at: now, from: current.state, reason };
    delete current.blockedReason;
    delete current.note;
    retryStage(item, current, stage, "infrastructure", `re-armed: ${reason}`);
  }

  // B. The suite baseline at the target tip: a baseline lane's receipt
  // records it once per target SHA; a fix-baseline lane's receipt records
  // what is still failing after its fixes.
  const useBaseline = spec.target.suite.length > 0 && typeof targetSha === "string" && targetSha.length > 0;
  if (useBaseline && next.baselineRun?.lane) {
    const run = next.baselineRun;
    const view = lane(run.lane);
    const declined = view?.receipt ? declineReason(view.receipt.summary, "integrate") : undefined;
    if (declined && (run.declined?.count ?? 0) < 3) {
      // A declined baseline or fix lane is retried with its reason.
      run.declined = { reason: declined, count: (run.declined?.count ?? 0) + 1, at: now };
      delete run.lane;
    } else if (view?.receipt) {
      const result = baselineResult(view.receipt.summary);
      next.baselines ??= {};
      if (run.kind === "baseline") {
        const unclear = !result.suite || (result.suite === "fail" && !result.failures.length);
        next.baselines[run.targetSha] = unclear
          ? { unknown: true, at: now, lane: run.lane, note: "the baseline receipt names no SUITE result or no FAILED lines" }
          : { suite: result.suite, failures: result.suite === "pass" ? [] : result.failures, at: now, lane: run.lane };
        if (unclear) rootAsks.push({ itemId: "baseline", reason: `the suite baseline at ${run.targetSha.slice(0, 12)} is unclear (no SUITE line, or SUITE: fail without FAILED: <package> <task> lines); integrations are judged on SUITE: pass alone` });
      } else {
        const sha = /^\s*INTEGRATED\s*:\s*([0-9a-f]{40})\s*$/im.exec(view.receipt.summary)?.[1];
        const base = (next.baselines[run.targetSha] ??= { suite: "fail", failures: [], at: now });
        base.fix = result.suite
          ? { sha, suite: result.suite, remaining: result.suite === "pass" ? [] : result.failures, at: now, lane: run.lane }
          : { gaveUp: true, at: now, note: "the fix-baseline receipt has no SUITE line" };
      }
      delete next.baselineRun;
      const shas = Object.keys(next.baselines);
      for (const old of shas.slice(0, Math.max(0, shas.length - BASELINES_KEPT))) delete next.baselines[old];
    } else if (view && (view.agentStatus === "done" || view.agentStatus === "gone") && !LANE_ENDED.has(view.status ?? "")) {
      // Idle without its receipt: asked once, then replaced by a fresh lane.
      if (!run.askedAt) {
        run.askedAt = now;
        actions.push({ kind: "ask-baseline-receipt", itemId: "", attempt: run.attempts ?? 1, lane: run.lane, targetSha: run.targetSha });
      } else if (Date.parse(now) - Date.parse(run.askedAt) > RECEIPT_ASK_TIMEOUT_MS) {
        run.attempts = (run.attempts ?? 1) + 1;
        delete run.lane;
        delete run.askedAt;
        if (run.attempts > 3) {
          next.baselines ??= {};
          if (run.kind === "baseline") next.baselines[run.targetSha] = { unknown: true, at: now, note: "baseline lanes went idle without a receipt three times" };
          else if (next.baselines[run.targetSha]) next.baselines[run.targetSha].fix = { gaveUp: true, at: now, note: "fix-baseline lanes went idle without a receipt three times" };
          delete next.baselineRun;
        }
      }
    } else if (view && (view.status === "dispatch-failed" || view.workflowStatus === "dispatch-failed")) {
      // It never started (a shell or session that was not ready): an
      // infrastructure error, not an attempt. A fresh lane after a backoff.
      run.infraFailures = (run.infraFailures ?? 0) + 1;
      run.retryAfter = new Date(Date.parse(now) + infraBackoffMs(run.infraFailures)).toISOString();
      delete run.lane;
    } else if (!view || LANE_ENDED.has(view.status)) {
      run.attempts = (run.attempts ?? 1) + 1;
      delete run.lane;
      if (run.attempts > 2) {
        next.baselines ??= {};
        if (run.kind === "baseline") next.baselines[run.targetSha] = { unknown: true, at: now, note: "the baseline lane ended twice without a receipt" };
        else if (next.baselines[run.targetSha]) next.baselines[run.targetSha].fix = { gaveUp: true, at: now, note: "the fix-baseline lane ended twice without a receipt" };
        delete next.baselineRun;
      }
    }
  }
  const baseline = useBaseline ? next.baselines?.[targetSha] : undefined;
  const known = knownFailures(baseline);

  // 0. A lane that went idle (done) without its receipt is asked once for
  // it, then handed to the root; a lane whose pane is gone is retried.
  for (const item of spec.items) {
    const current = record(item.id);
    const stage = STAGE_OF[current.state];
    if (!stage || !current.lane) continue;
    const view = lane(current.lane);
    if (!view || view.receipt) {
      delete current.receiptAskedAt;
      continue;
    }
    if (view.agentStatus === "gone") {
      const attempts = current.attempts ?? 1;
      const counts = stage === "build" && !dirty.has(item.id);
      (current.history ??= []).push({ at: now, from: current.state, to: current.state, note: `lane gone without a receipt; retried${counts ? "" : " without counting an attempt"}` });
      delete current.lane;
      delete current.receiptAskedAt;
      if (counts) {
        if (attempts >= spec.defaults.maxBuildAttempts) {
          move(item.id, "failed", {}, "build lane gone without a receipt");
          rootAsks.push({ itemId: item.id, reason: `${item.id}: its build lane is gone without a receipt after ${attempts} attempt(s)` });
        } else current.attempts = attempts + 1;
      }
    } else if ((view.agentStatus === "done" || view.agentStatus === "idle") && background.has(`${current.lane.workflowId}/${current.lane.laneId}`) && !staleBackground(current, now)) {
      // Idle only on the surface: its tracked background shell or monitor is
      // still running. Not stuck: no receipt ask, no block.
      const work = background.get(`${current.lane.workflowId}/${current.lane.laneId}`);
      if (current.backgroundWork !== work) {
        current.backgroundWork = work;
        (current.history ??= []).push({ at: now, from: current.state, to: current.state, note: `idle while its background work runs: ${work}` });
      }
      delete current.receiptAskedAt;
      continue;
    } else if (view.agentStatus === "done" || view.agentStatus === "idle") {
      // Herdr shows a finished turn as done, or idle once the pane was seen.
      delete current.backgroundWork;
      // Stale background work keeps its clock; gone background work resets it.
      if (!background.has(`${current.lane.workflowId}/${current.lane.laneId}`)) {
        delete current.backgroundSince;
        delete current.backgroundStaleAt;
      }
      // An integration whose commits are already on the integration branch
      // needs no receipt: it is recorded as integrated there (1c0 below).
      if (stage === "integrate" && contained.has(item.id)) {
        (current.history ??= []).push({ at: now, from: current.state, to: current.state, note: `integrate lane ${current.lane.workflowId} finished without a receipt, but its commits are on the integration branch` });
        for (const key of ["lane", "receiptAskedAt", "receiptPointedAt", "receiptInferRequestedAt"]) delete current[key];
        continue;
      }
      // The driver found no report to infer a receipt from: a fresh lane.
      if (current.receiptInferFailedAt) {
        const why = current.receiptInferFailedAt;
        for (const key of ["receiptInferFailedAt", "receiptInferRequestedAt", "receiptPointedAt"]) delete current[key];
        retryStage(item, current, stage, "idle without a receipt", `lane ${current.lane.workflowId}/${current.lane.laneId} finished without a receipt or a readable report (${why})`);
        continue;
      }
      if (!current.receiptAskedAt) {
        current.receiptAskedAt = now;
        actions.push({ kind: "ask-receipt", itemId: item.id, attempt: current.attempts ?? 1, stage, lane: current.lane, format: RECEIPT_FORMAT[stage] });
        continue;
      }
      // A reply (its report, or a failure it hit) or one interval after the
      // ask: one pointed ask for the receipt tool call.
      if (!current.receiptPointedAt) {
        const replied = view.lastMessageAt && Date.parse(view.lastMessageAt) > Date.parse(current.receiptAskedAt);
        if (replied || Date.parse(now) - Date.parse(current.receiptAskedAt) > RECEIPT_ASK_INTERVAL_MS) {
          current.receiptPointedAt = now;
          actions.push({ kind: "ask-receipt", pointed: true, itemId: item.id, attempt: current.attempts ?? 1, stage, lane: current.lane, format: RECEIPT_FORMAT[stage] });
        }
        continue;
      }
      // Still none an interval after the pointed ask: the driver records a
      // receipt from the lane's final report, marked inferred.
      if (!current.receiptInferRequestedAt && Date.parse(now) - Date.parse(current.receiptPointedAt) > RECEIPT_ASK_INTERVAL_MS) {
        current.receiptInferRequestedAt = now;
        actions.push({ kind: "infer-receipt", itemId: item.id, attempt: current.attempts ?? 1, stage, lane: current.lane, since: current.receiptAskedAt });
      }
    }
  }

  // 1-. A lane that declined its work is retried in the same stage with its
  // reason; after defaults.maxDeclines declines, with the stage's next
  // fallback profile. Only when every configured profile declined is the
  // item held for the root.
  for (const item of spec.items) {
    const current = next.items[item.id];
    const stage = current ? STAGE_OF[current.state] : undefined;
    if (!stage || !current.lane) continue;
    const view = lane(current.lane);
    // A lane whose workflow never started (a failed startup attestation, a
    // shell that never came up) climbs the ladder, whatever its lane status.
    if (view && !view.receipt && (view.workflowStatus === "dispatch-failed" || view.status === "dispatch-failed")) {
      retryStage(item, current, stage, "never started", `lane ${current.lane.workflowId} dispatch-failed`);
      continue;
    }
    if (!view?.receipt) continue;
    // A lane that delivered a receipt started fine: the infrastructure is back.
    delete current.infraFailures;
    delete current.infraRetryAfter;
    delete current.infraAlertedAt;
    const reason = declineReason(view.receipt.summary, stage);
    if (!reason) {
      if (current.declined?.stage === stage) delete current.declined;
      continue;
    }
    retryStage(item, current, stage, "declined", reason);
  }

  // 1. Receipts and lane endings advance in-flight items.
  for (const item of spec.items) {
    const current = record(item.id);
    if (current.state === "verifying") {
      const view = current.lane ? lane(current.lane) : undefined;
      if (!view) continue;
      if (view.receipt) {
        const result = verifyResult(view.receipt.summary);
        // A lane sent only to record the item's tests judges nothing else.
        const testsOnly = Boolean(current.verifyTestsOnly);
        delete current.verifyTestsOnly;
        const asked = untestedAtIntegration(item, current);
        // Baseline-relative, like the integration gate: a test that fails
        // the same way on a recorded suite baseline (same package and task)
        // is not the item's failure.
        const testRuns = result.tests
          .filter((run) => item.acceptance.tests.includes(run.command) && run.result !== "blocked")
          .map((run) => {
            const known = run.result === "fail" ? knownBaselineFailure(run.command, next.baselines) : undefined;
            return known
              ? { command: run.command, result: "pass", sha: current.integratedSha, at: now, by: "verify", relativeToBaseline: true, baselineSha: known.sha }
              : { ...run, sha: current.integratedSha, at: now, by: "verify" };
          });
        if (testRuns.length) current.tests = [...(Array.isArray(current.tests) ? current.tests : []), ...testRuns];
        const testsBlocked = result.tests.some((run) => run.result === "blocked");
        const testsFailed = testRuns.filter((run) => run.result === "fail");
        const testsMissing = untestedAtIntegration(item, current).filter((command) => asked.includes(command));
        const runs = testsOnly ? [] : result.previews.map((run) => ({ ...run, sha: current.integratedSha, releaseSha: current.releaseSha, at: now }));
        const failed = runs.filter((run) => run.result !== "pass");
        const missing = testsOnly ? [] : item.acceptance.preview.filter((path) => !runs.some((run) => run.spec === path));
        current.preview = [...(Array.isArray(current.preview) ? current.preview : []), ...runs];
        current.verifyLane = current.lane;
        if (testsBlocked || (testsMissing.length && !testsFailed.length)) {
          // Nothing recorded: the tests could not run (a stack, a database) or
          // the receipt has no TEST: line for them. A fresh lane runs them.
          if (testsBlocked || STACK_LAUNCH_FAILURE.test(view.receipt.summary))
            retryStage(item, current, "verify", "infrastructure", `the verify lane could not run the item's tests: ${String(view.receipt.summary).split("\n").find((line) => /blocked|TEST|launch|start|ECONN|EADDR/i.test(line))?.slice(0, 200) ?? "see its receipt"}`);
          else retryStage(item, current, "verify", "unclear receipt", `the verify receipt has no TEST: <command> pass|fail line for ${testsMissing.join("; ")}`);
          continue;
        }
        delete current.lane;
        if (testsFailed.length) {
          // A new failure is the item's to fix: back to build with the
          // failing tests quoted, never a human gate.
          const attempts = current.attempts ?? 1;
          const quoted = String(view.receipt.summary).split("\n").filter((line) => /\bTEST\s*:|\bFAIL|✕|✗|failed|Error\b|error TS\d+/i.test(line)).slice(0, 40).join("\n");
          const findings = `Its tests fail at its integrated commit ${String(current.integratedSha).slice(0, 12)}, in ways the suite baseline does not: ${testsFailed.map((run) => run.command).join("; ")}. Fix them on spec/${item.id} (rebase onto spec-integration first):\n${quoted.slice(0, 6000)}`;
          if (attempts >= spec.defaults.maxBuildAttempts) {
            move(item.id, "failed", { findings }, "tests failed at the integrated commit");
            rootAsks.push({ itemId: item.id, reason: `${item.id} failed ${attempts} build attempt(s): its tests fail at its integrated commit (${testsFailed.map((run) => run.command).join("; ")})` });
          } else move(item.id, "ready", { findings, attempts: attempts + 1 }, "tests failed at the integrated commit");
          continue;
        }
        if (testsOnly) continue;
        if (result.report) current.finalReport = result.report;
        // A lane that could not launch its stack verified nothing: retry the
        // stage as infrastructure (never counted), never a human gate.
        if ((failed.length || missing.length) && (runs.some((run) => run.result === "blocked") || STACK_LAUNCH_FAILURE.test(view.receipt.summary))) {
          retryStage(item, current, "verify", "infrastructure", `the verify lane could not launch its stack: ${String(view.receipt.summary).split("\n").find((line) => /blocked|STACK|launch|start|ECONN|EADDR/i.test(line))?.slice(0, 200) ?? "see its receipt"}`);
          continue;
        }
        if (failed.length || missing.length) {
          move(item.id, "blocked", {
            blockedReason: "human-gate",
            note: failed.length ? `preview failed: ${failed.map((run) => run.spec).join(", ")}` : `preview not run: ${missing.join(", ")}`,
          });
          rootAsks.push({ itemId: item.id, reason: `${item.id}: verification on the preview ${failed.length ? "failed" : "is incomplete"} after the push; decide whether to fix forward` });
        } else current.verified = now;
      } else if (LANE_ENDED.has(view.status)) delete current.lane;
      continue;
    }
    if (current.state === "deciding") {
      const view = current.lane ? lane(current.lane) : undefined;
      if (!view) continue;
      if (view.receipt) {
        const result = decideResult(view.receipt.summary);
        const decided = { summary: view.receipt.summary, at: now, ...(result.owns ? { owns: result.owns } : {}), ...(result.migrations !== undefined ? { migrations: result.migrations } : {}) };
        if (result.questions.length)
          move(item.id, "blocked", { blockedReason: "decision", lane: undefined, decided, questions: result.questions, note: `${result.questions.length} open question(s)` }, "decide stage left questions");
        else move(item.id, "pending", { lane: undefined, decided }, "decided");
      } else if (LANE_ENDED.has(view.status)) delete current.lane;
      continue;
    }
    if (current.state === "integrating") {
      const view = current.lane ? lane(current.lane) : undefined;
      if (!view) continue;
      if (view.receipt) {
        const result = integrationResult(view.receipt.summary);
        // Baseline-relative: a failing suite whose every failure already
        // fails at the target tip, per package and task, is a pass.
        let relative;
        if (result.sha && result.suite === "fail" && useBaseline) {
          const failures = suiteFailures(view.receipt.summary);
          if (failures.length && !baseline) {
            waits[item.id] = `waiting for the suite baseline at ${targetSha.slice(0, 12)} to judge its failures (${formatFailures(failures)})`;
            continue;
          }
          if (failures.length && known) {
            const verdict = compareToBaseline(failures, known);
            if (verdict.pass) relative = verdict.known;
            else current.newFailures = verdict.fresh;
          }
        }
        // A merge whose migration journal goes back in time is not kept:
        // databases already past the newer entry would skip the item's
        // migrations silently. The item goes back to build with the finding,
        // and spec-integration is rolled back off the merge.
        const journal = result.sha ? journalProblems.get(item.id) : undefined;
        if (journal?.length) {
          const attempts = current.attempts ?? 1;
          const findings = `Integration onto spec-integration at ${result.sha.slice(0, 12)} was not kept: the item's migration journal entries are not later than the ones before them, so migrators skip them on any database that already has the newer migration.\n${journal.map((line) => `- ${line}`).join("\n")}\nRebase spec/${item.id} onto spec-integration, then give each of the item's journal entries a "when" later than every entry before it (renumber the migrations after the ones already there if needed).`;
          rollbacks.push({ itemId: item.id, sha: result.sha });
          if (attempts >= spec.defaults.maxBuildAttempts) {
            move(item.id, "failed", { findings, lane: undefined }, "migration journal out of order");
            rootAsks.push({ itemId: item.id, reason: `${item.id} failed integration after ${attempts} build attempt(s): its migration journal is out of order` });
          } else move(item.id, "ready", { findings, lane: undefined }, "migration journal out of order");
          continue;
        }
        if (result.sha && (result.suite === "pass" || relative)) {
          next.integrationCounter = (next.integrationCounter ?? 0) + 1;
          move(
            item.id,
            "awaiting-push",
            {
              integrateLane: current.lane,
              lane: undefined,
              integration: {
                sha: result.sha,
                order: next.integrationCounter,
                at: now,
                ...(relative ? { baselineSha: targetSha, baselineFailures: relative } : {}),
              },
              tests: [
                ...(Array.isArray(current.tests) ? current.tests : []),
                ...item.acceptance.tests.map((command) => ({ command, sha: result.sha, result: "pass", at: now, by: "integrate", ...(relative ? { relativeToBaseline: true } : {}) })),
              ],
            },
            relative ? `integrated; the suite fails only where the target already fails: ${formatFailures(relative)}` : "integrated",
          );
          delete next.items[item.id].newFailures;
        } else if (result.suite === "fail") {
          const attempts = current.attempts ?? 1;
          const fresh = current.newFailures;
          delete current.newFailures;
          const findings = `Integration onto spec-integration failed its suite${fresh?.length ? ` in tasks the target does not already fail: ${formatFailures(fresh)}` : ""}. Rebase spec/${item.id} onto spec-integration and fix:\n${view.receipt.summary}`;
          if (attempts >= spec.defaults.maxBuildAttempts) {
            move(item.id, "failed", { findings, lane: undefined }, "integration suite failed");
            rootAsks.push({ itemId: item.id, reason: `${item.id} failed integration after ${attempts} build attempt(s)` });
          } else move(item.id, "ready", { findings, lane: undefined }, "integration suite failed");
        } else {
          retryStage(item, current, "integrate", "unclear receipt", "the integration receipt has no INTEGRATED: <sha> and SUITE: pass|fail lines");
        }
      } else if (LANE_ENDED.has(view.status)) {
        // The merge is retried by a fresh integration lane; it is not a build
        // attempt. One that never started climbs the retry ladder.
        if (view.status === "dispatch-failed") retryStage(item, current, "integrate", "never started", `lane ${current.lane.workflowId} ${view.status}`);
        else delete current.lane;
      }
      continue;
    }
    if (current.state !== "building" && current.state !== "reviewing") continue;
    const view = current.lane ? lane(current.lane) : undefined;
    const attempts = current.attempts ?? 1;
    const failAttempt = (why, findings) => {
      if (attempts >= spec.defaults.maxBuildAttempts) {
        move(item.id, "failed", { findings }, why);
        rootAsks.push({ itemId: item.id, reason: `${item.id} failed ${attempts} build attempt(s): ${why}` });
      } else move(item.id, "ready", { findings, attempts, lane: undefined }, why);
    };
    if (view?.receipt) {
      if (current.state === "building") {
        move(item.id, "reviewing", { buildLane: current.lane, lane: undefined, buildSummary: view.receipt.summary }, "build receipt");
        actions.push({ kind: "review", itemId: item.id, attempt: attempts });
        continue;
      }
      const verdict = reviewVerdict(view.receipt.summary);
      if (verdict === "pass") move(item.id, "integrating", { reviewLane: current.lane, lane: undefined, findings: undefined }, "review passed");
      else if (verdict === "fail") failAttempt("review failed", view.receipt.summary);
      else {
        if (retryStage(item, current, "review", "unclear receipt", "the review receipt has no VERDICT: PASS or VERDICT: FAIL line") && !capacityWaiting)
          actions.push({ kind: "review", itemId: item.id, attempt: attempts });
      }
    } else if (view && view.status === "dispatch-failed")
      // It never started (startup attestation, shell): not a build attempt.
      retryStage(item, current, STAGE_OF[current.state], "never started", `lane ${current.lane.workflowId} ${view.status}`);
    else if (view && LANE_ENDED.has(view.status))
      failAttempt(`${current.state === "building" ? "build" : "review"} lane ended (${view.status}) without a receipt`);
    // A stage whose dispatch never produced a lane is retried, under the
    // same capacity hold as a new build.
    else if (!current.lane) {
      if (capacityWaiting) waits[item.id] = `capacity: ${typeof capacityWaiting === "string" ? capacityWaiting : "the root is waiting on a capacity gate"}`;
      else actions.push({ kind: current.state === "building" ? "build" : "review", itemId: item.id, attempt: attempts, ...(current.findings ? { findings: current.findings } : {}) });
    }
  }

  // 1b. Pushed integrations move on to verification.
  for (const item of spec.items) {
    const current = record(item.id);
    if (current.state === "awaiting-push" && current.integration?.sha && pushed.has(current.integration.sha))
      move(item.id, "verifying", { integratedSha: current.integration.sha }, "pushed to the target branch");
  }

  // 1c. One serial integration queue, in dependency order. The integration
  // worktree stays reserved by any integrate or verify lane whose workflow
  // is still open, even when its item was blocked or the lane went idle
  // without a receipt: a second lane there would collide.
  // A lock is held only by a live owner. A lane whose agent is done or gone
  // holds it only while its item still waits on it in that stage (the
  // receipt ask runs, or its own background work does); once the item has
  // moved on (blocked, failed, re-queued) or the ask escalated, nothing will
  // ever release it, so it is reclaimed and the queue moves on.
  const reservedItem = spec.items.find((item) => {
    const current = next.items[item.id];
    if (!current?.lane) return false;
    const view = lane(current.lane);
    const stage = current.laneStage ?? view?.specStage ?? STAGE_OF[current.state];
    // Verify lanes run in their own worktrees (spec-verify*), never here.
    if (stage !== "integrate") return false;
    if (view && CLOSED_WORKFLOW.has(view.workflowStatus ?? "")) return false;
    const idle = view && (view.agentStatus === "done" || view.agentStatus === "gone" || LANE_ENDED.has(view.status ?? ""));
    const waitingOnIt = STAGE_OF[current.state] === stage && !current.receiptEscalatedAt;
    const working = background.has(`${current.lane.workflowId}/${current.lane.laneId}`) && !current.backgroundStaleAt;
    if (idle && !waitingOnIt && !working) {
      if (!current.lockReclaimedAt) {
        current.lockReclaimedAt = now;
        (current.history ??= []).push({ at: now, from: current.state, to: current.state, note: `released the integration worktree: its ${stage} lane ${current.lane.workflowId} is ${view.agentStatus ?? view.status} and the item is ${current.state}` });
        reclaimed.push(`${item.id}'s ${stage} lane ${current.lane.workflowId} (${view.agentStatus ?? view.status}, item ${current.state})`);
      }
      return false;
    }
    return true;
  });
  const reservedBy = reservedItem
    ? `${reservedItem.id}'s lane ${next.items[reservedItem.id].lane.workflowId} is still open`
    : integrationLive;

  // 1c0. A queued item whose branch is already on the integration branch
  // (a batch lane merged it) is integrated at the commit that contains it.
  for (const item of spec.items) {
    const current = next.items[item.id];
    if (current?.state !== "integrating" || current.lane || !contained.has(item.id)) continue;
    const sha = contained.get(item.id);
    const sameCommit = spec.items
      .map((other) => next.items[other.id])
      .find((other) => other?.integration?.sha === sha && Array.isArray(other.tests) && other.tests.some((run) => run.sha === sha && run.result === "pass"));
    next.integrationCounter = (next.integrationCounter ?? 0) + 1;
    move(
      item.id,
      "awaiting-push",
      {
        integration: { sha, order: next.integrationCounter, at: now, contained: true },
        // The suite result at that commit is known only when another item
        // integrated there recorded it; otherwise the verifier waits.
        ...(sameCommit
          ? { tests: [...(Array.isArray(current.tests) ? current.tests : []), ...item.acceptance.tests.map((command) => ({ command, sha, result: "pass", at: now, by: "contained" }))] }
          : {}),
      },
      `already on the integration branch at ${sha.slice(0, 12)}`,
    );
  }
  if (reclaimed.length)
    rootAsks.push({
      itemId: "integration-lock",
      reason: `Reclaimed the spec-integration lock from ${reclaimed.join("; ")}: no live agent held it. The next integration is dispatched by the driver; nothing to wait for. Resolve the blocked item separately (read its lane, set its outcome).`,
    });
  // B2. Record the baseline once per target SHA when an item is queued for
  // integration; with defaults.fixBaseline, one lane fixes its failures on
  // the integration branch before any item is merged there.
  const queued = spec.items.some((item) => next.items[item.id]?.state === "integrating");
  if (useBaseline && queued && !next.baselineRun) {
    if (!baseline) next.baselineRun = { kind: "baseline", targetSha, attempts: 1, requestedAt: now };
    else if (spec.defaults.fixBaseline && known?.length && !baseline.fix && !reservedBy && !spec.items.some((item) => next.items[item.id]?.state === "integrating" && next.items[item.id].lane))
      next.baselineRun = { kind: "fix-baseline", targetSha, attempts: 1, requestedAt: now };
  }
  if (next.baselineRun && next.baselineRun.targetSha !== targetSha && !next.baselineRun.lane) delete next.baselineRun;
  const baselineBackoff = typeof next.baselineRun?.retryAfter === "string" && Date.parse(now) < Date.parse(next.baselineRun.retryAfter);
  if (useBaseline && next.baselineRun && !next.baselineRun.lane && !capacityWaiting && !baselineBackoff)
    actions.push({
      kind: next.baselineRun.kind,
      itemId: "",
      attempt: next.baselineRun.attempts ?? 1,
      targetSha: next.baselineRun.targetSha,
      ...(next.baselineRun.kind === "fix-baseline" ? { failures: known ?? [] } : {}),
    });
  const fixing = next.baselineRun?.kind === "fix-baseline";
  if (fixing) {
    for (const item of spec.items)
      if (next.items[item.id]?.state === "integrating" && !next.items[item.id].lane)
        waits[item.id] = `integration queue: fixing the target's baseline failures first (${formatFailures(known ?? [])})`;
  } else if (reservedBy) {
    for (const item of spec.items)
      if (next.items[item.id]?.state === "integrating" && !next.items[item.id].lane)
        waits[item.id] = `integration worktree busy: ${reservedBy}`;
  } else if (!spec.items.some((item) => next.items[item.id]?.state === "integrating" && next.items[item.id].lane)) {
    const head = spec.items.find(
      (item) =>
        next.items[item.id]?.state === "integrating" &&
        item.dependsOn.every((dependency) => INTEGRATED.has(next.items[dependency]?.state)),
    );
    if (head) actions.push({ kind: "integrate", itemId: head.id, attempt: next.items[head.id].attempts ?? 1 });
    for (const item of spec.items)
      if (next.items[item.id]?.state === "integrating" && item.id !== head?.id)
        waits[item.id] = head ? `integration queue: after ${head.id}` : "integration queue: waits on a dependency's integration";
  } else
    for (const item of spec.items)
      if (next.items[item.id]?.state === "integrating" && !next.items[item.id].lane) waits[item.id] = "integration queue: one merge at a time";

  // 1d. The push gate: a person pushes; ask once per round (or per item).
  const awaiting = spec.items
    .filter((item) => next.items[item.id]?.state === "awaiting-push")
    .sort((a, b) => (next.items[a.id].integration?.order ?? 0) - (next.items[b.id].integration?.order ?? 0));
  // Known baseline failures the push carries (the target already fails them).
  const knownAt = (items) => {
    const failures = [];
    for (const item of items)
      for (const failure of next.items[item.id].integration?.baselineFailures ?? [])
        if (!failures.some((other) => other.package === failure.package && other.task === failure.task)) failures.push(failure);
    return failures.length ? { baselineFailures: failures } : {};
  };
  if (awaiting.length) {
    if (spec.defaults.pushGate === "item") {
      for (const item of awaiting)
        if (!next.items[item.id].pushAskedAt) {
          next.items[item.id].pushAskedAt = now;
          rootAsks.push({ itemId: item.id, kind: "push", items: [item.id], sha: next.items[item.id].integration.sha, reason: `push ${item.id}`, ...knownAt([item]) });
        }
    } else {
      // Push what is ready, without waiting for the rest of the queue: the
      // push goes to the last ready item's integration commit, so items still
      // integrating (or stuck) never ride along or hold the others back.
      const head = next.items[awaiting.at(-1).id].integration.sha;
      if (next.pushGate?.askedSha !== head) {
        next.pushGate = { askedSha: head, items: awaiting.map((item) => item.id), at: now };
        rootAsks.push({ itemId: awaiting.at(-1).id, kind: "push", items: awaiting.map((item) => item.id), sha: head, reason: `push round of ${awaiting.length}`, ...knownAt(awaiting) });
      }
    }
  }

  // 1d2. Verification: once the preview reports a release containing the
  // item's commit, a verify lane runs its preview specs and writes the final
  // report. Items with nothing to verify on the preview skip the lane.
  // A verify lane that records an evidence report runs the app locally (a
  // dev stack: ports, a database); two at once collide, so they take turns.
  const devStacks = spec.defaults.maxDevStacks ?? 1;
  // A demo of the preview needs no local stack: those lanes run in parallel.
  const runsDevStack = (item) => Boolean(item.acceptance.evidence) && !demoOnPreview(spec, item);
  const onDevStack = spec.items.filter((item) => runsDevStack(item) && next.items[item.id]?.state === "verifying" && next.items[item.id]?.lane).map((item) => item.id);

  // 1d1. The demo runner (defaults.demoRunner): one lane runs the demos of
  // every verifying item that needs only its demo, one at a time, on one
  // long-lived local dev stack at the target tip (it contains every pushed
  // item), resetting the seed between items. Each report is picked up and
  // verified as soon as it is written (the controller watches the files);
  // the run's receipt only ends the run.
  const runner = spec.defaults.demoRunner;
  const demoOnly = (item, current) =>
    Boolean(runner) &&
    current?.state === "verifying" &&
    !current.lane &&
    !current.verified &&
    Boolean(item.acceptance.evidence) &&
    !demoOnPreview(spec, item) &&
    !item.acceptance.preview.length &&
    !untestedAtIntegration(item, current).length;
  if (runner && next.demoRun?.lane) {
    const run = next.demoRun;
    const view = lane(run.lane);
    const idle = view && (view.agentStatus === "done" || view.agentStatus === "gone") && !background.has(`${run.lane.workflowId}/${run.lane.laneId}`);
    // A lane not in the manifest yet is starting; one missing for 30 min is gone.
    const missing = !view && Date.parse(now) - Date.parse(run.requestedAt ?? now) > 30 * 60_000;
    const ended = missing || (view && (LANE_ENDED.has(view.status ?? "") || view.workflowStatus === "dispatch-failed"));
    const overdue = idle && run.askedAt && Date.parse(now) - Date.parse(run.askedAt) > RECEIPT_ASK_TIMEOUT_MS;
    if (view?.receipt || ended || overdue) {
      const result = demoRunResult(view?.receipt?.summary);
      const neverStarted = view?.status === "dispatch-failed" || view?.workflowStatus === "dispatch-failed";
      for (const id of run.items) {
        const current = next.items[id];
        const line = result.items.get(id);
        if (current?.state !== "verifying" || current.verified || current.evidence) continue;
        // Written at the end of the run: the controller picks it up this
        // pass; it joins no new run meanwhile.
        if (line?.result === "written") current.evidenceRetryAfter = new Date(Date.parse(now) + 10 * 60_000).toISOString();
        else if (line?.result === "blocked" || (!line && !result.stackBlocked && !neverStarted)) {
          current.evidenceProblem = line?.reason ? `the demo run could not do it: ${line.reason}` : "the demo run ended without writing its report";
          current.evidenceRetryAfter = new Date(Date.parse(now) + 10 * 60_000).toISOString();
        }
        (current.history ??= []).push({ at: now, from: current.state, to: current.state, note: `demo run ${run.lane.workflowId} ended: ${line ? `${line.result}${line.reason ? ` (${line.reason.slice(0, 120)})` : ""}` : result.stackBlocked ? `the stack could not start (${result.stackBlocked.slice(0, 120)})` : "no DEMO line for it"}` });
      }
      // A stack that never came up, or a lane that never started, is
      // infrastructure: the whole run is retried after a backoff.
      if (result.stackBlocked || neverStarted) {
        next.demoRunInfraFailures = (next.demoRunInfraFailures ?? 0) + 1;
        next.demoRunRetryAfter = new Date(Date.parse(now) + infraBackoffMs(next.demoRunInfraFailures)).toISOString();
      } else delete next.demoRunInfraFailures;
      delete next.demoRun;
    } else if (idle && !run.askedAt) {
      run.askedAt = now;
      actions.push({ kind: "ask-demo-receipt", itemId: "", attempt: 1, lane: run.lane });
    }
  }
  if (runner) {
    if (next.demoRun) {
      for (const id of next.demoRun.items)
        if (next.items[id]?.state === "verifying" && !next.items[id].verified) waits[id] = `demo run: ${next.demoRun.lane ? `lane ${next.demoRun.lane.workflowId} is running its demo` : "starting"}`;
    } else {
      const backoff = typeof next.demoRunRetryAfter === "string" && Date.parse(now) < Date.parse(next.demoRunRetryAfter);
      const ready = spec.items.filter((item) => {
        const current = next.items[item.id];
        return demoOnly(item, current) && !(typeof current.evidenceRetryAfter === "string" && Date.parse(now) < Date.parse(current.evidenceRetryAfter));
      });
      const batch = ready.slice(0, runner.maxItems ?? 12);
      if (batch.length && !backoff && !capacityWaiting && targetSha && onDevStack.length < devStacks) {
        next.demoRun = { items: batch.map((item) => item.id), sha: targetSha, requestedAt: now };
        for (const item of batch) {
          next.items[item.id].demoRun = { sha: targetSha, requestedAt: now };
          waits[item.id] = "demo run: starting";
        }
      } else
        for (const item of ready)
          waits[item.id] = backoff
            ? `demo run: a fresh run after ${next.demoRunRetryAfter}`
            : onDevStack.length >= devStacks
              ? `demo run: dev stack busy (${onDevStack.join(", ")})`
              : "demo run: waiting to start";
    }
    if (next.demoRun && !next.demoRun.lane) {
      delete next.demoRun.retryAfter;
      actions.push({ kind: "demo-run", itemId: "", attempt: 1, items: next.demoRun.items, targetSha: next.demoRun.sha });
    }
    if (next.demoRun) onDevStack.push("the demo run");
  }

  for (const item of spec.items) {
    const current = next.items[item.id];
    if (current?.state !== "verifying" || current.lane) continue;
    // The demo runner does these.
    if (demoOnly(item, current)) {
      waits[item.id] ??= "demo run: waiting for the next run";
      continue;
    }
    // Tests with no run recorded at the integrated commit (a batch-merged
    // item has none): a verify lane runs them there, rather than the item
    // waiting on a recording nothing will make.
    const untested = untestedAtIntegration(item, current);
    const testsOnly = Boolean(current.verified) && untested.length > 0;
    if (current.verified && !testsOnly) continue;
    // A demo lane after an evidence failure waits out its backoff.
    if (typeof current.evidenceRetryAfter === "string" && Date.parse(now) < Date.parse(current.evidenceRetryAfter)) {
      waits[item.id] = `evidence: a demo lane after ${current.evidenceRetryAfter}`;
      continue;
    }
    const needsLane = testsOnly || untested.length > 0 || item.acceptance.preview.length > 0 || Boolean(item.acceptance.evidence);
    if (!needsLane) {
      current.verified = now;
      continue;
    }
    if (!testsOnly && item.acceptance.preview.length && spec.target.preview) {
      const releaseSha = released.get(item.id);
      if (!releaseSha) {
        waits[item.id] = "preview: the release check does not report a deploy containing this commit yet";
        continue;
      }
      current.releaseSha = releaseSha;
    }
    if (runsDevStack(item) && onDevStack.length >= devStacks) {
      waits[item.id] = `dev stack busy: ${onDevStack.join(", ")} verifying on it (at most ${devStacks} at a time)`;
      continue;
    }
    if (runsDevStack(item)) onDevStack.push(item.id);
    if (testsOnly) current.verifyTestsOnly = true;
    else delete current.verifyTestsOnly;
    actions.push({ kind: "verify", itemId: item.id, attempt: 1, ...(untested.length ? { tests: untested } : {}), ...(testsOnly ? { testsOnly: true } : {}) });
  }

  // 1e. The decide stage (when configured) runs before an item can build,
  // and its leftover questions go to the user in one batched round.
  const decideStage = Boolean(spec.stages.decide);
  if (decideStage) {
    const deciding = () => spec.items.filter((item) => next.items[item.id]?.state === "deciding").length;
    for (const item of spec.items) {
      const current = record(item.id);
      if (current.state === "deciding" && !current.lane) actions.push({ kind: "decide", itemId: item.id, attempt: 1 });
      else if (current.state === "pending" && !current.decided && deciding() < spec.defaults.maxParallel) {
        move(item.id, "deciding", {}, "decide");
        actions.push({ kind: "decide", itemId: item.id, attempt: 1 });
      }
    }
    const unasked = spec.items.filter(
      (item) => next.items[item.id]?.state === "blocked" && next.items[item.id].blockedReason === "decision" && !next.items[item.id].questionsAskedAt,
    );
    if (unasked.length && !deciding()) {
      for (const item of unasked) next.items[item.id].questionsAskedAt = now;
      rootAsks.push({
        itemId: unasked[0].id,
        kind: "decisions",
        items: unasked.map((item) => item.id),
        questions: unasked.flatMap((item) => next.items[item.id].questions.map((question) => `${item.id}: ${question}`)),
        reason: `decision round: ${unasked.length} item(s)`,
      });
    }
  }

  // 2. Readiness from dependencies.
  for (const item of spec.items) {
    const current = record(item.id);
    if (current.state !== "pending" && current.state !== "ready") continue;
    if (decideStage && !current.decided) {
      waits[item.id] = "decide: waits for the decide stage";
      continue;
    }
    const waiting = item.dependsOn.filter((dependency) => !AFTER_INTEGRATION.has(next.items[dependency]?.state));
    if (waiting.length) {
      if (current.state === "ready") move(item.id, "pending", {}, `waits on ${waiting.join(", ")}`);
      waits[item.id] = `dependency: ${waiting.join(", ")}`;
    } else if (current.state === "pending") move(item.id, "ready", {}, "dependencies integrated");
  }

  // 3. Dispatch ready items within the slots, capacity and ownership rules.
  const byId = new Map(spec.items.map((item) => [item.id, item]));
  // A slot is held by a live lane. A building or reviewing item without one
  // is about to be retried (it takes a lane this pass), so it holds one too;
  // an item only queued for the serial integration lane, or waiting for a
  // deploy to verify, holds none.
  const inFlight = () =>
    spec.items.filter((item) => {
      const current = next.items[item.id];
      if (!ACTIVE_STATES.has(current?.state)) return false;
      // A lane that finished its turn without a receipt holds its slot for
      // at most one ask interval.
      if (current.lane && current.receiptAskedAt && Date.parse(now) - Date.parse(current.receiptAskedAt) > RECEIPT_ASK_INTERVAL_MS) return false;
      return Boolean(current.lane) || current.state === "building" || current.state === "reviewing";
    });
  // A review reuses its item's slot; only new builds need one.
  let slots = spec.defaults.maxParallel - inFlight().length;
  for (const item of spec.items) {
    const current = record(item.id);
    if (current.state !== "ready") continue;
    if (capacityWaiting) {
      waits[item.id] = `capacity: ${typeof capacityWaiting === "string" ? capacityWaiting : "the root is waiting on a capacity gate"}`;
      continue;
    }
    if (slots <= 0) {
      waits[item.id] = `capacity: ${spec.defaults.maxParallel} items already in flight (maxParallel)`;
      continue;
    }
    const builders = spec.items.filter((other) => other.id !== item.id && next.items[other.id]?.state === "building");
    const owns = (id) => next.items[id]?.decided?.owns ?? byId.get(id).owns;
    const clash = builders.find((other) => anyOverlap([...owns(item.id), ...item.sharedTouch], owns(other.id)));
    if (clash) {
      waits[item.id] = `ownership: overlaps ${clash.id}'s files`;
      continue;
    }
    const attempt = (current.attempts ?? 0) + 1;
    move(item.id, "building", { attempts: attempt, lane: undefined }, attempt > 1 ? `rebuild ${attempt}` : "build");
    actions.push({ kind: "build", itemId: item.id, attempt, ...(current.findings ? { findings: current.findings } : {}) });
    slots -= 1;
  }
  return { state: next, actions, rootAsks, waits, rollbacks };
}

/** The build lane's objective, generated from the spec item. */
export function buildObjective(spec, item, { branch, findings, decided, answers }) {
  return [
    `Implement spec item ${item.id}: ${item.title}`,
    `Acceptance: ${item.acceptance.text}`,
    decided?.summary ? `The decide stage recorded:\n${decided.summary}` : "",
    answers?.length ? `The user's answers to its open questions:\n${answers.map((answer) => answer.text).join("\n")}` : "",
    item.decisions.length ? `Read these decisions first; they are settled, do not re-ask them: ${item.decisions.join(", ")}.` : "",
    item.owns.length ? `You own: ${item.owns.join(", ")}.${item.sharedTouch.length ? ` Shared (edit minimally): ${item.sharedTouch.join(", ")}.` : ""}` : "",
    item.migrations ? `It needs ${item.migrations} migration(s); ask for the slot with herdr_request instead of picking a number.` : "",
    item.acceptance.tests.length ? `Run until green: ${item.acceptance.tests.join("; ")}.` : "",
    LONG_COMMANDS,
    item.acceptance.evidence ? demoRule(item.acceptance.evidence.report, item.acceptance.evidence.minImages) : "",
    "Before you report done, run the repository's lint and typecheck on the files you changed (the checks its commit hooks run: lint-staged, eslint, tsc) and fix every error, so the commit passes its hooks.",
    `Commit your work on ${branch} in this worktree (local commits only), with the hooks (never --no-verify).`,
    findings ? `The previous attempt did not pass. Findings to address:\n${findings}` : "",
    "Finish with herdr_complete: the commit SHA, the checks you ran and their results, and the evidence report path.",
  ].filter(Boolean).join("\n");
}

/** The review lane's objective: read-only, verdict first. */
/** The decide lane's objective: settle what the linked decisions settle, list the rest. */
export function decideObjective(spec, item) {
  return [
    `Prepare spec item ${item.id}: ${item.title}. Read-only: do not edit files or Git state.`,
    `Acceptance: ${item.acceptance.text}`,
    item.decisions.length ? `Read these decisions and notes: ${item.decisions.join(", ")}.` : "",
    item.owns.length ? `Proposed ownership: ${item.owns.join(", ")}.` : "",
    "Answer every design question the decisions, notes and scope rules already settle. List only what a person still has to decide.",
    "Finish with herdr_complete. In the summary, put each open question on its own line starting QUESTION:, the files the build will own on a line OWNS: glob, glob (if different from the proposal), and MIGRATIONS: <n> if the item needs migrations. No QUESTION: lines means it is ready to build.",
  ].filter(Boolean).join("\n");
}

/** The verify lane's objective: preview specs against the deployed release, then the final report. */
export function verifyObjective(spec, item, { worktree, releaseSha, reportPath, evidenceProblem, tests = [], testsOnly = false }) {
  const prepare = spec.target.suite.filter((command) => /\b(?:install|build|generate|codegen)\b/.test(command) && !/\btest\b/.test(command));
  const testLines = tests.length
    ? [
        `Run the item's tests at this commit (the item's integrated commit; nothing else records them): ${tests.join("; ")}. Stay on this commit: never check out another one, since the results are recorded here.`,
        prepare.length ? `Prepare the checkout first as the integration suite does: ${prepare.join("; ")}. A test that fails only because the checkout was not built or generated is not a result.` : "",
        LANE_DATABASE_RULE,
        "Report each on its own line, TEST: <command> pass or TEST: <command> fail, and quote the failing test names and errors under it; if a test could not run at all (no database, a service down), TEST: <command> blocked and why.",
      ].filter(Boolean).join(" ")
    : "";
  if (testsOnly)
    return [
      `Record the tests of spec item ${item.id}: ${item.title}, at its integrated commit. Everything else about the item is already verified.`,
      worktree ? `Your worktree is ${worktree} (a detached checkout of that commit), and you start in it: run every command from it with relative paths.` : "",
      testLines,
      LONG_COMMANDS,
      "Do not change code or Git state; this stage only runs the tests.",
      "Finish with herdr_complete: the TEST: lines, then the failing output for any fail.",
    ].filter(Boolean).join("\n");
  return [
    `Verify spec item ${item.id}: ${item.title}, now pushed to ${spec.target.remote}/${spec.target.branch}${releaseSha ? ` and deployed (release ${releaseSha})` : ""}.`,
    evidenceProblem
      ? `The last run's demo evidence failed the check: ${evidenceProblem}. Producing that evidence is this lane's main job: run the feature in the browser, capture a captioned screenshot for every navigation or action with demo-report.mjs, and write the .docx and its steps manifest at ${reportPath || "the configured report path"}.`
      : "",
    worktree
      ? `Your worktree is ${worktree} (a detached checkout of the pushed commit), and you start in it: run every command from it with relative paths, never cd into a retyped absolute path.`
      : "",
    item.acceptance.evidence
      ? demoOnPreview(spec, item)
        ? "This demo runs against the preview, not a local stack: do not start the app locally (other lanes run at the same time)."
        : "If you start the app locally, you are the only lane running a dev stack now (the driver serializes them); stop it before you finish."
      : "",
    item.acceptance.preview.length && spec.target.preview
      ? `Run these browser specs against the preview at ${spec.target.preview.url}: ${item.acceptance.preview.join(", ")}.`
      : "",
    `Acceptance: ${item.acceptance.text}`,
    item.acceptance.evidence
      ? `${demoRule(reportPath, item.acceptance.evidence.minImages, demoOnPreview(spec, item) ? { health: previewHealthUrl(spec), wakePattern: spec.target.preview?.wakePattern } : undefined)} Run it against the preview.`
      : "",
    testLines,
    "Do not change code or Git state; this stage only verifies.",
    `Finish with herdr_complete. In the summary, put one line per spec, PREVIEW: <spec path> pass or PREVIEW: <spec path> fail, ${tests.length ? "one TEST: line per test, " : ""}and REPORT: <path of the report you wrote>. If the app or its services could not be started at all, write PREVIEW: <spec path> blocked and say why: that is retried as infrastructure, not recorded as a failure.`,
  ].filter(Boolean).join("\n");
}

/** The integration lane's objective: merge locally, renumber, run the suite, never push. */
export function integrateObjective(spec, item, { integrationBranch, itemBranch, commitFirst, baseline }) {
  return [
    `Integrate spec item ${item.id}: ${item.title}.`,
    commitFirst?.paths.length
      ? `First commit the item's uncommitted work in ${commitFirst.worktree} on ${itemBranch}, staging exactly these paths and nothing else (never git add -A or .): git -C ${commitFirst.worktree} add -- ${commitFirst.paths.map((path) => JSON.stringify(path)).join(" ")} && git -C ${commitFirst.worktree} commit -m "${specCommitMessage(item.id, "commit work before integration")}". Let the repository's hooks run; if one fails, report its output.`
      : "",
    commitFirst?.untracked?.length
      ? `Leave these untracked files where they are, uncommitted (they are not part of the item): ${commitFirst.untracked.slice(0, 20).join(", ")}${commitFirst.untracked.length > 20 ? ", and more" : ""}.`
      : "",
    commitFirst?.secrets.length
      ? `Leave these uncommitted; they look like secrets and must never be staged: ${commitFirst.secrets.join(", ")}.`
      : "",
    `This worktree is on ${integrationBranch}: the target tip plus the items already integrated. Merge ${itemBranch} into it (git merge --no-ff -m "${specCommitMessage(item.id, "integrate")}" ${itemBranch}) and resolve any conflicts.`,
    item.migrations
      ? `The item adds ${item.migrations} migration(s). If a number collides with one already on ${integrationBranch}, renumber the item's migrations to the next free numbers in order and update every reference. A migration journal that orders by time (drizzle's meta/_journal.json "when", and tools like it) must stay increasing: give each renumbered entry a timestamp later than every entry before it, or migrators skip it silently on any database that already has the newer one.`
      : "",
    spec.target.suite.length ? `Run the full suite: ${spec.target.suite.join("; ")}.` : "",
    spec.target.suite.length || item.acceptance.tests.length ? LANE_DATABASE_RULE : "",
    LONG_COMMANDS,
    spec.target.suite.length ? baselineNote(baseline?.failures, baseline?.sha ?? "") : "",
    item.acceptance.tests.length ? `Run the item's tests: ${item.acceptance.tests.join("; ")}.` : "",
    `Commit the result on ${integrationBranch} with conventional headers of 72 characters or fewer (for example ${specCommitMessage(item.id, "renumber migrations")}); the repository's commit hooks run and must pass. Local only: never push, and never touch any other branch.`,
    `Before you commit, run git status: every file you changed to resolve the merge must be staged, not only the ones that had conflict markers, and generated files your builds rewrote (openapi specs, API clients) go back with git restore --worktree -- <file> unless the merge needs them.`,
    `Never leave ${integrationBranch} half-merged or staged: if you stop before committing (a conflict you cannot resolve, a failing hook, a decline), run git merge --abort (or git reset --merge) so the worktree is clean for the next lane. If that refuses ("not uptodate": a build or codegen rewrote a file after you staged it), save git diff --binary HEAD to a patch file outside the repository, run git restore --worktree -- <each file it names>, and abort again.`,
    "Never use git stash (it is shared by every worktree of the repository); set changes aside with a patch file outside the repository or a throwaway commit on your own branch.",
    "Finish with herdr_complete. The summary starts with two lines, INTEGRATED: <full 40-character SHA of the resulting commit> and SUITE: pass or SUITE: fail, then the FAILED lines, what you changed and the suite output for a failure.",
  ].filter(Boolean).join("\n");
}

export function reviewObjective(spec, item, { branch, buildSummary }) {
  return [
    `Review spec item ${item.id}: ${item.title}. Read-only: do not edit files or Git state.`,
    `Diff: git diff ${spec.target.remote}/${spec.target.branch}...${branch}`,
    `Acceptance: ${item.acceptance.text}`,
    item.acceptance.tests.length ? `Its tests: ${item.acceptance.tests.join("; ")}.` : "",
    item.acceptance.evidence
      ? "Do not judge the demo evidence or runtime proof that needs a running stack: the verify stage produces the demo report after integration, and a deterministic check verifies it. Judge the code, its tests and the acceptance logic; a missing, stale or pre-fix demo is never a reason to fail this review."
      : "",
    buildSummary ? `The builder reported:\n${buildSummary}` : "",
    "Finish with herdr_complete. The summary's first line must be exactly VERDICT: PASS or VERDICT: FAIL, followed by the findings (file:line and what is wrong) for a FAIL.",
  ].filter(Boolean).join("\n");
}
