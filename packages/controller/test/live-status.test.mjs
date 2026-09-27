import assert from "node:assert/strict";
import test from "node:test";
import { latestLaneStatus, logNudgeDecision, nudgeDecision, refreshLiveLaneStatus } from "../controller.mjs";

const manifestPath = "/nowhere/.baa-ton/herdr-orchestrator/manifest.json";
const NOW = "2026-09-26T23:40:00.000Z";
const orchestrator = {
  id: "orchestrator:root",
  root: { pane_id: "w22:p1", workspace_id: "w22", agent_kind: "pi" },
  program: {},
  workflows: [{ workflow_id: "herdr-e0717b1b", manifest_path: manifestPath }],
};

// As it stood live: the demo lane's last status event said working (hours
// old), its agent had finished, and its runtime-launch request was open.
const liveShape = () => ({
  workflows: [
    {
      id: "herdr-e0717b1b",
      status: "running",
      lanes: [{ id: "lane-1", status: "running", paneId: "w22:p5S" }],
      eventController: { events: [{ lane_id: "lane-1", received_at: "2026-09-26T21:42:19.855Z", source: { agent_status: "working" } }] },
      laneRequests: [{ id: "request-c6b70827", laneId: "lane-1", kind: "runtime-launch", status: "open", summary: "runtime launch: pnpm dev" }],
    },
  ],
});

const herdrSaying = (status) => ({
  async request(method, params) {
    assert.equal(method, "agent.get");
    return { type: "agent_info", agent: { agent: "claude", pane_id: params.target, agent_status: status } };
  },
});

test("a lane whose stale event says working, but whose agent is done, no longer silences the nudge (a live stall)", async () => {
  const goal = { id: "g", status: "active" };
  const manifest = liveShape();
  const stale = nudgeDecision({ goal, manifest, orchestrator, manifestPath, run: { state: "running" } });
  assert.ok(!(stale.reasons ?? []).some((reason) => /request-c6b70827/.test(reason)), "from events alone the request looked in progress");
  const live = await refreshLiveLaneStatus(herdrSaying("done"), manifest.workflows, { timestamp: NOW });
  assert.equal(latestLaneStatus(manifest.workflows[0], "lane-1", live), "done");
  const decision = nudgeDecision({ goal, manifest, orchestrator, manifestPath, run: { state: "running" }, live });
  assert.equal(decision.quiet, undefined);
  assert.ok(decision.reasons.some((reason) => /lane herdr-e0717b1b\/lane-1 \(done\) waits on request request-c6b70827/.test(reason)), "the open request wakes the root");
});

test("live status: another pane's answer is no answer, a missing agent is gone, finished lanes are not asked", async () => {
  const manifest = liveShape();
  manifest.workflows.push({ id: "herdr-done", status: "completed", lanes: [{ id: "lane-1", paneId: "w22:p9" }] });
  const asked = [];
  const live = await refreshLiveLaneStatus(
    {
      async request(_method, params) {
        asked.push(params.target);
        return { type: "agent_info", agent: { agent: "pi", pane_id: "w22:p1", agent_status: "idle" } };
      },
    },
    manifest.workflows,
    { timestamp: NOW },
  );
  assert.deepEqual(asked, ["w22:p5S"], "a completed workflow's lane is not asked");
  assert.equal(live.size, 0, "the root answering for another pane says nothing about the lane");
  assert.equal(latestLaneStatus(manifest.workflows[0], "lane-1", live), "working", "the event status stands");
  const gone = await refreshLiveLaneStatus({ async request() { return { type: "agent_info" }; } }, manifest.workflows, { timestamp: NOW });
  assert.equal(gone.get("herdr-e0717b1b/lane-1"), "gone");
  // A fresh busy event is Herdr's word already: not asked.
  asked.length = 0;
  await refreshLiveLaneStatus({ async request(_m, params) { asked.push(params.target); return {}; } }, manifest.workflows, { timestamp: "2026-09-26T21:45:00.000Z" });
  assert.deepEqual(asked, [], "a 3-minute-old working event is not doubted");
});

test("each root's nudge decision is logged when it changes, not every tick", () => {
  const lines = [];
  const log = (line) => lines.push(line);
  assert.equal(logNudgeDecision("/cfg", "root-a", { quiet: "run-paused" }, log), true);
  assert.equal(logNudgeDecision("/cfg", "root-a", { quiet: "run-paused" }, log), false, "unchanged: not logged again");
  logNudgeDecision("/cfg", "root-a", { reasons: ["lane w/l (done) waits on request r1: runtime launch"], specStall: true }, log);
  // The count and the stall flag flipping while the first reason stays is no change (a live log flood).
  logNudgeDecision("/cfg", "root-a", { reasons: ["lane w/l (done) waits on request r1: runtime launch", "spec: 3 item(s) waiting"], specStall: false }, log);
  assert.deepEqual(lines, ["nudge root-a: quiet (run-paused)", "nudge root-a: due: 1 reason(s), spec stalled: lane w/l (done) waits on request r1: runtime launch"]);
});

test("a blocked status whose screen shows the agent at work is not an unhandled block (a live false alarm)", async () => {
  const { screenShowsWork } = await import("../controller.mjs");
  const working = [
    "  ⏺ Reading tests/e2e/integration/payment/split-payment-auto-disable-d04.spec.ts",
    "  ✻ Catapulting… (4m 56s · ↓ 5.1k tokens · thinking)",
    "  ❯",
    "    ⏸ manual mode on · 7 shells · ← for agents",
  ].join("\n");
  assert.equal(screenShowsWork(working), true);
  assert.equal(screenShowsWork("  ✳ Thinking… (12s · esc to interrupt)"), true);
  assert.equal(screenShowsWork("  ❯ \n  ? for shortcuts"), false, "an idle prompt is not work");
  assert.equal(screenShowsWork("Done in 12s."), false);
});
