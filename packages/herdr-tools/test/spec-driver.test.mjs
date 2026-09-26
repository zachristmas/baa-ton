import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSpec } from "../spec.mjs";
import { advanceSpec, buildObjective, decideObjective, decideResult, globsOverlap, integrateObjective, integrationResult, reviewObjective, reviewVerdict, verifyObjective, verifyResult } from "../spec-driver.mjs";

const spec = (items, defaults = {}, stages, preview) =>
  validateSpec({
    version: 1,
    target: { repo: ".", remote: "origin", branch: "feature/release", ...(preview ? { preview } : {}) },
    defaults,
    ...(stages ? { stages } : {}),
    items: items.map(({ id, ...rest }) => ({ id, title: `Item ${id}`, acceptance: { text: `Accept ${id}.` }, ...rest })),
  });
const lanes = (views) => (ref) => views[`${ref.workflowId}/${ref.laneId}`];
const at = (minute) => `2026-09-24T10:${String(minute).padStart(2, "0")}:00.000Z`;

test("globs overlap conservatively by their static prefixes", () => {
  assert.equal(globsOverlap("src/orders/**", "src/orders/checkout/**"), true);
  assert.equal(globsOverlap("src/orders/**", "src/admin/**"), false);
  assert.equal(globsOverlap("src/a.ts", "src/a.ts"), true);
  assert.equal(globsOverlap("src/a.ts", "src/b.ts"), false);
  assert.equal(globsOverlap("**/*.ts", "src/x/**"), true, "no prefix overlaps everything");
  assert.equal(globsOverlap("src/ord*", "src/orders/x.ts"), true);
});

test("review verdicts are read from the first line only", () => {
  assert.equal(reviewVerdict("VERDICT: PASS\nall good"), "pass");
  assert.equal(reviewVerdict("  verdict: fail - a.ts:10 wrong total"), "fail");
  assert.equal(reviewVerdict("**VERDICT: PASS**"), "pass");
  assert.equal(reviewVerdict("Looks fine. VERDICT: PASS"), undefined);
  assert.equal(reviewVerdict(undefined), undefined);
});

test("dependencies gate readiness; maxParallel and ownership gate dispatch", () => {
  const s = spec(
    [
      { id: "A", owns: ["src/orders/**"] },
      { id: "B", owns: ["src/orders/checkout/**"] },
      { id: "C", dependsOn: ["A"] },
      { id: "D", owns: ["src/admin/**"] },
      { id: "E", owns: ["src/reports/**"] },
    ],
    { maxParallel: 2 },
  );
  const first = advanceSpec({ spec: s, state: undefined, lane: lanes({}), now: at(0) });
  assert.deepEqual(first.actions.map((action) => [action.kind, action.itemId, action.attempt]), [["build", "A", 1], ["build", "D", 1]]);
  assert.equal(first.waits.B, "ownership: overlaps A's files");
  assert.equal(first.waits.C, "dependency: A");
  assert.match(first.waits.E, /^capacity: 2 items already in flight/);
  assert.equal(first.state.items.A.state, "building");
  assert.deepEqual(first.state.items.A.history.map((entry) => entry.to), ["ready", "building"]);

  const gated = advanceSpec({ spec: s, state: undefined, lane: lanes({}), capacityWaiting: true, now: at(0) });
  assert.equal(gated.actions.length, 0, "a waiting capacity gate dispatches nothing");
  assert.match(gated.waits.A, /capacity gate/);
});

test("build receipt -> review; review PASS -> integrating; dependents become ready", () => {
  const s = spec([{ id: "A" }, { id: "C", dependsOn: ["A"] }]);
  let { state } = advanceSpec({ spec: s, state: undefined, lane: lanes({}), now: at(0) });
  state.items.A.lane = { workflowId: "herdr-b1", laneId: "lane-1" };
  let step = advanceSpec({ spec: s, state, lane: lanes({ "herdr-b1/lane-1": { status: "completion-reported", receipt: { summary: "Committed abc123; npm test green." } } }), now: at(5) });
  assert.deepEqual(step.actions, [{ kind: "review", itemId: "A", attempt: 1 }]);
  assert.equal(step.state.items.A.state, "reviewing");
  assert.deepEqual(step.state.items.A.buildLane, { workflowId: "herdr-b1", laneId: "lane-1" });
  assert.equal(step.state.items.C.state, "pending");

  state = step.state;
  state.items.A.lane = { workflowId: "herdr-r1", laneId: "lane-1" };
  step = advanceSpec({ spec: s, state, lane: lanes({ "herdr-r1/lane-1": { status: "completed", receipt: { summary: "VERDICT: PASS\nMatches acceptance." } } }), now: at(9) });
  assert.equal(step.state.items.A.state, "integrating");
  assert.equal(step.state.items.C.state, "building", "the dependent starts once A is integrating");
  assert.deepEqual(step.actions, [{ kind: "integrate", itemId: "A", attempt: 1 }, { kind: "build", itemId: "C", attempt: 1 }]);
});

test("review FAIL rebuilds with findings until maxBuildAttempts, then the root is asked", () => {
  const s = spec([{ id: "A" }], { maxBuildAttempts: 2 });
  const { state } = advanceSpec({ spec: s, state: undefined, lane: lanes({}), now: at(0) });
  const reviewFail = (attemptState, minute) => {
    attemptState.items.A.state = "reviewing";
    attemptState.items.A.lane = { workflowId: `herdr-r${minute}`, laneId: "lane-1" };
    return advanceSpec({
      spec: s,
      state: attemptState,
      lane: lanes({ [`herdr-r${minute}/lane-1`]: { status: "completed", receipt: { summary: "VERDICT: FAIL\nsrc/a.ts:10 total ignores shipping" } } }),
      now: at(minute),
    });
  };
  let step = reviewFail(state, 10);
  assert.equal(step.state.items.A.state, "building");
  assert.deepEqual(step.actions[0], { kind: "build", itemId: "A", attempt: 2, findings: "VERDICT: FAIL\nsrc/a.ts:10 total ignores shipping" });
  assert.match(buildObjective(s, s.items[0], { branch: "spec/A", findings: step.actions[0].findings }), /previous attempt failed review[\s\S]*total ignores shipping/);
  step = reviewFail(step.state, 20);
  assert.equal(step.state.items.A.state, "failed");
  assert.deepEqual(step.rootAsks, [{ itemId: "A", reason: "A failed 2 build attempt(s): review failed" }]);
  assert.equal(step.actions.length, 0);
});

test("a lane that ends without a receipt is a failed attempt; an unclear verdict gets a fresh review lane", () => {
  const s = spec([{ id: "A" }, { id: "B" }]);
  const state = {
    version: 1,
    items: {
      A: { state: "building", attempts: 1, lane: { workflowId: "w1", laneId: "l1" } },
      B: { state: "reviewing", attempts: 1, lane: { workflowId: "w2", laneId: "l1" } },
    },
  };
  const step = advanceSpec({
    spec: s,
    state,
    lane: lanes({ "w1/l1": { status: "operator-closed" }, "w2/l1": { status: "completed", receipt: { summary: "Looks mostly fine." } } }),
    now: at(3),
  });
  assert.equal(step.state.items.A.state, "building", "rebuilt as attempt 2");
  assert.equal(step.state.items.A.attempts, 2);
  assert.equal(step.state.items.B.state, "reviewing", "not held at the human gate");
  assert.equal(step.state.items.B.declined.kind, "unclear receipt");
  assert.ok(step.actions.some((action) => action.kind === "review" && action.itemId === "B"), "a fresh review lane");
  assert.equal(step.rootAsks.length, 0);
  assert.equal(state.items.A.state, "building", "the input state is not mutated");
});

test("a stage whose dispatch left no lane is retried; objectives carry the spec's facts", () => {
  const s = spec([{ id: "A", owns: ["src/a/**"], decisions: ["board:A"], migrations: 1, acceptance: { text: "Totals exclude tax.", tests: ["npm test"], evidence: { report: "artifacts/a.docx", minImages: 3 } } }]);
  const step = advanceSpec({ spec: s, state: { version: 1, items: { A: { state: "reviewing", attempts: 1 } } }, lane: lanes({}), now: at(1) });
  assert.deepEqual(step.actions, [{ kind: "review", itemId: "A", attempt: 1 }]);
  const build = buildObjective(s, s.items[0], { branch: "spec/A" });
  for (const fragment of ["Implement spec item A", "Totals exclude tax.", "board:A", "src/a/**", "herdr_request", "npm test", "artifacts/a.docx with at least 3", "on spec/A", "herdr_complete"])
    assert.ok(build.includes(fragment), fragment);
  const review = reviewObjective(s, s.items[0], { branch: "spec/A", buildSummary: "Committed abc." });
  assert.match(review, /Read-only/);
  assert.match(review, /git diff origin\/feature\/release\.\.\.spec\/A/);
  assert.match(review, /first line must be exactly VERDICT: PASS or VERDICT: FAIL/);
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

test("integration receipts are parsed from their INTEGRATED and SUITE lines", () => {
  assert.deepEqual(integrationResult(`INTEGRATED: ${SHA_A}\nSUITE: pass\nmerged cleanly`), { sha: SHA_A, suite: "pass" });
  assert.deepEqual(integrationResult("SUITE: FAIL\n3 tests failed"), { sha: undefined, suite: "fail" });
  assert.deepEqual(integrationResult("INTEGRATED: abc\nSUITE: pass"), { sha: undefined, suite: "pass" }, "a short SHA is not accepted");
});

test("one serial integration queue in dependency order, then one push prompt per round", () => {
  const s = spec([{ id: "A", acceptance: { text: "a", tests: ["npm test"] } }, { id: "B", dependsOn: ["A"] }, { id: "C" }]);
  const state = { version: 1, items: { A: { state: "integrating", attempts: 1 }, B: { state: "integrating", attempts: 1 }, C: { state: "integrating", attempts: 1 } } };
  let step = advanceSpec({ spec: s, state, lane: lanes({}), now: at(0) });
  assert.deepEqual(step.actions, [{ kind: "integrate", itemId: "A", attempt: 1 }]);
  assert.equal(step.waits.B, "integration queue: after A");
  assert.equal(step.waits.C, "integration queue: after A");

  // A merges; B (which depends on A) is next, C after it; no push prompt while the queue runs.
  step.state.items.A.lane = { workflowId: "wi1", laneId: "l1" };
  step = advanceSpec({ spec: s, state: step.state, lane: lanes({ "wi1/l1": { status: "completed", receipt: { summary: `INTEGRATED: ${SHA_A}\nSUITE: pass` } } }), now: at(1) });
  assert.equal(step.state.items.A.state, "awaiting-push");
  assert.deepEqual(step.state.items.A.integration, { sha: SHA_A, order: 1, at: at(1) });
  assert.deepEqual(step.state.items.A.tests, [{ command: "npm test", sha: SHA_A, result: "pass", at: at(1), by: "integrate" }]);
  assert.deepEqual(step.actions, [{ kind: "integrate", itemId: "B", attempt: 1 }]);
  assert.equal(step.rootAsks.length, 0, "the round is still running");

  step.state.items.B.lane = { workflowId: "wi2", laneId: "l1" };
  step.state.items.C.state = "failed";
  step = advanceSpec({ spec: s, state: step.state, lane: lanes({ "wi2/l1": { status: "completed", receipt: { summary: `INTEGRATED: ${SHA_B}\nSUITE: pass` } } }), now: at(2) });
  assert.deepEqual(step.rootAsks, [{ itemId: "B", kind: "push", items: ["A", "B"], sha: SHA_B, reason: "push round of 2" }]);
  const again = advanceSpec({ spec: s, state: step.state, lane: lanes({}), now: at(3) });
  assert.equal(again.rootAsks.length, 0, "a round is asked once");

  // After the push the target contains B's commit (and so A's).
  const pushed = advanceSpec({ spec: s, state: again.state, lane: lanes({}), pushed: new Set([SHA_A, SHA_B]), now: at(4) });
  assert.equal(pushed.state.items.A.state, "verifying");
  assert.equal(pushed.state.items.A.integratedSha, SHA_A);
  assert.equal(pushed.state.items.B.integratedSha, SHA_B);
});

test("per-item push gate, suite failures rebuild, unclear receipts get a fresh lane, then exhaust", () => {
  const s = spec([{ id: "A" }, { id: "B" }], { pushGate: "item", maxBuildAttempts: 2 });
  let step = advanceSpec({
    spec: s,
    state: { version: 1, items: { A: { state: "awaiting-push", integration: { sha: SHA_A, order: 1 } }, B: { state: "integrating", attempts: 1, lane: { workflowId: "w", laneId: "l" } } } },
    lane: lanes({ "w/l": { status: "completed", receipt: { summary: "SUITE: fail\norders.test.ts: 2 failures" } } }),
    now: at(0),
  });
  assert.deepEqual(step.rootAsks.map((ask) => [ask.kind, ask.items]), [["push", ["A"]]], "per-item: asked even while other work runs");
  assert.equal(step.state.items.B.state, "building", "a failed suite rebuilds the item");
  assert.match(step.actions.find((action) => action.itemId === "B").findings, /Rebase spec\/B onto spec-integration[\s\S]*2 failures/);

  step = advanceSpec({
    spec: s,
    state: { version: 1, items: { B: { state: "integrating", attempts: 1, lane: { workflowId: "w", laneId: "l" } } } },
    lane: lanes({ "w/l": { status: "completed", receipt: { summary: "Merged it, looks good." } } }),
    now: at(1),
  });
  assert.equal(step.state.items.B.state, "integrating", "a fresh integration lane, not the human gate");
  assert.equal(step.state.items.B.declined.kind, "unclear receipt");
  assert.equal(step.rootAsks.length, 0);
  // With no fallback profiles, the second unclear receipt exhausts the ladder.
  step = advanceSpec({
    spec: s,
    state: { version: 1, items: { B: { ...step.state.items.B, lane: { workflowId: "w2", laneId: "l" } } } },
    lane: lanes({ "w2/l": { status: "completed", receipt: { summary: "Done, I think." } } }),
    now: at(1),
  });
  assert.equal(step.state.items.B.state, "blocked");
  assert.equal(step.state.items.B.blockedReason, "exhausted");
  assert.match(step.rootAsks[0].reason, /2 integrate lane\(s\) did not finish/);

  step = advanceSpec({
    spec: s,
    state: { version: 1, items: { B: { state: "integrating", attempts: 1, lane: { workflowId: "w", laneId: "l" } } } },
    lane: lanes({ "w/l": { status: "operator-closed" } }),
    now: at(2),
  });
  assert.deepEqual(step.actions.filter((action) => action.itemId === "B"), [{ kind: "integrate", itemId: "B", attempt: 1 }], "a lost integration lane is simply retried");
  assert.equal(step.state.items.B.attempts, 1, "not counted as a build attempt");
  const objective = integrateObjective(s, s.items[1], { integrationBranch: "spec-integration", itemBranch: "spec/B" });
  assert.match(objective, /git merge --no-ff -m "spec\(B\): integrate" spec\/B/);
  assert.match(objective, /never push/);
  assert.match(objective, /INTEGRATED: <full 40-character SHA/);
});

test("decide receipts yield questions and ownership corrections", () => {
  assert.deepEqual(decideResult("Settled by the board.\nQUESTION: Which store may approve?\n- QUESTION: Keep the old endpoint?\nOWNS: src/a/**, src/b/**\nMIGRATIONS: 2"), {
    questions: ["Which store may approve?", "Keep the old endpoint?"],
    owns: ["src/a/**", "src/b/**"],
    migrations: 2,
  });
  assert.deepEqual(decideResult("All settled."), { questions: [] });
});

test("the decide stage runs first; leftover questions go to the user in one round", () => {
  const s = spec([{ id: "A", owns: ["src/a/**"] }, { id: "B" }, { id: "C" }], {}, { decide: { profile: "planning" } });
  let step = advanceSpec({ spec: s, state: undefined, lane: lanes({}), now: at(0) });
  assert.deepEqual(step.actions.map((action) => [action.kind, action.itemId]), [["decide", "A"], ["decide", "B"], ["decide", "C"]]);
  assert.equal(step.state.items.A.state, "deciding");

  for (const id of ["A", "B", "C"]) step.state.items[id].lane = { workflowId: `wd-${id}`, laneId: "l1" };
  const receipts = {
    "wd-A/l1": { status: "completed", receipt: { summary: "QUESTION: Which store may approve?\nOWNS: src/orders/**" } },
    "wd-B/l1": { status: "completed", receipt: { summary: "Everything is settled by the board.\nMIGRATIONS: 1" } },
  };
  step = advanceSpec({ spec: s, state: step.state, lane: lanes(receipts), now: at(1) });
  assert.equal(step.state.items.A.state, "blocked");
  assert.equal(step.state.items.A.blockedReason, "decision");
  assert.deepEqual(step.state.items.A.decided.owns, ["src/orders/**"]);
  assert.equal(step.state.items.B.state, "building", "a settled item builds right away");
  assert.equal(step.state.items.B.decided.migrations, 1);
  assert.equal(step.rootAsks.length, 0, "no round while C is still deciding");

  step.state.items.C.lane = { workflowId: "wd-C", laneId: "l1" };
  step = advanceSpec({
    spec: s,
    state: step.state,
    lane: lanes({ "wd-C/l1": { status: "completed", receipt: { summary: "QUESTION: Show tax in the report?" } } }),
    now: at(2),
  });
  assert.deepEqual(step.rootAsks, [{
    itemId: "A",
    kind: "decisions",
    items: ["A", "C"],
    questions: ["A: Which store may approve?", "C: Show tax in the report?"],
    reason: "decision round: 2 item(s)",
  }]);
  const again = advanceSpec({ spec: s, state: step.state, lane: lanes({}), now: at(3) });
  assert.equal(again.rootAsks.length, 0, "a round is asked once");

  // Once answered (herdr_spec action=answer sets pending plus answers), A builds.
  again.state.items.A = { ...again.state.items.A, state: "pending", answers: [{ text: "Store admins approve their own store." }] };
  const built = advanceSpec({ spec: s, state: again.state, lane: lanes({}), now: at(4) });
  assert.deepEqual(built.actions.filter((action) => action.itemId === "A").map((action) => action.kind), ["build"]);
  const objective = buildObjective(s, s.items[0], { branch: "spec/A", decided: again.state.items.A.decided, answers: again.state.items.A.answers });
  assert.match(objective, /The decide stage recorded:\nQUESTION: Which store/);
  assert.match(objective, /answers to its open questions:\nStore admins approve their own store\./);
  assert.match(decideObjective(s, s.items[0]), /Read-only[\s\S]*QUESTION:[\s\S]*OWNS:[\s\S]*MIGRATIONS:/);
});

test("verify receipts list preview specs and the report path", () => {
  assert.deepEqual(verifyResult("PREVIEW: e2e/a.spec.ts pass\nPREVIEW: e2e/b.spec.ts FAIL (timeout)\nREPORT: artifacts/a.final.docx"), {
    previews: [{ spec: "e2e/a.spec.ts", result: "pass" }, { spec: "e2e/b.spec.ts", result: "fail" }],
    report: "artifacts/a.final.docx",
  });
});

test("verification waits for a deploy containing the commit, then one verify lane records the preview runs", () => {
  const preview = { url: "https://preview.example.test", releaseCheck: "https://preview.example.test/api/version" };
  const s = spec(
    [
      { id: "A", acceptance: { text: "a", preview: ["e2e/a.spec.ts"], evidence: { report: "artifacts/a.docx", minImages: 2 } } },
      { id: "B" },
      { id: "C", acceptance: { text: "c", preview: ["e2e/c.spec.ts"] } },
    ],
    { maxParallel: 1 },
    undefined,
    preview,
  );
  const state = {
    version: 1,
    items: {
      A: { state: "verifying", integratedSha: SHA_A },
      B: { state: "verifying", integratedSha: SHA_B },
      C: { state: "ready" },
    },
  };
  let step = advanceSpec({ spec: s, state, lane: lanes({}), now: at(0) });
  assert.match(step.waits.A, /release check does not report a deploy containing this commit yet/);
  assert.equal(step.state.items.B.verified, at(0), "nothing to verify on the preview: straight to the verifier");
  assert.deepEqual(step.actions.map((action) => [action.kind, action.itemId]), [["build", "C"]], "a verifying item waiting for a deploy holds no slot");

  step = advanceSpec({ spec: s, state, lane: lanes({}), released: new Map([["A", SHA_B]]), now: at(1) });
  assert.deepEqual(step.actions.filter((action) => action.itemId === "A"), [{ kind: "verify", itemId: "A", attempt: 1 }]);
  assert.equal(step.state.items.A.releaseSha, SHA_B);
  assert.match(verifyObjective(s, s.items[0], { releaseSha: SHA_B, reportPath: "artifacts/a.final.docx" }), /against the preview at https:\/\/preview\.example\.test: e2e\/a\.spec\.ts[\s\S]*artifacts\/a\.final\.docx[\s\S]*PREVIEW: <spec path> pass/);

  step.state.items.A.lane = { workflowId: "wv", laneId: "l1" };
  const passed = advanceSpec({
    spec: s,
    state: step.state,
    lane: lanes({ "wv/l1": { status: "completed", receipt: { summary: "PREVIEW: e2e/a.spec.ts pass\nREPORT: artifacts/a.final.docx" } } }),
    now: at(2),
  });
  assert.equal(passed.state.items.A.verified, at(2));
  assert.deepEqual(passed.state.items.A.preview, [{ spec: "e2e/a.spec.ts", result: "pass", sha: SHA_A, releaseSha: SHA_B, at: at(2) }]);
  assert.equal(passed.state.items.A.finalReport, "artifacts/a.final.docx");

  const failed = advanceSpec({
    spec: s,
    state: step.state,
    lane: lanes({ "wv/l1": { status: "completed", receipt: { summary: "PREVIEW: e2e/a.spec.ts fail\nREPORT: artifacts/a.final.docx" } } }),
    now: at(2),
  });
  assert.equal(failed.state.items.A.state, "blocked");
  assert.match(failed.state.items.A.note, /preview failed: e2e\/a\.spec\.ts/);
  assert.match(failed.rootAsks[0].reason, /verification on the preview failed after the push/);
});

test("items queued for integration hold no maxParallel slot; live lanes do", () => {
  const queued = Array.from({ length: 10 }, (_, index) => ({ id: `Q${index}` }));
  const ready = Array.from({ length: 6 }, (_, index) => ({ id: `R${index}`, owns: [`src/r${index}/**`] }));
  const s = spec([...queued, ...ready], { maxParallel: 4 });
  const items = Object.fromEntries(queued.map((item) => [item.id, { state: "integrating", attempts: 1 }]));
  // One queued item is being merged right now: its lane holds a slot.
  items.Q0.lane = { workflowId: "wi", laneId: "l1" };
  for (const item of ready) items[item.id] = { state: "ready" };
  const step = advanceSpec({ spec: s, state: { version: 1, items }, lane: lanes({ "wi/l1": { status: "working" } }), now: at(0) });
  const builds = step.actions.filter((action) => action.kind === "build").map((action) => action.itemId);
  assert.deepEqual(builds, ["R0", "R1", "R2"], "maxParallel 4 minus the one live integration lane");
  assert.match(step.waits.R3, /^capacity: 4 items already in flight/);

  // Verifying items waiting for a deploy hold none either; a lane-less build retry does.
  const later = advanceSpec({
    spec: s,
    state: { version: 1, items: { ...Object.fromEntries(queued.map((item) => [item.id, { state: "verifying", integratedSha: "x" }])), R0: { state: "building", attempts: 1 }, R1: { state: "ready" }, R2: { state: "ready" }, R3: { state: "ready" }, R4: { state: "ready" } } },
    lane: lanes({}),
    now: at(1),
  });
  assert.deepEqual(later.actions.filter((action) => action.kind === "build").map((action) => action.itemId), ["R0", "R1", "R2", "R3"], "the retry of R0 plus three new builds");
});

test("an open verify lane also reserves the integration worktree", () => {
  const s = spec([{ id: "V" }, { id: "I" }]);
  const step = advanceSpec({
    spec: s,
    state: { version: 1, items: { V: { state: "verifying", integratedSha: "x", lane: { workflowId: "wv", laneId: "l" } }, I: { state: "integrating", attempts: 1 } } },
    lane: lanes({ "wv/l": { status: "working", workflowStatus: "running" } }),
    now: at(0),
  });
  assert.equal(step.actions.some((action) => action.kind === "integrate"), false);
  assert.match(step.waits.I, /integration worktree busy: V's lane wv is still open/);
});

test("a decline is an explicit DECLINED line, or decline language where the stage's required lines are missing", async () => {
  const { declineReason, profileAfterDeclines } = await import("../spec-driver.mjs");
  assert.equal(declineReason("DECLINED: the lint fix would need a rule suppression\nNo changes.", "integrate"), "the lint fix would need a rule suppression");
  assert.equal(declineReason("I must decline this task. Changing another team's service is out of my scope.", "integrate"), "I must decline this task.");
  assert.equal(declineReason("INTEGRATED: " + "a".repeat(40) + "\nSUITE: fail\nI can't proceed further.", "integrate"), undefined, "a real receipt is not a decline");
  assert.equal(declineReason("I won't do that without approval.", "build"), undefined, "a build receipt needs the explicit line");
  assert.equal(declineReason("DECLINED: out of scope", "build"), "out of scope");
  assert.equal(declineReason("Looks good overall.", "review"), undefined);
  const spec = { defaults: { maxDeclines: 2 }, stages: { integrate: { profile: "balanced", fallbackProfiles: ["deep", "careful"] } } };
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((count) => profileAfterDeclines(spec, "integrate", count)), [
    { index: 0 },
    { index: 1, profile: "deep" },
    { index: 1, profile: "deep" },
    { index: 2, profile: "careful" },
    { index: 2, profile: "careful" },
    undefined,
  ]);
  assert.equal(profileAfterDeclines({ defaults: {}, stages: {} }, "review", 2), undefined, "no fallbacks: two declines, then the root");
});
