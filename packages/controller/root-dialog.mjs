/**
 * A root stuck in its own question dialog. Herdr can report a dialog-bound
 * Pi root as working, and a root on older extension code has no in-process
 * default, so nothing would ever answer. On the supervisor tick, while the
 * root is working or blocked, the controller reads the root's visible screen
 * at most once per ROOT_DIALOG_READ_EVERY_MS. A question dialog that is
 * still open after ROOT_DIALOG_DEFAULT_MS in an autonomous run (a spec file
 * plus an acknowledged policy) gets its Recommended option: arrow keys, then
 * Enter, after re-checking that the same dialog is on screen. Questions about
 * push, deploy, production or new scope, and dialogs without exactly one
 * Recommended option, are never answered; the user is notified once.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { autoAnswerPlan } from "../herdr-tools/root-question.mjs";
import { classifyScreen, readScreen, recordUnattendedDecision, sendKeys } from "./blocked-lane.mjs";

export const ROOT_DIALOG_READ_EVERY_MS = 5 * 60_000;
/** A minute after the in-process default (5 min), so a current root answers first. */
export const ROOT_DIALOG_DEFAULT_MS = 6 * 60_000;

const WAITING = new Set(["working", "blocked"]);

/** A spec loop under an acknowledged policy: defaults may answer for the root. */
export function autonomousRun(manifest, manifestPath) {
  return Boolean(manifest?.approvalPolicyAck) && existsSync(join(dirname(dirname(manifestPath)), "spec.json"));
}

/** Keys that move the cursor from the selected option to `target`, then choose it. */
export function keysToOption(options, target) {
  const from = Math.max(0, options.findIndex((option) => option.selected));
  const to = options.findIndex((option) => option.number === target);
  if (to < 0) return undefined;
  return [...Array(Math.abs(to - from)).fill(to > from ? "down" : "up"), "enter"];
}

async function rootStatus(herdr, paneId) {
  try {
    const result = await herdr.request("agent.get", { target: paneId });
    const info = result?.result ?? result;
    return info?.type === "agent_info" && info.agent?.pane_id === paneId ? info.agent.agent_status : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One tick for one root. `entry` is the root's rootSupervision record.
 * Returns { changed, action? }.
 */
export async function superviseRootDialog({ orchestrator, manifest, manifestPath, entry, herdr, notify = async () => undefined, timestamp }) {
  const paneId = orchestrator.root?.pane_id;
  // Only an autonomous run needs this (a person watches any other root),
  // and never more than one status check and one read per interval.
  if (!paneId || !autonomousRun(manifest, manifestPath)) return { changed: false };
  const now = Date.parse(timestamp);
  const record = entry.rootDialog;
  const due = record?.seenAt && !record.appliedAt && now - Date.parse(record.seenAt) >= ROOT_DIALOG_DEFAULT_MS;
  if (record?.lastReadAt && now - Date.parse(record.lastReadAt) < ROOT_DIALOG_READ_EVERY_MS && !due) return { changed: false };
  const status = await rootStatus(herdr, paneId);
  if (!WAITING.has(status)) {
    entry.rootDialog = { lastReadAt: timestamp };
    return { changed: true };
  }
  let screen;
  try {
    screen = classifyScreen(await readScreen(herdr, paneId, paneId));
  } catch {
    return { changed: false };
  }
  if (screen.kind !== "question") {
    entry.rootDialog = { lastReadAt: timestamp };
    return { changed: true };
  }
  if (record?.fingerprint !== screen.fingerprint) {
    entry.rootDialog = { fingerprint: screen.fingerprint, question: screen.question.slice(0, 300), seenAt: timestamp, lastReadAt: timestamp };
    return { changed: true, action: "seen" };
  }
  record.lastReadAt = timestamp;
  if (!due) return { changed: true };
  const tellOnce = async (why) => {
    if (record.notifiedAt) return { changed: true };
    record.notifiedAt = timestamp;
    await notify({ title: "Baa-ton: the root waits on a question", body: `${orchestrator.id}: "${screen.question.slice(0, 200)}" is open; ${why}` });
    return { changed: true, action: "notified" };
  };
  if (/[☐☒].*[☐☒]/.test(screen.question)) return tellOnce("it has several questions; answer it by hand.");
  const plan = autoAnswerPlan({ questions: [{ question: screen.question, options: screen.options.filter((option) => !option.freeText).map((option) => option.label) }] });
  if (!plan.eligible) return tellOnce(`not answered automatically: ${plan.reason}.`);
  const clean = (label) => label.replace(/\s*\((?:recommended)\)\s*/i, " ").trim().toLowerCase();
  const option = screen.options.find((item) => !item.freeText && clean(item.label) === plan.answers[0].answer.toLowerCase());
  const keys = option ? keysToOption(screen.options, option.number) : undefined;
  if (!keys) return tellOnce("the Recommended option could not be located on screen.");
  // Right before the keys: still waiting, and the same dialog.
  if (!WAITING.has(await rootStatus(herdr, paneId))) return { changed: true };
  let again;
  try {
    again = classifyScreen(await readScreen(herdr, paneId, paneId));
  } catch {
    return { changed: true };
  }
  if (again.fingerprint !== screen.fingerprint) {
    delete entry.rootDialog;
    return { changed: true };
  }
  try {
    await sendKeys(herdr, paneId, keys);
  } catch (error) {
    record.appliedAt = timestamp;
    record.error = error instanceof Error ? error.message : String(error);
    return { changed: true, action: "send-failed" };
  }
  record.appliedAt = timestamp;
  record.answer = option.label;
  recordUnattendedDecision(manifest, { at: timestamp, kind: "root-dialog", rootId: orchestrator.id, question: screen.question.slice(0, 300), decision: option.label, reason: `open ${Math.round(ROOT_DIALOG_DEFAULT_MS / 60_000)} min in an autonomous run; took the Recommended option` });
  await notify({ title: "Baa-ton: root question auto-answered", body: `${orchestrator.id}: "${screen.question.slice(0, 160)}" -> ${option.label}` });
  return { changed: true, action: "answered", keys };
}
