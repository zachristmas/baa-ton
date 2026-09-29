/**
 * `baa-ton reset`: a clean slate for one project's orchestrator state.
 *
 * Closes every lane tab, releases every lease, archives the whole manifest and
 * starts a fresh one, and deletes the per-lane files and launch scratch the old
 * runs left. It keeps configuration (task profiles, the approval policy and its
 * acknowledgment, the spec and, unless asked, its progress), the operator
 * registry, the controller and the root pane itself. It never touches Git,
 * worktrees or branches: those are listed so they can go through the confirmed
 * sweep or a human. Dry-run unless applied.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { ownerRecord, reclaimLockDir } from "./inbox/lock-owner.mjs";
import { killLaneProcesses } from "./inbox/lane-processes.mjs";
import { removeFiles, workflowFiles } from "./housekeeping.mjs";

export const STATE_SUBPATH = ".baa-ton/herdr-orchestrator";
const MANIFEST_NAME = "manifest.json";
const WORKFLOW_FILE = /^herdr-[0-9a-f]{8}/;
const SCRATCH_FILE = /^claude-(?:settings|mcp)-[0-9a-f]{8}\.json$|^claude-lane-system-[0-9a-f]{8}\.md$/;
const MANIFEST_BACKUP = /^manifest\.json\.pre-/;
// Kept in the fresh manifest: the acknowledgment of the approval policy is the
// operator's standing consent, not run state.
const KEPT_MANIFEST_KEYS = ["approvalPolicyAck"];

/** What a reset would do, from the manifest and the state folder listing. Pure. */
export function planReset(manifest, { stateDir, names = [], rootTabIds = new Set(), includeSpec = false, specStatePresent = false } = {}) {
  const tabs = [];
  const worktrees = new Set();
  const intents = [];
  for (const workflow of manifest?.workflows ?? []) {
    for (const lane of workflow.lanes ?? []) {
      if (lane.tabId && !rootTabIds.has(lane.tabId)) {
        tabs.push({ tabId: lane.tabId, workflowId: workflow.id, laneId: lane.id, status: lane.status });
      }
      if (lane.startupIntentPath) intents.push(lane.startupIntentPath);
    }
    for (const path of [workflow.worktree?.path, workflow.cwd]) if (typeof path === "string" && path.includes("worktree")) worktrees.add(path);
  }
  const files = new Set(names.filter((name) => WORKFLOW_FILE.test(name) || SCRATCH_FILE.test(name) || MANIFEST_BACKUP.test(name)).map((name) => join(stateDir, name)));
  for (const workflow of manifest?.workflows ?? []) for (const path of workflowFiles(workflow, stateDir)) files.add(path);
  const leases = Array.isArray(manifest?.leases) ? manifest.leases.filter((lease) => !lease.releasedAt && lease.status !== "released").length : 0;
  return {
    workflows: manifest?.workflows?.length ?? 0,
    tabs,
    intents,
    leases,
    files: [...files],
    worktreesLeftAlone: [...worktrees],
    keeps: ["config and task profiles", "approval policy and its acknowledgment", "spec.json", specStatePresent && !includeSpec ? "spec-state.json (progress)" : undefined, "operator registry", "the root pane"].filter(Boolean),
    clears: ["manifest workflows, queue, directives, goals and logs (archived first)", specStatePresent && includeSpec ? "spec-state.json (archived first)" : undefined].filter(Boolean),
  };
}

export function formatPlan(plan, { applied = false } = {}) {
  const head = applied ? "Baa-ton reset done." : "Baa-ton reset (dry run; nothing changed). Add --yes to apply.";
  return [
    head,
    `  close ${plan.tabs.length} lane tab(s), release ${plan.leases} lease(s), archive ${plan.workflows} workflow(s)`,
    `  delete ${plan.files.length} state file(s)`,
    `  keep: ${plan.keeps.join("; ")}`,
    `  clear: ${plan.clears.join("; ")}`,
    plan.worktreesLeftAlone.length ? `  worktrees NOT touched (${plan.worktreesLeftAlone.length}); use the confirmed herdr_sweep for those` : undefined,
  ].filter(Boolean).join("\n");
}

function herdr(args, env) {
  return execFileSync(env.HERDR_BIN_PATH || "herdr", args, { encoding: "utf8" });
}

/** Tabs that hold the root itself, which a reset must never close. */
export function rootTabs(env = process.env, run = (args) => herdr(args, env)) {
  const tabs = new Set();
  const pane = env.HERDR_PANE_ID;
  if (!pane) return tabs;
  try {
    const tabId = JSON.parse(run(["pane", "get", pane]))?.result?.pane?.tab_id;
    if (tabId) tabs.add(tabId);
  } catch {
    // Unknown: the caller refuses to close anything it cannot exclude.
  }
  return tabs;
}

async function withLock(stateDir, wait, work) {
  const lock = join(stateDir, `.${MANIFEST_NAME}.herdr-orchestrator.lock`);
  const deadline = Date.now() + wait;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, "owner.json"), `${JSON.stringify(ownerRecord())}\n`, { mode: 0o600 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await reclaimLockDir(lock).catch(() => false)) continue;
      if (Date.now() > deadline) throw new Error("the manifest is busy (a live controller or root holds its lock); nothing was changed");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Apply a reset. Order: stop lanes, then (under the manifest lock) archive the
 * old manifest and write the fresh one, then delete files. Nothing is deleted
 * before the archive is on disk.
 */
export async function runReset({
  projectRoot,
  apply = false,
  includeSpec = false,
  env = process.env,
  now = Date.now(),
  closeTab = (tabId) => herdr(["tab", "close", tabId], env),
  rootTabIds = rootTabs(env),
  killLane = (intentPath) => killLaneProcesses({ intentPath }),
  lockWaitMs = 10_000,
} = {}) {
  const stateDir = join(projectRoot, STATE_SUBPATH);
  const manifestPath = join(stateDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return { plan: planReset({ workflows: [] }, { stateDir }), applied: false, note: `no orchestrator state under ${stateDir}` };
  const read = () => JSON.parse(readFileSync(manifestPath, "utf8"));
  const specStatePresent = existsSync(join(stateDir, "spec-state.json"));
  const names = readdirSync(stateDir);
  const plan = planReset(read(), { stateDir, names, rootTabIds, includeSpec, specStatePresent });
  if (!apply) return { plan, applied: false };
  if (env.HERDR_PANE_ID && !rootTabIds.size) throw new Error("cannot tell which tab holds this root, so nothing was closed; run the reset from outside Herdr or fix `herdr pane get`");

  const failures = [];
  for (const path of plan.intents) await killLane(path).catch((error) => failures.push(`processes for ${path}: ${error.message}`));
  for (const tab of plan.tabs) {
    try {
      closeTab(tab.tabId);
    } catch (error) {
      // Already closed is the common case (retired lanes); anything else is reported, not fatal.
      // Herdr reports a missing tab as JSON on stdout, which execFileSync keeps off `message`.
      const detail = `${error.stdout ?? ""} ${error.stderr ?? ""} ${error.message}`;
      if (!/not.?found|no such|unknown tab/i.test(detail)) failures.push(`tab ${tab.tabId}: ${String(error.message).split("\n")[0]}`);
    }
  }

  const stamp = new Date(now).toISOString().replaceAll(":", "").replace(/\..*/, "");
  await withLock(stateDir, lockWaitMs, () => {
    const current = read();
    const archive = join(stateDir, "archive");
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    writeFileSync(join(archive, `reset-${stamp}.manifest.json.gz`), gzipSync(JSON.stringify(current)), { mode: 0o600 });
    const fresh = { version: 2, workflows: [], ...Object.fromEntries(KEPT_MANIFEST_KEYS.filter((key) => current[key] !== undefined).map((key) => [key, current[key]])) };
    const temporary = `${manifestPath}.reset.tmp`;
    writeFileSync(temporary, `${JSON.stringify(fresh, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, manifestPath);
    if (includeSpec && specStatePresent) {
      const spec = join(stateDir, "spec-state.json");
      writeFileSync(join(archive, `reset-${stamp}.spec-state.json.gz`), gzipSync(readFileSync(spec)), { mode: 0o600 });
      rmSync(spec);
    }
  });
  removeFiles(plan.files);
  return { plan, applied: true, failures };
}
