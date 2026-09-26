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
import { BASELINES_KEPT, baselineNote, baselineResult, compareToBaseline, formatFailures, knownFailures, suiteFailures } from "./spec-baseline.mjs";

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

/** Parse a verify lane's receipt: PREVIEW: <spec> pass|fail and REPORT: <path> lines. */
export function verifyResult(summary) {
  const lines = String(summary ?? "").split("\n");
  const previews = lines
    .map((line) => /^\s*PREVIEW\s*:\s*(\S+)\s+(pass|fail)\b/i.exec(line))
    .filter(Boolean)
    .map((match) => ({ spec: match[1], result: match[2].toLowerCase() }));
  const report = lines.map((line) => /^\s*REPORT\s*:\s*(\S+)\s*$/i.exec(line)?.[1]).find(Boolean);
  return { previews, ...(report ? { report } : {}) };
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
  const actions = [];
  const rootAsks = [];
  const reclaimed = [];
  const waits = {};
  const record = (id) => (next.items[id] ??= { state: "pending" });
  const move = (id, to, extra = {}, note) => {
    const item = record(id);
    const from = item.state ?? "pending";
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

  // A. Items an older driver held at the human gate for a mechanical reason
  // (an idle lane, an unclear receipt) go back on the retry ladder.
  for (const item of spec.items) {
    const current = next.items[item.id];
    if (current?.state !== "blocked" || current.blockedReason !== "human-gate" || current.blockedCause) continue;
    const idle = /^(decide|build|review|integrate|verify) lane is idle without a receipt, even after being asked$/.exec(current.note ?? "")?.[1];
    const unclear = /^integration receipt has no INTEGRATED/.test(current.note ?? "") ? "integrate" : /^review receipt has no VERDICT/.test(current.note ?? "") ? "review" : undefined;
    const stage = idle ?? unclear;
    if (!stage) continue;
    delete current.blockedReason;
    retryStage(item, current, stage, idle ? "idle without a receipt" : "unclear receipt", current.note);
    delete current.note;
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
    } else if ((view.agentStatus === "done" || view.agentStatus === "idle") && background.has(`${current.lane.workflowId}/${current.lane.laneId}`)) {
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
        const runs = result.previews.map((run) => ({ ...run, sha: current.integratedSha, releaseSha: current.releaseSha, at: now }));
        const failed = runs.filter((run) => run.result !== "pass");
        const missing = item.acceptance.preview.filter((path) => !runs.some((run) => run.spec === path));
        current.preview = [...(Array.isArray(current.preview) ? current.preview : []), ...runs];
        current.verifyLane = current.lane;
        delete current.lane;
        if (result.report) current.finalReport = result.report;
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
    if (stage !== "integrate" && stage !== "verify") return false;
    if (view && CLOSED_WORKFLOW.has(view.workflowStatus ?? "")) return false;
    const idle = view && (view.agentStatus === "done" || view.agentStatus === "gone" || LANE_ENDED.has(view.status ?? ""));
    const waitingOnIt = STAGE_OF[current.state] === stage && !current.receiptEscalatedAt;
    const working = background.has(`${current.lane.workflowId}/${current.lane.laneId}`);
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
  if (useBaseline && next.baselineRun && !next.baselineRun.lane && !capacityWaiting)
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
  for (const item of spec.items) {
    const current = next.items[item.id];
    if (current?.state !== "verifying" || current.lane || current.verified) continue;
    const needsLane = item.acceptance.preview.length > 0 || Boolean(item.acceptance.evidence);
    if (!needsLane) {
      current.verified = now;
      continue;
    }
    if (reservedBy) {
      waits[item.id] = `integration worktree busy: ${reservedBy}`;
      continue;
    }
    if (item.acceptance.preview.length && spec.target.preview) {
      const releaseSha = released.get(item.id);
      if (!releaseSha) {
        waits[item.id] = "preview: the release check does not report a deploy containing this commit yet";
        continue;
      }
      current.releaseSha = releaseSha;
    }
    actions.push({ kind: "verify", itemId: item.id, attempt: 1 });
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
  return { state: next, actions, rootAsks, waits };
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
    item.acceptance.evidence ? `Write the evidence report ${item.acceptance.evidence.report} with at least ${item.acceptance.evidence.minImages} screenshots.` : "",
    `Commit your work on ${branch} in this worktree (local commits only).`,
    findings ? `The previous attempt failed review. Findings to address:\n${findings}` : "",
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
export function verifyObjective(spec, item, { releaseSha, reportPath }) {
  return [
    `Verify spec item ${item.id}: ${item.title}, now pushed to ${spec.target.remote}/${spec.target.branch}${releaseSha ? ` and deployed (release ${releaseSha})` : ""}.`,
    item.acceptance.preview.length && spec.target.preview
      ? `Run these browser specs against the preview at ${spec.target.preview.url}: ${item.acceptance.preview.join(", ")}.`
      : "",
    `Acceptance: ${item.acceptance.text}`,
    item.acceptance.evidence
      ? `Write the final evidence report at ${reportPath} in this worktree, with at least ${item.acceptance.evidence.minImages} screenshots from the preview run.`
      : "",
    "Do not change code or Git state; this stage only verifies.",
    "Finish with herdr_complete. In the summary, put one line per spec, PREVIEW: <spec path> pass or PREVIEW: <spec path> fail, and REPORT: <path of the report you wrote>.",
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
      ? `The item adds ${item.migrations} migration(s). If a number collides with one already on ${integrationBranch}, renumber the item's migrations to the next free numbers in order and update every reference.`
      : "",
    spec.target.suite.length ? `Run the full suite: ${spec.target.suite.join("; ")}.` : "",
    LONG_COMMANDS,
    spec.target.suite.length ? baselineNote(baseline?.failures, baseline?.sha ?? "") : "",
    item.acceptance.tests.length ? `Run the item's tests: ${item.acceptance.tests.join("; ")}.` : "",
    `Commit the result on ${integrationBranch} with conventional headers of 72 characters or fewer (for example ${specCommitMessage(item.id, "renumber migrations")}); the repository's commit hooks run and must pass. Local only: never push, and never touch any other branch.`,
    `Never leave ${integrationBranch} half-merged or staged: if you stop before committing (a conflict you cannot resolve, a failing hook, a decline), run git merge --abort (or git reset --merge) so the worktree is clean for the next lane.`,
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
    item.acceptance.evidence ? `Check the evidence report ${item.acceptance.evidence.report} (at least ${item.acceptance.evidence.minImages} images).` : "",
    buildSummary ? `The builder reported:\n${buildSummary}` : "",
    "Finish with herdr_complete. The summary's first line must be exactly VERDICT: PASS or VERDICT: FAIL, followed by the findings (file:line and what is wrong) for a FAIL.",
  ].filter(Boolean).join("\n");
}
