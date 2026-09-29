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
/** Only alerts this recent count toward a repeat; older ones are history. */
export const REPEAT_WINDOW_MS = 6 * 60 * 60_000;
/** One item's lane launch failing this many times in a row is an anomaly on its own (two items with one cause is at once). */
export const LAUNCH_FAILURES_BEFORE_ANOMALY = 3;
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
  // Some anomalies are about the channel itself (lane-admin, or the root,
  // can not receive its messages): the user is told at once, once.
  if (anomaly.notifyUser && (result.status === "new" || result.status === "unrouted")) {
    await notify({ title: anomaly.notifyTitle ?? "Baa-ton anomaly", body: `${anomaly.summary}`.slice(0, 400) });
  }
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
 * Operator messages that can not be delivered: pending for at least
 * UNDELIVERABLE_MS for a persistent reason (no live agent in the pane, a bare
 * shell, an unreachable pane), never merely a busy agent. One anomaly per
 * target and reason; the message to lane-admin may itself be one of the
 * undeliverable ones, so the user is notified directly.
 */
export async function detectUndeliverable({ store, timestamp }) {
  const { undeliverableMessages } = await operator();
  const now = Date.parse(timestamp);
  return undeliverableMessages(store, { now }).map((group) => ({
    kind: "operator-undeliverable",
    decision: true,
    notifyUser: true,
    notifyTitle: "Baa-ton: operator messages are stuck",
    signature: `undeliverable:${group.label}:${group.reason}`,
    summary: `${group.ids.length} operator message(s) to ${group.label} have been undeliverable for ${Math.round((now - group.since) / 60_000)} min: ${group.reason}`,
    evidence: [`messages: ${group.ids.slice(0, 8).join(", ")}${group.ids.length > 8 ? ` and ${group.ids.length - 8} more` : ""}`, `reason: ${group.reason}`, "check the target's registration (baa-ton operator agents) and the live pane (herdr agent get <pane>)"],
  }));
}

const STALL_FINISHED = new Set(["done", "resolved", "deferred"]);

/**
 * Why a stalled spec is stalled, from what the state already records for
 * each unfinished item: its current note (the driver's last error or hold),
 * its blocked reason, its last infrastructure failure, else its last history
 * line. Grouped by cause, biggest first, so the anomaly names what to fix
 * (a 17-hour stall said only "16 items are waiting").
 */
export function stallBlockers(specState, { max = 5 } = {}) {
  const groups = new Map();
  const lines = [];
  // A target sync that failed its suite gate holds every push and integration
  // behind it until the target moves; say so first.
  const failedSync = specState?.syncRun?.failed;
  if (failedSync) {
    const fresh = (failedSync.fresh ?? []).map((failure) => `${failure.package} ${failure.task}`).slice(0, 4).join(", ");
    lines.push(`target sync failed its suite gate${fresh ? ` (new failures: ${fresh})` : ""}: pushes and integrations wait until the target moves or the failures are fixed on spec-integration`);
  }
  for (const [id, record] of Object.entries(specState?.items ?? {})) {
    if (!record || STALL_FINISHED.has(record.state)) continue;
    // The decline that still holds the item (cleared when it moves on), not
    // the newest one in its history: that one can be hours stale.
    const infra = record.declined && (record.declined.kind === "infrastructure" || record.declined.kind === "never started") ? record.declined : undefined;
    const line = (text) => String(text ?? "").split("\n").map((part) => part.trim()).find(Boolean);
    const reason =
      line(record.note) ??
      (record.blockedReason ? `blocked (${record.blockedReason})` : undefined) ??
      line(infra?.reason) ??
      (record.lane ? "a lane is assigned but not working" : undefined) ??
      line(record.history?.at(-1)?.note);
    if (!reason) continue;
    const key = reason.replace(/\bherdr-[0-9a-f]+\b/gi, "").replace(/\bw\d*[A-Za-z]*:p[0-9A-Za-z]+\b/g, "").replace(/\b[A-Z]\d{2}\b/g, "").replace(/[0-9a-f]{12,}/g, "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 100);
    const group = groups.get(key) ?? { reason: reason.slice(0, 160), ids: [] };
    group.ids.push(id);
    groups.set(key, group);
  }
  return [...lines, ...[...groups.values()]
    .sort((a, b) => b.ids.length - a.ids.length)
    .slice(0, max)
    .map((group) => `${group.ids.length} item(s): ${group.reason} (${group.ids.slice(0, 4).join(", ")}${group.ids.length > 4 ? `, +${group.ids.length - 4}` : ""})`)];
}

/**
 * Anomalies visible in one root's manifest and spec state on a supervisor
 * tick: a stall of STALL_ANOMALY_MS or more, a root alert repeated three or
 * more times within REPEAT_WINDOW_MS (while its item is still blocked), and a lane still without a receipt RECEIPT_ANOMALY_MS after
 * the driver's pointed ask. `entry` is the root's rootSupervision record
 * (stallSince is kept there).
 */
export function detectAnomalies({ entry, specStall, specReason, specState, timestamp }) {
  const found = [];
  const now = Date.parse(timestamp);
  if (specStall) {
    entry.stallSince ??= timestamp;
    if (now - Date.parse(entry.stallSince) >= STALL_ANOMALY_MS)
      found.push({ kind: "stall", signature: `stall:${entry.stallSince}`, summary: `no lane has worked for ${Math.round((now - Date.parse(entry.stallSince)) / 60_000)} min while spec items remain`, evidence: [specReason, ...stallBlockers(specState).map((line) => `blocker: ${line}`)] });
  } else delete entry.stallSince;
  // A repeat is current: raised within REPEAT_WINDOW_MS, and, for an alert
  // about a spec item ("D02: ..."), only while that item is still blocked.
  // The alert list is kept as history, so older ones would fire forever.
  const counts = new Map();
  for (const alert of Array.isArray(entry.alerts) ? entry.alerts : []) {
    const text = String(alert?.text ?? "").slice(0, 300);
    if (!text) continue;
    const created = Date.parse(alert?.createdAt ?? "");
    if (!Number.isFinite(created) || now - created > REPEAT_WINDOW_MS) continue;
    const itemId = /^([A-Za-z][\w.-]{0,31}):\s/.exec(text)?.[1];
    const item = itemId ? specState?.items?.[itemId] : undefined;
    if (item && item.state !== "blocked") continue;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  for (const [text, count] of counts)
    if (count >= 3) found.push({ kind: "repeated-alert", decision: true, signature: `alert:${text.slice(0, 120)}`, summary: `the same root alert was raised ${count} times`, evidence: [text] });
  // A push the driver could not make: the full git error, not a truncated
  // ask. One anomaly per commit pushed; it recurs (after a fix) by count.
  const failure = specState?.pushFailure;
  if (failure?.sha && failure.error && specState.items && Object.values(specState.items).some((record) => record?.state === "awaiting-push"))
    found.push({
      kind: "push-failed",
      signature: `push-failed:${String(failure.sha).slice(0, 12)}:${failure.count ?? 1}`,
      summary: `the spec driver's push of ${String(failure.sha).slice(0, 12)} (${(failure.items ?? []).join(", ")}) failed ${failure.count ?? 1} time(s) since ${failure.at}; items wait in awaiting-push`,
      evidence: String(failure.error).split("\n").filter(Boolean).slice(-12),
    });
  // Lanes that can not launch, for the same reason, again and again: silent
  // infrastructure retries (the driver retries and only counts them) hid a
  // harness that could not start review lanes for four hours.
  const causes = new Map();
  for (const [id, record] of Object.entries(specState?.items ?? {})) {
    if (!record || ["done", "resolved", "deferred"].includes(record.state) || !(record.infraFailures >= 1)) continue;
    const last = [...(Array.isArray(record.declines) ? record.declines : [])].reverse().find((entry) => entry?.kind === "infrastructure" || entry?.kind === "never started");
    if (!last?.reason) continue;
    const at = Date.parse(last.at ?? "");
    if (!Number.isFinite(at) || now - at > REPEAT_WINDOW_MS) continue;
    const key = String(last.reason).replace(/^lane \S+ (?:was planned but never launched: |dispatch-failed:? ?)/i, "").replace(/\b(?:herdr|w|p)-?[0-9a-f:]{4,}\b/gi, "").replace(/[0-9]+/g, "#").replace(/\s+/g, " ").trim().slice(0, 100);
    const group = causes.get(key) ?? { reason: String(last.reason).slice(0, 300), items: [] };
    group.items.push({ id, stage: last.stage, failures: record.infraFailures });
    causes.set(key, group);
  }
  for (const [key, group] of causes) {
    const worst = Math.max(...group.items.map((item) => item.failures));
    if (group.items.length < 2 && worst < LAUNCH_FAILURES_BEFORE_ANOMALY) continue;
    found.push({
      kind: "launch-failing",
      decision: true,
      signature: `launch-failing:${key}`,
      summary: `${group.items.length} spec item(s) can not launch lanes for the same reason: ${group.reason.slice(0, 160)}`,
      evidence: [...group.items.slice(0, 8).map((item) => `${item.id}: ${item.stage ?? "lane"} launch failed ${item.failures} time(s)`), `reason: ${group.reason}`, "the driver only retries these as infrastructure errors; check the harness and the stage's task profile (herdr_setup / baa-ton-configure)"],
    });
  }
  for (const [id, record] of Object.entries(specState?.items ?? {})) {
    if (!record?.lane || !record.receiptPointedAt) continue;
    // A failed, done or held item waits on no receipt.
    if (["failed", "done", "blocked"].includes(record.state)) continue;
    if (now - Date.parse(record.receiptPointedAt) >= RECEIPT_ANOMALY_MS)
      found.push({ kind: "receipt-missing", signature: `receipt:${id}:${record.lane.workflowId}`, summary: `${id}'s lane ${record.lane.workflowId} is still without a receipt ${Math.round((now - Date.parse(record.receiptPointedAt)) / 60_000)} min after the pointed ask`, evidence: [`state: ${record.state}`, record.receiptInferRequestedAt ? `inference requested at ${record.receiptInferRequestedAt}` : "no inference yet"] });
  }
  return found;
}
