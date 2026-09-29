/**
 * Unattended housekeeping for a root's orchestrator state: archive finished
 * workflows out of the live manifest, delete the per-lane files they leave
 * behind, and prune launch scratch no live process uses. Nothing here touches
 * Git, worktrees or a live lane. Pure selection lives here so it is testable;
 * the root applies it inside a manifest transaction (index.ts).
 */
import { appendFileSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const HOUR = 60 * 60_000;
export const HOUSEKEEPING_DEFAULTS = {
  /** A finished workflow stays in the live manifest this long. */
  archiveMinAgeMs: 48 * HOUR,
  /** The newest finished workflows always stay, however old, for debugging. */
  keepRecent: 100,
  /** Launch scratch (settings, MCP config, system prompt) no live process names. */
  scratchMinAgeMs: 24 * HOUR,
};

const FINISHED_WORKFLOW_STATUSES = new Set(["completed", "superseded", "operator-closed", "dispatch-failed"]);
const FINISHED_LANE_STATUSES = new Set(["done", "completion-reported", "gone", "planned", "superseded", "operator-closed"]);
const WORKFLOW_ID = /herdr-[0-9a-f]{8}/g;
const SCRATCH_FILE = /^claude-(?:settings|mcp)-[0-9a-f]{8}\.json$|^claude-lane-system-[0-9a-f]{8}\.md$/;

/** Every workflow id mentioned anywhere in the given values (objects or text). */
export function mentionedWorkflowIds(...values) {
  const found = new Set();
  for (const value of values) {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
    for (const match of text.matchAll(WORKFLOW_ID)) found.add(match[0]);
  }
  return found;
}

const TERMINAL_SPEC_STATES = new Set(["done", "resolved", "skipped"]);

/**
 * Workflow ids the spec driver can still act on: unfinished items (without their
 * history, whose free-text notes mention every past workflow) and the driver's
 * own gates. Finished items keep no live pointer.
 */
export function liveSpecWorkflowIds(specState) {
  const { items = {}, decisions: _decisions, baselines: _baselines, ...gates } = specState ?? {};
  const open = Object.values(items)
    .filter((item) => !TERMINAL_SPEC_STATES.has(item?.state))
    .map(({ history: _history, ...rest }) => rest);
  return mentionedWorkflowIds(open, gates);
}

/**
 * Workflows with nothing left to run: a finished status, every lane finished,
 * and every lane that had a tab retired or gone. `protectedIds` are the ones
 * something else still points at (the spec driver, the queue, directives).
 */
function recordedWorktreeExists(path) {
  if (typeof path !== "string" || !path) return false;
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    // Permission and other inspection failures fail closed: keep the record so
    // cleanup sweep can inspect it rather than orphaning a possibly live path.
    return !["ENOENT", "ENOTDIR"].includes(error?.code);
  }
}

export function archivableWorkflows(manifest, { now = Date.now(), protectedIds = new Set(), worktreeExists = recordedWorktreeExists, ...overrides } = {}) {
  const { archiveMinAgeMs, keepRecent } = { ...HOUSEKEEPING_DEFAULTS, ...overrides };
  const finished = [];
  for (const workflow of manifest?.workflows ?? []) {
    if (!FINISHED_WORKFLOW_STATUSES.has(workflow.status) || protectedIds.has(workflow.id)) continue;
    if (worktreeExists(workflow.worktree)) continue;
    const updated = Date.parse(workflow.updatedAt ?? workflow.createdAt ?? "");
    if (!Number.isFinite(updated) || now - updated < archiveMinAgeMs) continue;
    const settled = (workflow.lanes ?? []).every((lane) => {
      if (!FINISHED_LANE_STATUSES.has(lane.status)) return false;
      const retirement = lane.retirement?.status;
      return retirement === "retired" || lane.status === "gone" || lane.status === "superseded" || !lane.tabId;
    });
    if (settled) finished.push({ id: workflow.id, updated });
  }
  finished.sort((a, b) => b.updated - a.updated);
  return new Set(finished.slice(keepRecent).map((entry) => entry.id));
}

/** Files under `stateDir` that a workflow's lanes recorded (startup intents and their ready markers). */
export function workflowFiles(workflow, stateDir) {
  const prefix = `${stateDir}/`;
  const files = new Set();
  const walk = (value) => {
    if (typeof value === "string") {
      if (value.startsWith(prefix) && !value.slice(prefix.length).includes("/")) {
        files.add(value);
        files.add(`${value}.ready`);
      }
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(workflow);
  return [...files];
}

/**
 * Launch scratch old enough to go, which no running process names on its
 * command line (a live Claude may re-read its MCP config on reconnect).
 */
export function staleScratch({ names, now = Date.now(), mtimeOf, liveCommandLines = [], ...overrides }) {
  const { scratchMinAgeMs } = { ...HOUSEKEEPING_DEFAULTS, ...overrides };
  const live = liveCommandLines.join("\n");
  return names.filter((name) => {
    if (!SCRATCH_FILE.test(name) || live.includes(name)) return false;
    const modified = mtimeOf(name);
    return Number.isFinite(modified) && now - modified >= scratchMinAgeMs;
  });
}

/** Append workflows to `<dir>/archive/workflows-YYYY-MM.jsonl` before they leave the manifest; throws on failure so the caller keeps them. */
export function writeArchive(stateDir, workflows, now = Date.now()) {
  if (!workflows.length) return undefined;
  const directory = join(stateDir, "archive");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `workflows-${new Date(now).toISOString().slice(0, 7)}.jsonl`);
  appendFileSync(path, workflows.map((workflow) => `${JSON.stringify({ archivedAt: new Date(now).toISOString(), workflow })}\n`).join(""), { mode: 0o600 });
  return path;
}

export function removeFiles(paths) {
  let removed = 0;
  for (const path of paths) {
    try {
      rmSync(path);
      removed += 1;
    } catch {
      // Already gone.
    }
  }
  return removed;
}

export function scratchNames(stateDir) {
  try {
    return readdirSync(stateDir).filter((name) => SCRATCH_FILE.test(name));
  } catch {
    return [];
  }
}

export function mtimeIn(stateDir) {
  return (name) => {
    try {
      return statSync(join(stateDir, name)).mtimeMs;
    } catch {
      return Number.NaN;
    }
  };
}

/** A list capped for a tool result, with what was left out counted. */
export function capList(items, limit = 15) {
  const list = Array.isArray(items) ? items : [];
  return { items: list.slice(0, limit), total: list.length, omitted: Math.max(0, list.length - limit) };
}

/** Repeated messages counted once: [{ text, count, sample }]. */
export function groupBy(items, key) {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const text = String(key(item));
    const entry = groups.get(text) ?? { text, count: 0 };
    entry.count += 1;
    groups.set(text, entry);
  }
  return [...groups.values()];
}
