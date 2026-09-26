import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { STALL_ANOMALY_MS, detectAnomalies, reportAnomaly } from "../anomalies.mjs";

async function store(agents = { "lane-admin": { paneId: "w2F:p2", agentKind: "claude" } }) {
  const directory = await mkdtemp(join(tmpdir(), "baa-anomaly-"));
  const path = join(directory, "operator.json");
  await writeFile(path, JSON.stringify({ version: 1, agents, messages: [] }));
  return { env: { BAATON_OPERATOR_STORE: path }, path, read: async () => JSON.parse(await readFile(path, "utf8")), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const at = (ms) => new Date(Date.parse("2026-09-26T15:00:00.000Z") + ms).toISOString();

test("anomalies are detected with evidence: a 20-minute stall, a repeated alert, a receipt still missing after the pointed ask", () => {
  const entry = { alerts: [1, 2, 3].map(() => ({ text: "D11: its review lanes declined 2 time(s)" })) };
  assert.deepEqual(detectAnomalies({ entry, specStall: true, specReason: "spec: 1 item(s) are waiting", specState: {}, timestamp: at(0) }).map((a) => a.kind), ["repeated-alert"]);
  const later = detectAnomalies({ entry, specStall: true, specReason: "spec: 1 item(s) are waiting", specState: { items: { D05: { state: "building", lane: { workflowId: "herdr-1" }, receiptPointedAt: at(-40 * 60_000) } } }, timestamp: at(STALL_ANOMALY_MS) });
  assert.deepEqual(later.map((a) => a.kind).sort(), ["receipt-missing", "repeated-alert", "stall"]);
  assert.equal(later.find((a) => a.kind === "repeated-alert").decision, true, "a repeated root alert is a decision: the root gets it too");
  detectAnomalies({ entry, specStall: false, specState: {}, timestamp: at(STALL_ANOMALY_MS + 1) });
  assert.equal(entry.stallSince, undefined, "the stall episode ends when work moves");
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
