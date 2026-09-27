import assert from "node:assert/strict";
import test from "node:test";
import { PAUSE_NOTICE_MS, pauseNoticeDue } from "../controller.mjs";

test("a run paused 15 min while items wait: Zach hears once per pause", () => {
  const seen = new Set();
  const run = { state: "paused", at: "2026-09-27T02:09:00.572Z", by: "operator", reason: "As selected by the user-question default" };
  const at = (ms) => new Date(Date.parse(run.at) + ms).toISOString();
  assert.equal(pauseNoticeDue(run, at(PAUSE_NOTICE_MS - 1), true, seen), false, "not before 15 min");
  assert.equal(pauseNoticeDue(run, at(PAUSE_NOTICE_MS), false, seen), false, "nothing waiting: no notice");
  assert.equal(pauseNoticeDue(run, at(PAUSE_NOTICE_MS), true, seen), true);
  assert.equal(pauseNoticeDue(run, at(PAUSE_NOTICE_MS + 60_000), true, seen), false, "once per pause");
  assert.equal(pauseNoticeDue({ ...run, at: at(3_600_000) }, at(3_600_000 + PAUSE_NOTICE_MS), true, seen), true, "a new pause is a new notice");
  assert.equal(pauseNoticeDue({ state: "running" }, at(PAUSE_NOTICE_MS), true, seen), false);
});
