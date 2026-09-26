/**
 * Self-healing (docs/SELF-HEALING.md): the supervisor turns what it sees
 * going wrong into anomalies with evidence, and sends each one, once per
 * signature, as an operator message to the registered agent "lane-admin",
 * which fixes it, tests it and merges it (self-update deploys it). A
 * decision rather than a bug also goes to the root. The user hears about an
 * anomaly only when it comes back after two fixes.
 */
export const ANOMALY_AGENT = "lane-admin";
export const STALL_ANOMALY_MS = 20 * 60_000;
export const RECEIPT_ANOMALY_MS = 30 * 60_000;
const FIXES_BEFORE_USER = 2;

function operator() {
  return import("../herdr-tools/operator.mjs");
}

function messageText(anomaly, id) {
  const evidence = (anomaly.evidence ?? []).filter(Boolean).map((line) => `  ${String(line).slice(0, 600)}`);
  return [
    `[Baa-ton anomaly: ${anomaly.kind}] ${anomaly.summary}`,
    ...(evidence.length ? ["Evidence:", ...evidence] : []),
    `Signature: ${anomaly.signature}`,
    `Fix it, test it and merge it by branch name (self-update deploys it), record it in docs/SELF-HEALING.md, then reply: baa-ton reply ${id} "fixed in <PR>".`,
  ].join("\n");
}

/**
 * Record one anomaly and route it. Returns what happened: new, repeat
 * (deduplicated), recurred (after a fix), or unrouted (no lane-admin).
 */
export async function reportAnomaly(anomaly, { timestamp, notify = async () => undefined, rootTarget, env = process.env } = {}) {
  const { operatorStorePath, withOperatorStore, addOperatorMessage, resolveOperatorTarget } = await operator();
  const storePath = operatorStorePath(env);
  const result = await withOperatorStore(storePath, (store) => {
    const anomalies = (store.anomalies ??= {});
    const entry = anomalies[anomaly.signature];
    const lastMessage = entry?.messageId ? store.messages.find((message) => message.id === entry.messageId) : undefined;
    const fixed = Boolean(lastMessage?.replies?.length);
    if (entry && !fixed) {
      entry.lastAt = timestamp;
      entry.count = (entry.count ?? 1) + 1;
      return { status: "repeat", entry };
    }
    const next = entry
      ? { ...entry, lastAt: timestamp, count: (entry.count ?? 1) + 1, fixes: (entry.fixes ?? 0) + 1 }
      : { kind: anomaly.kind, summary: anomaly.summary, firstAt: timestamp, lastAt: timestamp, count: 1, fixes: 0 };
    let messageId;
    const agent = store.agents?.[ANOMALY_AGENT];
    if (agent?.paneId) {
      const resolved = resolveOperatorTarget(ANOMALY_AGENT, { agents: store.agents });
      const message = addOperatorMessage(store, { target: ANOMALY_AGENT, resolved, text: messageText(anomaly, "ID"), from: "baa-ton supervisor", at: timestamp });
      message.text = messageText(anomaly, message.id);
      messageId = message.id;
    }
    if (anomaly.decision && rootTarget) {
      const message = addOperatorMessage(store, { target: "root", resolved: rootTarget, text: `[Baa-ton anomaly: ${anomaly.kind}] ${anomaly.summary}\nDecide it under the escalation policy (only unclear requirements go to the user) and act.`, from: "baa-ton supervisor", at: timestamp });
      next.rootMessageId = message.id;
    }
    next.messageId = messageId ?? next.messageId;
    next.evidence = (anomaly.evidence ?? []).slice(0, 12);
    anomalies[anomaly.signature] = next;
    return { status: entry ? "recurred" : messageId ? "new" : "unrouted", entry: next };
  });
  // Back after two fixes: now the user hears about it, once, as a bug report.
  if (result.status === "recurred" && result.entry.fixes >= FIXES_BEFORE_USER && !result.entry.userNotifiedAt) {
    await notify({
      title: "Baa-ton bug report (no action needed)",
      body: `${anomaly.summary}: it came back after ${result.entry.fixes} fixes. lane-admin keeps working on it; this is a report, not a request.`.slice(0, 400),
    });
    await withOperatorStore(storePath, (store) => {
      if (store.anomalies?.[anomaly.signature]) store.anomalies[anomaly.signature].userNotifiedAt = timestamp;
    });
  }
  return result;
}

/**
 * Anomalies visible in one root's manifest and spec state on a supervisor
 * tick: a stall of STALL_ANOMALY_MS or more, a root alert repeated three or
 * more times, and a lane still without a receipt RECEIPT_ANOMALY_MS after
 * the driver's pointed ask. `entry` is the root's rootSupervision record
 * (stallSince is kept there).
 */
export function detectAnomalies({ entry, specStall, specReason, specState, timestamp }) {
  const found = [];
  const now = Date.parse(timestamp);
  if (specStall) {
    entry.stallSince ??= timestamp;
    if (now - Date.parse(entry.stallSince) >= STALL_ANOMALY_MS)
      found.push({ kind: "stall", signature: `stall:${entry.stallSince}`, summary: `no lane has worked for ${Math.round((now - Date.parse(entry.stallSince)) / 60_000)} min while spec items remain`, evidence: [specReason] });
  } else delete entry.stallSince;
  const counts = new Map();
  for (const alert of Array.isArray(entry.alerts) ? entry.alerts : []) {
    const text = String(alert?.text ?? "").slice(0, 300);
    if (text) counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  for (const [text, count] of counts)
    if (count >= 3) found.push({ kind: "repeated-alert", decision: true, signature: `alert:${text.slice(0, 120)}`, summary: `the same root alert was raised ${count} times`, evidence: [text] });
  for (const [id, record] of Object.entries(specState?.items ?? {})) {
    if (!record?.lane || !record.receiptPointedAt) continue;
    if (now - Date.parse(record.receiptPointedAt) >= RECEIPT_ANOMALY_MS)
      found.push({ kind: "receipt-missing", signature: `receipt:${id}:${record.lane.workflowId}`, summary: `${id}'s lane ${record.lane.workflowId} is still without a receipt ${Math.round((now - Date.parse(record.receiptPointedAt)) / 60_000)} min after the pointed ask`, evidence: [`state: ${record.state}`, record.receiptInferRequestedAt ? `inference requested at ${record.receiptInferRequestedAt}` : "no inference yet"] });
  }
  return found;
}
