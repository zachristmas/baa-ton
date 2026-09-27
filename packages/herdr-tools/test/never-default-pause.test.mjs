import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { autoAnswerPlan, autoAnswerText, stopsWork } from "../root-question.mjs";
import { changeRunState, pauseRefusal, readRunState, sendOperatorMessage } from "../operator-api.mjs";

// The question that paused a live run at night: the Recommended option was
// "Pause retries", and the unattended default took it.
const TONIGHT = "The D02/D03 lanes have repeatedly failed to start, and Herdr doctor reports lane-bridge-liveness, runtime-version-skew, and controller-plugin-install warnings. Should I pause the running spec loop’s automatic retries until the harness is repaired, or let the supervisor continue retrying?";

test("an unattended default never takes an option that pauses or stops work: tonight's question keeps the run moving", () => {
  const plan = autoAnswerPlan({ questions: [{ question: TONIGHT, options: ["Pause retries (Recommended)", "Continue retrying"] }] });
  assert.equal(plan.eligible, true);
  assert.equal(plan.answers[0].answer, "Continue retrying");
  assert.equal(plan.answers[0].declinedRecommended, "Pause retries");
  assert.match(autoAnswerText(plan), /not your Recommended "Pause retries": an unattended default never pauses or stops work/);
  assert.match(autoAnswerText(plan), /Only the user can pause the run/);
  // A Recommended option that keeps work moving is still taken.
  const moving = autoAnswerPlan({ questions: [{ question: "Retry the build?", options: ["Retry now (Recommended)", "Pause the loop"] }] });
  assert.equal(moving.answers[0].answer, "Retry now");
  assert.equal(moving.answers[0].declinedRecommended, undefined);
});

test("when every option pauses or stops work, the default does not answer (the user decides)", () => {
  const plan = autoAnswerPlan({ questions: [{ question: "How should I stop?", options: ["Pause the run (Recommended)", "Stop all lanes", "Hold D02 until morning"] }] });
  assert.equal(plan.eligible, false);
  assert.equal(plan.stopsWork, true);
  assert.match(plan.reason, /every option .* pauses or stops work, so only the user may choose/);
});

test("the stop-work words are recognized, ordinary options are not", () => {
  for (const label of ["Pause retries", "Stop the loop", "Halt dispatch", "Hold off", "Park D02", "Defer to morning", "Block the goal", "Wait until the harness is repaired", "Don't retry"]) assert.equal(stopsWork(label), true, label);
  for (const label of ["Continue retrying", "Retry now", "Dispatch a fix lane", "Integrate D05 next", "Use the lane's leased ports"]) assert.equal(stopsWork(label), false, label);
});

test("only Zach pauses the run: never the root, a lane, or anyone without --from zach; a STOP from someone else is delivered but pauses nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-pause-"));
  try {
    const config = { version: 2, orchestrators: [{ id: "o", root: { pane_id: "w22:p1", workspace_id: "w22" }, workflows: [{ workflow_id: "herdr-1", lanes: [{ lane_id: "lane-1", pane_id: "w22:p5S" }] }] }] };
    const env = (pane) => ({ BAATON_OPERATOR_STORE: join(directory, "operator.json"), ...(pane ? { HERDR_PANE_ID: pane } : {}) });
    assert.match(await pauseRefusal({ from: "operator", env: env(), config }), /only Zach can pause/);
    assert.match(await pauseRefusal({ from: "zach", env: env("w22:p1"), config }), /the root cannot pause/);
    assert.match(await pauseRefusal({ from: "Zach", env: env("w22:p5S"), config }), /a lane cannot pause/);
    assert.equal(await pauseRefusal({ from: "zach", env: env("w9:p1"), config }), undefined, "Zach from his own pane");
    await assert.rejects(changeRunState({ state: "paused", reason: "a default said so", from: "operator", env: env("w22:p1"), config }), /Not paused: only Zach can pause/);
    assert.equal((await readRunState({ env: env() })).state, "running");
    const stop = await sendOperatorMessage({ target: "root", text: "PAUSE", from: "root", env: env("w22:p1"), config, deliver: async () => [] });
    assert.match(stop.runStateRefused, /only Zach can pause/);
    assert.equal((await readRunState({ env: env() })).state, "running", "a STOP from the root pauses nothing");
    const paused = await changeRunState({ state: "paused", reason: "night stop", from: "zach", env: env(), config });
    assert.equal(paused.state, "paused");
    assert.equal((await changeRunState({ state: "running", from: "ink", env: env("w22:p1"), config })).state, "running", "anyone may resume");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
