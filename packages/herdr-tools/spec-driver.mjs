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

/** States that hold a lane (and a maxParallel slot). */
export const ACTIVE_STATES = new Set(["building", "reviewing", "integrating", "verifying"]);
const AFTER_INTEGRATION = new Set(["integrating", "awaiting-push", "verifying", "done"]);
const INTEGRATED = new Set(["awaiting-push", "verifying", "done"]);
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
 * @param {string} input.now        ISO timestamp
 * @returns {{ state: object, actions: Array<{kind: "build"|"review", itemId: string, attempt: number, findings?: string}>, rootAsks: Array<{itemId: string, reason: string}>, waits: Record<string, string> }}
 */
export function advanceSpec({ spec, state, lane, capacityWaiting = false, pushed = new Set(), now }) {
  const next = structuredClone(state ?? { version: 1, items: {} });
  next.items ??= {};
  const actions = [];
  const rootAsks = [];
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

  // 1. Receipts and lane endings advance in-flight items.
  for (const item of spec.items) {
    const current = record(item.id);
    if (current.state === "integrating") {
      const view = current.lane ? lane(current.lane) : undefined;
      if (!view) continue;
      if (view.receipt) {
        const result = integrationResult(view.receipt.summary);
        if (result.sha && result.suite === "pass") {
          next.integrationCounter = (next.integrationCounter ?? 0) + 1;
          move(
            item.id,
            "awaiting-push",
            {
              integrateLane: current.lane,
              lane: undefined,
              integration: { sha: result.sha, order: next.integrationCounter, at: now },
              tests: [
                ...(Array.isArray(current.tests) ? current.tests : []),
                ...item.acceptance.tests.map((command) => ({ command, sha: result.sha, result: "pass", at: now, by: "integrate" })),
              ],
            },
            "integrated",
          );
        } else if (result.suite === "fail") {
          const attempts = current.attempts ?? 1;
          const findings = `Integration onto spec-integration failed its suite. Rebase spec/${item.id} onto spec-integration and fix:\n${view.receipt.summary}`;
          if (attempts >= spec.defaults.maxBuildAttempts) {
            move(item.id, "failed", { findings, lane: undefined }, "integration suite failed");
            rootAsks.push({ itemId: item.id, reason: `${item.id} failed integration after ${attempts} build attempt(s)` });
          } else move(item.id, "ready", { findings, lane: undefined }, "integration suite failed");
        } else {
          move(item.id, "blocked", { blockedReason: "human-gate", lane: undefined, note: "integration receipt has no INTEGRATED: <sha> and SUITE: pass|fail lines" });
          rootAsks.push({ itemId: item.id, reason: `${item.id}: the integration receipt is unclear; check spec-integration and set the outcome` });
        }
      } else if (LANE_ENDED.has(view.status)) {
        // The merge is retried by a fresh integration lane; it is not a build attempt.
        delete current.lane;
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
        move(item.id, "blocked", { blockedReason: "human-gate", note: "review receipt has no VERDICT: PASS or VERDICT: FAIL line" });
        rootAsks.push({ itemId: item.id, reason: `${item.id}: the review receipt has no verdict; read it and set the outcome` });
      }
    } else if (view && LANE_ENDED.has(view.status))
      failAttempt(`${current.state === "building" ? "build" : "review"} lane ended (${view.status}) without a receipt`);
    // A stage whose dispatch never produced a lane is retried.
    else if (!current.lane)
      actions.push({ kind: current.state === "building" ? "build" : "review", itemId: item.id, attempt: attempts, ...(current.findings ? { findings: current.findings } : {}) });
  }

  // 1b. Pushed integrations move on to verification.
  for (const item of spec.items) {
    const current = record(item.id);
    if (current.state === "awaiting-push" && current.integration?.sha && pushed.has(current.integration.sha))
      move(item.id, "verifying", { integratedSha: current.integration.sha }, "pushed to the target branch");
  }

  // 1c. One serial integration queue, in dependency order.
  if (!spec.items.some((item) => next.items[item.id]?.state === "integrating" && next.items[item.id].lane)) {
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
  if (awaiting.length) {
    if (spec.defaults.pushGate === "item") {
      for (const item of awaiting)
        if (!next.items[item.id].pushAskedAt) {
          next.items[item.id].pushAskedAt = now;
          rootAsks.push({ itemId: item.id, kind: "push", items: [item.id], sha: next.items[item.id].integration.sha, reason: `push ${item.id}` });
        }
    } else if (!spec.items.some((item) => next.items[item.id]?.state === "integrating")) {
      const head = next.items[awaiting.at(-1).id].integration.sha;
      if (next.pushGate?.askedSha !== head) {
        next.pushGate = { askedSha: head, items: awaiting.map((item) => item.id), at: now };
        rootAsks.push({ itemId: awaiting.at(-1).id, kind: "push", items: awaiting.map((item) => item.id), sha: head, reason: `push round of ${awaiting.length}` });
      }
    }
  }

  // 2. Readiness from dependencies.
  for (const item of spec.items) {
    const current = record(item.id);
    if (current.state !== "pending" && current.state !== "ready") continue;
    const waiting = item.dependsOn.filter((dependency) => !AFTER_INTEGRATION.has(next.items[dependency]?.state));
    if (waiting.length) {
      if (current.state === "ready") move(item.id, "pending", {}, `waits on ${waiting.join(", ")}`);
      waits[item.id] = `dependency: ${waiting.join(", ")}`;
    } else if (current.state === "pending") move(item.id, "ready", {}, "dependencies integrated");
  }

  // 3. Dispatch ready items within the slots, capacity and ownership rules.
  const byId = new Map(spec.items.map((item) => [item.id, item]));
  const inFlight = () => spec.items.filter((item) => ACTIVE_STATES.has(next.items[item.id]?.state));
  // A review reuses its item's slot; only new builds need one.
  let slots = spec.defaults.maxParallel - inFlight().length;
  for (const item of spec.items) {
    const current = record(item.id);
    if (current.state !== "ready") continue;
    if (capacityWaiting) {
      waits[item.id] = "capacity: the root is waiting on a capacity gate";
      continue;
    }
    if (slots <= 0) {
      waits[item.id] = `capacity: ${spec.defaults.maxParallel} items already in flight (maxParallel)`;
      continue;
    }
    const builders = spec.items.filter((other) => other.id !== item.id && next.items[other.id]?.state === "building");
    const clash = builders.find((other) => anyOverlap([...item.owns, ...item.sharedTouch], byId.get(other.id).owns));
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
export function buildObjective(spec, item, { branch, findings }) {
  return [
    `Implement spec item ${item.id}: ${item.title}`,
    `Acceptance: ${item.acceptance.text}`,
    item.decisions.length ? `Read these decisions first; they are settled, do not re-ask them: ${item.decisions.join(", ")}.` : "",
    item.owns.length ? `You own: ${item.owns.join(", ")}.${item.sharedTouch.length ? ` Shared (edit minimally): ${item.sharedTouch.join(", ")}.` : ""}` : "",
    item.migrations ? `It needs ${item.migrations} migration(s); ask for the slot with herdr_request instead of picking a number.` : "",
    item.acceptance.tests.length ? `Run until green: ${item.acceptance.tests.join("; ")}.` : "",
    item.acceptance.evidence ? `Write the evidence report ${item.acceptance.evidence.report} with at least ${item.acceptance.evidence.minImages} screenshots.` : "",
    `Commit your work on ${branch} in this worktree (local commits only).`,
    findings ? `The previous attempt failed review. Findings to address:\n${findings}` : "",
    "Finish with herdr_complete: the commit SHA, the checks you ran and their results, and the evidence report path.",
  ].filter(Boolean).join("\n");
}

/** The review lane's objective: read-only, verdict first. */
/** The integration lane's objective: merge locally, renumber, run the suite, never push. */
export function integrateObjective(spec, item, { integrationBranch, itemBranch }) {
  return [
    `Integrate spec item ${item.id}: ${item.title}.`,
    `This worktree is on ${integrationBranch}: the target tip plus the items already integrated. Merge ${itemBranch} into it (git merge --no-ff ${itemBranch}) and resolve any conflicts.`,
    item.migrations
      ? `The item adds ${item.migrations} migration(s). If a number collides with one already on ${integrationBranch}, renumber the item's migrations to the next free numbers in order and update every reference.`
      : "",
    spec.target.suite.length ? `Run the full suite: ${spec.target.suite.join("; ")}.` : "",
    item.acceptance.tests.length ? `Run the item's tests: ${item.acceptance.tests.join("; ")}.` : "",
    `Commit the result on ${integrationBranch}. Local only: never push, and never touch any other branch.`,
    "Finish with herdr_complete. The summary starts with two lines, INTEGRATED: <full 40-character SHA of the resulting commit> and SUITE: pass or SUITE: fail, then what you changed and the suite output for a failure.",
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
