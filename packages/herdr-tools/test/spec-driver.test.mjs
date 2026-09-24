import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSpec } from "../spec.mjs";
import { advanceSpec, buildObjective, globsOverlap, reviewObjective, reviewVerdict } from "../spec-driver.mjs";

const spec = (items, defaults = {}) =>
  validateSpec({
    version: 1,
    target: { repo: ".", remote: "origin", branch: "feature/release" },
    defaults,
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
  assert.deepEqual(step.actions, [{ kind: "build", itemId: "C", attempt: 1 }]);
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

test("a lane that ends without a receipt is a failed attempt; an unclear verdict goes to the root", () => {
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
  assert.equal(step.state.items.B.state, "blocked");
  assert.equal(step.state.items.B.blockedReason, "human-gate");
  assert.match(step.rootAsks[0].reason, /no verdict/);
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
