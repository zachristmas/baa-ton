import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { REPEAT_WINDOW_MS, STALL_ANOMALY_MS, detectAnomalies, detectUndeliverable, reportAnomaly } from "../anomalies.mjs";

async function store(agents = { "lane-admin": { paneId: "w2F:p2", agentKind: "claude" } }) {
  const directory = await mkdtemp(join(tmpdir(), "baa-anomaly-"));
  const path = join(directory, "operator.json");
  await writeFile(path, JSON.stringify({ version: 1, agents, messages: [] }));
  return { env: { BAATON_OPERATOR_STORE: path }, path, read: async () => JSON.parse(await readFile(path, "utf8")), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const at = (ms) => new Date(Date.parse("2026-09-26T15:00:00.000Z") + ms).toISOString();

test("anomalies are detected with evidence: a 20-minute stall, a repeated alert, a receipt still missing after the pointed ask", () => {
  const entry = { alerts: [1, 2, 3].map(() => ({ text: "D11: its review lanes declined 2 time(s)", createdAt: at(-60_000) })) };
  assert.deepEqual(detectAnomalies({ entry, specStall: true, specReason: "spec: 1 item(s) are waiting", specState: {}, timestamp: at(0) }).map((a) => a.kind), ["repeated-alert"]);
  const later = detectAnomalies({ entry, specStall: true, specReason: "spec: 1 item(s) are waiting", specState: { items: { D05: { state: "building", lane: { workflowId: "herdr-1" }, receiptPointedAt: at(-40 * 60_000) } } }, timestamp: at(STALL_ANOMALY_MS) });
  assert.deepEqual(later.map((a) => a.kind).sort(), ["receipt-missing", "repeated-alert", "stall"]);
  assert.equal(later.find((a) => a.kind === "repeated-alert").decision, true, "a repeated root alert is a decision: the root gets it too");
  detectAnomalies({ entry, specStall: false, specState: {}, timestamp: at(STALL_ANOMALY_MS + 1) });
  assert.equal(entry.stallSince, undefined, "the stall episode ends when work moves");
});

test("a repeated alert counts only while current: recent, and its item still blocked", () => {
  const text = "D02: a worktree has modified tracked files that belong to no spec item (x.json).";
  const alerts = (createdAt) => [1, 2, 3].map(() => ({ text, createdAt }));
  const kinds = (entry, specState) => detectAnomalies({ entry, specStall: false, specState, timestamp: at(0) }).map((a) => a.kind);
  assert.deepEqual(kinds({ alerts: alerts(at(-60_000)) }, { items: { D02: { state: "blocked" } } }), ["repeated-alert"]);
  assert.deepEqual(kinds({ alerts: alerts(at(-60_000)) }, { items: { D02: { state: "failed" } } }), [], "the item moved on: history, not a repeat");
  assert.deepEqual(kinds({ alerts: alerts(at(-REPEAT_WINDOW_MS - 1)) }, { items: { D02: { state: "blocked" } } }), [], "older than the window");
  assert.deepEqual(kinds({ alerts: [1, 2, 3].map(() => ({ text })) }, {}), [], "no timestamp: history");
  assert.deepEqual(kinds({ alerts: [1, 2, 3].map(() => ({ text: "memory pressure: free 1 GB", createdAt: at(-60_000) })) }, {}), ["repeated-alert"], "an alert about no item counts by time alone");
});

test("each anomaly reaches lane-admin once per signature; after two fixes it recurs, the user gets one bug report", async () => {
  const s = await store();
  try {
    const notes = [];
    const notify = async (note) => notes.push(note);
    const anomaly = { kind: "unhandled-blocked", signature: "blocked:w/l:none", summary: "lane w/l is blocked and the handler did nothing", evidence: ["pane w2G:p9", "screen (last 30 lines):", "> "] };
    assert.equal((await reportAnomaly(anomaly, { timestamp: at(0), notify, env: s.env })).status, "new");
    assert.equal((await reportAnomaly(anomaly, { timestamp: at(60_000), notify, env: s.env })).status, "repeat", "deduplicated while unfixed");
    let state = await s.read();
    assert.equal(state.messages.length, 1);
    assert.match(state.messages[0].text, /^\[Baa-ton anomaly: unhandled-blocked\] lane w\/l is blocked/);
    assert.match(state.messages[0].text, /pane w2G:p9/);
    assert.match(state.messages[0].text, new RegExp(`baa-ton reply ${state.messages[0].id} "fixed in <PR>"`));
    assert.equal(state.messages[0].resolved.label, "agent:lane-admin");
    // lane-admin replies "fixed"; it comes back twice.
    for (const round of [1, 2]) {
      state = await s.read();
      state.messages.at(-1).replies = [{ at: at(round * 100_000), text: "fixed in #1", read: false }];
      await writeFile(s.path, JSON.stringify(state));
      assert.equal((await reportAnomaly(anomaly, { timestamp: at(round * 200_000), notify, env: s.env })).status, "recurred");
    }
    assert.equal(notes.length, 1, "one report to the user, after two fixes");
    assert.match(notes[0].title, /bug report \(no action needed\)/);
    state = await s.read();
    assert.equal(state.anomalies["blocked:w/l:none"].fixes, 2);
  } finally {
    await s.cleanup();
  }
});

test("a decision anomaly also goes to the root; with no lane-admin registered it is recorded, unrouted", async () => {
  const s = await store();
  try {
    const rootTarget = { kind: "root", label: "root:task", paneId: "w22:p1" };
    await reportAnomaly({ kind: "repeated-alert", decision: true, signature: "alert:x", summary: "the same root alert was raised 3 times", evidence: ["x"] }, { timestamp: at(0), env: s.env, rootTarget });
    const state = await s.read();
    assert.deepEqual(state.messages.map((message) => message.resolved.label).sort(), ["agent:lane-admin", "root:task"]);
  } finally {
    await s.cleanup();
  }
  const bare = await store({});
  try {
    assert.equal((await reportAnomaly({ kind: "stall", signature: "stall:t", summary: "stalled" }, { timestamp: at(0), env: bare.env })).status, "unrouted");
    assert.equal((await bare.read()).messages.length, 0);
  } finally {
    await bare.cleanup();
  }
});

test("a spec push that keeps failing is an anomaly with the full git error, not a truncated root ask", async () => {
  const error = ["! [rejected] 999999999999 -> feature/release (non-fast-forward)", "error: failed to push some refs to 'origin'", "hint: Updates were rejected because the tip of your current branch is behind"].join("\n");
  const specState = {
    items: { D03: { state: "awaiting-push" }, D04: { state: "awaiting-push" } },
    pushFailure: { sha: "9".repeat(40), items: ["D03", "D04"], error, at: at(0), count: 2 },
  };
  const found = detectAnomalies({ entry: { alerts: [] }, specState, timestamp: at(60_000) });
  assert.deepEqual(found.map((anomaly) => [anomaly.kind, anomaly.signature]), [["push-failed", "push-failed:999999999999:2"]]);
  assert.match(found[0].summary, /push of 999999999999 \(D03, D04\) failed 2 time\(s\)/);
  assert.deepEqual(found[0].evidence, error.split("\n"), "every line of the git error");
  // Once nothing waits to be pushed, it is history.
  assert.deepEqual(detectAnomalies({ entry: { alerts: [] }, specState: { ...specState, items: { D03: { state: "verifying" } } }, timestamp: at(60_000) }), []);
  // Each further failure is a new signature, so it recurs after a fix.
  const again = detectAnomalies({ entry: { alerts: [] }, specState: { ...specState, pushFailure: { ...specState.pushFailure, count: 3 } }, timestamp: at(60_000) });
  assert.equal(again[0].signature, "push-failed:999999999999:3");
});

test("operator messages that can not be delivered are an anomaly with a notification to the user, once (op-fb9634f3 sat pending for hours with no alert)", async () => {
  const s = await store();
  try {
    const messages = [
      { id: "op-1", target: "root:cic", resolved: { label: "root:cic" }, delivery: { status: "pending", attempts: 0, reason: "no_agent_in_pane", blockedSince: at(-30 * 60_000) } },
      { id: "op-2", target: "root:cic", resolved: { label: "root:cic" }, delivery: { status: "pending", attempts: 0, reason: "no_agent_in_pane", blockedSince: at(-29 * 60_000) } },
      // Busy is expected, a fresh block has not waited long enough, delivered is done.
      { id: "op-3", target: "lane-admin", resolved: { label: "agent:lane-admin" }, delivery: { status: "pending", attempts: 0, reason: "agent is working" } },
      { id: "op-4", target: "lane-admin", resolved: { label: "agent:lane-admin" }, delivery: { status: "pending", attempts: 0, reason: "pane_shows_shell_prompt", blockedSince: at(-2 * 60_000) } },
      { id: "op-5", target: "lane-admin", resolved: { label: "agent:lane-admin" }, delivery: { status: "delivered", attempts: 1 } },
    ];
    const found = await detectUndeliverable({ store: { messages }, timestamp: at(0) });
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, "operator-undeliverable");
    assert.equal(found[0].signature, "undeliverable:root:cic:no_agent_in_pane");
    assert.match(found[0].summary, /2 operator message\(s\) to root:cic have been undeliverable for 30 min: no_agent_in_pane/);
    assert.match(found[0].evidence[0], /op-1, op-2/);
    assert.deepEqual(await detectUndeliverable({ store: { messages: [] }, timestamp: at(0) }), []);

    const notices = [];
    const notify = async (notice) => notices.push(notice);
    const first = await reportAnomaly(found[0], { timestamp: at(0), notify, env: s.env });
    assert.equal(first.status, "new");
    assert.equal(notices.length, 1, "the user hears about it at once");
    assert.equal(notices[0].title, "Baa-ton: operator messages are stuck");
    assert.match(notices[0].body, /undeliverable for 30 min/);
    await reportAnomaly(found[0], { timestamp: at(60_000), notify, env: s.env });
    assert.equal(notices.length, 1, "once per signature");
    // lane-admin unregistered: nothing to route to, the notification still goes out.
    const noAdmin = await store({});
    try {
      const other = [];
      const result = await reportAnomaly(found[0], { timestamp: at(0), notify: async (notice) => other.push(notice), env: noAdmin.env });
      assert.equal(result.status, "unrouted");
      assert.equal(other.length, 1);
    } finally {
      await noAdmin.cleanup();
    }
  } finally {
    await s.cleanup();
  }
});

test("lane launches that keep failing for one cause are an anomaly: at once for two items, after three tries for one (four review lanes could not start for four hours, retried silently)", () => {
  const reason = "Capability discovery failed for openai-codex/gpt-6-luna: the live model registry refresh operation is unavailable; refusing a static registry snapshot";
  const item = (failures, stage = "review", state = "reviewing", extra = {}) => ({ state, infraFailures: failures, declines: [{ at: at(-60_000), stage, kind: "infrastructure", reason }], ...extra });
  const detect = (items) => detectAnomalies({ entry: { alerts: [] }, specState: { items }, timestamp: at(0) }).filter((anomaly) => anomaly.kind === "launch-failing");

  const two = detect({ D07: item(1), D14: item(1) });
  assert.equal(two.length, 1);
  assert.equal(two[0].decision, true, "the root decides (a profile or harness choice)");
  assert.match(two[0].summary, /2 spec item\(s\) can not launch lanes for the same reason: Capability discovery failed/);
  assert.match(two[0].evidence.join("\n"), /D07: review launch failed 1 time\(s\)[\s\S]*D14: review launch failed 1 time\(s\)[\s\S]*herdr_setup/);
  assert.deepEqual(detect({ D07: item(1) }), [], "one item, one failure: ordinary infrastructure noise");
  assert.equal(detect({ D07: item(3) }).length, 1, "one item failing three times in a row");
  // Same cause spelled with different ids and numbers is one anomaly.
  const other = { ...item(1), declines: [{ at: at(-60_000), stage: "build", kind: "never started", reason: "lane herdr-2a0e9fd3 was planned but never launched: " + reason }] };
  const grouped = detect({ D07: item(1), D10: other });
  assert.equal(grouped.length, 1, "grouped by cause, whatever the lane prefix");
  assert.match(grouped[0].summary, /^2 spec item\(s\)/);
  // Old, finished or successful launches do not count.
  assert.deepEqual(detect({ D07: item(1, "review", "done"), D14: item(1, "review", "deferred") }), []);
  assert.deepEqual(detect({ D07: { ...item(1), declines: [{ at: at(-REPEAT_WINDOW_MS - 60_000), stage: "review", kind: "infrastructure", reason }] }, D14: item(1) }), []);
  // Signatures are per cause, so it is sent once and recurs only after a fix.
  assert.equal(two[0].signature, detect({ D07: item(2), D14: item(5) })[0].signature);
});
