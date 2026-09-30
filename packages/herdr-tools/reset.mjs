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
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { ownerRecord, reclaimLockDir } from "./inbox/lock-owner.mjs";
import { killLaneProcesses, laneProcesses, readProcessTable } from "./inbox/lane-processes.mjs";
import { removeFiles, workflowFiles } from "./housekeeping.mjs";

export const STATE_SUBPATH = ".baa-ton/herdr-orchestrator";
const MANIFEST_NAME = "manifest.json";
const WORKFLOW_FILE = /^herdr-[0-9a-f]{8}/;
const SCRATCH_FILE = /^claude-(?:settings|mcp)-[0-9a-f]{8}\.json$|^claude-lane-system-[0-9a-f]{8}\.md$/;
const MANIFEST_BACKUP = /^manifest\.json\.pre-/;
// Kept in the fresh manifest: the acknowledgment of the approval policy is the
// operator's standing consent, not run state.
const KEPT_MANIFEST_KEYS = ["approvalPolicyAck"];

const canonicalPath = (path) => {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { return absolute; }
};
function workflowRootIdentity(workflow, manifest) {
  const candidates = [
    workflow?.taskBinding && { paneId: workflow.taskBinding.rootPaneId, workspaceId: workflow.taskBinding.workspaceId },
    workflow?.eventControllerRegistration?.root && { paneId: workflow.eventControllerRegistration.root.pane_id, workspaceId: workflow.eventControllerRegistration.root.workspace_id },
    ...(manifest?.rootSessionLogs ?? []).filter((entry) => entry.kind === "root" && entry.workflowId === workflow?.id).map((entry) => ({ paneId: entry.paneId, workspaceId: entry.workspaceId })),
  ].filter((entry) => entry?.paneId && entry?.workspaceId);
  const unique = [...new Map(candidates.map((entry) => [`${entry.paneId}\0${entry.workspaceId}`, entry])).values()];
  return unique.length === 1 ? unique[0] : undefined;
}

/** Exact project-scoped route candidates; uncertain identity is a blocker. */
export function planControllerCleanup({ config, manifest, projectRoot, manifestPath, rootLiveness = {} } = {}) {
  const project = canonicalPath(projectRoot);
  const targetManifest = canonicalPath(manifestPath);
  const routes = [];
  const routeCandidates = [];
  const preservedRoutes = [];
  const roots = [];
  const rootCandidates = [];
  const blockers = [];
  const orchestrators = Array.isArray(config?.orchestrators) ? config.orchestrators : [];
  const flows = Array.isArray(manifest?.workflows) ? manifest.workflows : [];
  for (const orchestrator of orchestrators) {
    const program = orchestrator?.program ?? {};
    const programId = canonicalPath(program.id ?? "");
    const inScope = programId === project && canonicalPath(program.parent_manifest_path ?? "") === targetManifest;
    const root = orchestrator.root ?? {};
    const scopedRoutes = Array.isArray(orchestrator.workflows) ? orchestrator.workflows : [];
    const liveness = inScope ? rootLiveness[orchestrator.id] ?? "unknown" : "not-probed (different project/root identity)";
    const state = typeof liveness === "string" ? liveness : liveness.status ?? "unknown";
    const driftProven = inScope && state === "identity-drift" && liveness && typeof liveness === "object" && liveness.recoveryProof?.paneId === root.pane_id && liveness.recoveryProof?.workspaceId === root.workspace_id && liveness.recoveryProof?.expectedSessionId && liveness.recoveryProof?.observedSessionId;
    const targetRoutes = scopedRoutes.filter((route) => canonicalPath(route?.manifest_path ?? "") === targetManifest);
    const rootCandidate = { orchestratorId: orchestrator.id, inScope, programId, parentManifestPath: program.parent_manifest_path ? canonicalPath(program.parent_manifest_path) : undefined, rootPaneId: root.pane_id, rootWorkspaceId: root.workspace_id, liveness: state, routeCount: targetRoutes.length, action: "preserve" };
    rootCandidates.push(rootCandidate);
    for (const route of scopedRoutes) {
      const routePath = canonicalPath(route?.manifest_path ?? "");
      if (!inScope || routePath !== targetManifest) {
        preservedRoutes.push({ orchestratorId: orchestrator.id, workflowId: route.workflow_id, manifestPath: routePath, programId, rootPaneId: root.pane_id, rootWorkspaceId: root.workspace_id, reason: !inScope ? "different project/root identity" : "different manifest" });
      }
    }
    if (!inScope) continue;
    const livenessClear = ["live", "stale"].includes(state) || driftProven;
    if (targetRoutes.length && !livenessClear) {
      const reason = `root ${orchestrator.id} native pane/workspace/session liveness is ${state}`;
      blockers.push(`${reason}; scoped routes are left untouched`);
      for (const route of targetRoutes) routeCandidates.push({ orchestratorId: orchestrator.id, workflowId: route.workflow_id, manifestPath: targetManifest, programId, rootPaneId: root.pane_id, rootWorkspaceId: root.workspace_id, action: "blocked", reason });
      rootCandidate.action = "blocked";
      continue;
    }
    const removeRoutes = [];
    for (const route of targetRoutes) {
      const base = { orchestratorId: orchestrator.id, workflowId: route.workflow_id, manifestPath: targetManifest, programId, rootPaneId: root.pane_id, rootWorkspaceId: root.workspace_id };
      const routeMultiplicity = targetRoutes.filter((candidate) => candidate.workflow_id === route.workflow_id).length;
      if (routeMultiplicity !== 1) {
        const reason = `controller route id occurs ${routeMultiplicity} times`;
        blockers.push(`route ${orchestrator.id}/${route.workflow_id} ${reason}`);
        routeCandidates.push({ ...base, action: "blocked", reason });
        rootCandidate.action = "blocked";
        continue;
      }
      const matches = flows.filter((flow) => flow.id === route.workflow_id);
      if (matches.length !== 1) {
        const reason = `has ${matches.length} matching manifest workflows`;
        blockers.push(`route ${orchestrator.id}/${route.workflow_id} ${reason}`);
        routeCandidates.push({ ...base, action: "blocked", reason });
        rootCandidate.action = "blocked";
        continue;
      }
      const identity = workflowRootIdentity(matches[0], manifest);
      if (!identity) {
        const reason = "has no unique recorded root pane/workspace identity";
        blockers.push(`route ${orchestrator.id}/${route.workflow_id} ${reason}`);
        routeCandidates.push({ ...base, action: "blocked", reason });
        rootCandidate.action = "blocked";
        continue;
      }
      if (identity.paneId !== root.pane_id || identity.workspaceId !== root.workspace_id) {
        const reason = `root identity ${identity.paneId}/${identity.workspaceId} does not match controller root`;
        blockers.push(`route ${orchestrator.id}/${route.workflow_id} ${reason}`);
        routeCandidates.push({ ...base, action: "blocked", reason });
        rootCandidate.action = "blocked";
        continue;
      }
      const candidate = { ...base, action: "remove" };
      routeCandidates.push(candidate);
      routes.push(base);
      removeRoutes.push(route);
    }
    const remaining = scopedRoutes.filter((route) => !removeRoutes.includes(route));
    if (removeRoutes.length && remaining.length === 0 && state === "stale") {
      rootCandidate.action = "unregister (exactly stale)";
      roots.push({ orchestratorId: orchestrator.id, rootPaneId: root.pane_id, rootWorkspaceId: root.workspace_id, programId, liveness: state, routeCount: removeRoutes.length });
    } else if (removeRoutes.length && driftProven) rootCandidate.action = "recover identity drift; preserve live root";
    else if (removeRoutes.length && state === "live") rootCandidate.action = "preserve live root";
    else if (remaining.length) rootCandidate.action = "preserve root with other workflow routes";
  }
  return { routes, routeCandidates, preservedRoutes, roots, rootCandidates, blockers };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return value === undefined ? '"__undefined__"' : JSON.stringify(value);
}

export function resetFingerprint(plan) {
  return createHash("sha256").update(stable(plan)).digest("hex");
}

/** What a reset would do, from the manifest and the state folder listing. Pure. */
export function planReset(manifest, { stateDir, projectRoot = resolve(stateDir, "../.."), names = [], rootTabIds = new Set(), includeSpec = false, specStatePresent = false, controllerConfig, controllerConfigPath, rootLiveness = {}, processCandidates = [], identityDriftRecovery = [], sourceHashes = {}, currentRoot = {} } = {}) {
  const tabs = [];
  const worktrees = new Set();
  const intents = [];
  for (const workflow of manifest?.workflows ?? []) {
    for (const lane of workflow.lanes ?? []) {
      if (lane.tabId && !rootTabIds.has(lane.tabId)) tabs.push({ tabId: lane.tabId, paneId: lane.paneId, workspaceId: lane.workspaceId, workflowId: workflow.id, laneId: lane.id, status: lane.status });
      if (lane.startupIntentPath) intents.push({ workflowId: workflow.id, laneId: lane.id, intentPath: lane.startupIntentPath, paneId: lane.paneId, workspaceId: lane.workspaceId, tabId: lane.tabId });
    }
    for (const path of [workflow.worktree?.path, workflow.cwd]) if (typeof path === "string" && path.includes("worktree")) worktrees.add(path);
  }
  const files = new Set(names.filter((name) => WORKFLOW_FILE.test(name) || SCRATCH_FILE.test(name) || MANIFEST_BACKUP.test(name)).map((name) => join(stateDir, name)));
  for (const workflow of manifest?.workflows ?? []) for (const path of workflowFiles(workflow, stateDir)) files.add(path);
  const leaseCandidates = Array.isArray(manifest?.leases) ? manifest.leases.filter((lease) => !lease.releasedAt && lease.status !== "released").map((lease) => ({ id: lease.id, resource: lease.resource, label: lease.label, workflowId: lease.workflowId, laneId: lease.laneId })) : [];
  const leases = leaseCandidates.length;
  const manifestPath = join(stateDir, MANIFEST_NAME);
  const controller = controllerConfig ? planControllerCleanup({ config: controllerConfig, manifest, projectRoot, manifestPath, rootLiveness }) : { routes: [], routeCandidates: [], preservedRoutes: [], roots: [], rootCandidates: [], blockers: [] };
  return {
    targetManifest: { path: canonicalPath(manifestPath), version: manifest?.version, workflows: (manifest?.workflows ?? []).map((workflow) => ({ id: workflow.id, status: workflow.status, lanes: (workflow.lanes ?? []).map((lane) => ({ id: lane.id, status: lane.status, paneId: lane.paneId, workspaceId: lane.workspaceId, tabId: lane.tabId, startupIntentPath: lane.startupIntentPath })) })), controllerConfigPath, currentRoot },
    sourceHashes,
    workflows: manifest?.workflows?.length ?? 0,
    tabs,
    intents,
    processCandidates,
    leases,
    leaseCandidates,
    files: [...files].sort(),
    controllerRoutes: controller.routes,
    controllerRouteCandidates: controller.routeCandidates,
    controllerRoutesPreserved: controller.preservedRoutes,
    controllerRoots: controller.roots,
    controllerRootCandidates: controller.rootCandidates,
    identityDriftRecovery,
    blockers: controller.blockers,
    worktreesLeftAlone: [...worktrees],
    keeps: [".baa-ton/config.json, task profiles, approval policy and its acknowledgment", "spec.json", specStatePresent && !includeSpec ? "spec-state.json (progress)" : undefined, "operator registry", "live/concurrent roots and routes to other manifests", "worktrees and Git state"].filter(Boolean),
    clears: ["manifest workflows, queues, directives, goals and logs (archived first)", specStatePresent && includeSpec ? "spec-state.json (archived first)" : undefined].filter(Boolean),
  };
}

export function formatPlan(plan, { applied = false } = {}) {
  const head = applied ? "Baa-ton reset done." : "Baa-ton reset (dry run; nothing changed). Add --yes to apply.";
  const lines = [head, `Fingerprint: ${resetFingerprint(plan)}`, `Target manifest: ${plan.targetManifest?.path ?? "<unknown>"} (version ${plan.targetManifest?.version ?? "unknown"})`];
  for (const flow of plan.targetManifest?.workflows ?? []) {
    lines.push(`  workflow ${flow.id}: ${flow.status ?? "unknown"}`);
    for (const lane of flow.lanes ?? []) lines.push(`    lane ${lane.id}: ${lane.status ?? "unknown"} pane=${lane.paneId ?? "<none>"} workspace=${lane.workspaceId ?? "<none>"} tab=${lane.tabId ?? "<none>"} intent=${lane.startupIntentPath ?? "<none>"}`);
  }
  lines.push("Tabs to close:");
  lines.push(...(plan.tabs.length ? plan.tabs.map((tab) => `  ${tab.tabId} <- ${tab.workflowId}/${tab.laneId} (${tab.status ?? "unknown"})`) : ["  (none)"]));
  lines.push("Lane-owned process candidates:");
  lines.push(...(plan.processCandidates.length ? plan.processCandidates.map((process) => `  pid ${process.pid} ppid=${process.ppid}${process.createdAt ? ` created=${process.createdAt}` : ""} <- ${process.workflowId}/${process.laneId} intent=${process.intentPath}${process.command ? ` command=${process.command}` : ""}`) : ["  (none proven; Windows requires exact recorded pane PID + creation time)"]));
  lines.push("Controller workflow route inventory:");
  lines.push(...(plan.controllerRouteCandidates.length ? plan.controllerRouteCandidates.map((route) => `  ${route.orchestratorId}/${route.workflowId} manifest=${route.manifestPath} program=${route.programId} root=${route.rootPaneId}/${route.rootWorkspaceId} action=${route.action}${route.reason ? ` reason=${route.reason}` : ""}`) : ["  (none)"]));
  lines.push("Preserved controller routes (other manifests/concurrent roots):");
  lines.push(...(plan.controllerRoutesPreserved.length ? plan.controllerRoutesPreserved.map((route) => `  ${route.orchestratorId}/${route.workflowId} manifest=${route.manifestPath} program=${route.programId} root=${route.rootPaneId}/${route.rootWorkspaceId} reason=${route.reason}`) : ["  (none)"]));
  lines.push("Controller root inventory:");
  lines.push(...(plan.controllerRootCandidates.length ? plan.controllerRootCandidates.map((root) => `  ${root.orchestratorId} inScope=${root.inScope} program=${root.programId} parentManifest=${root.parentManifestPath ?? "<none>"} pane=${root.rootPaneId} workspace=${root.rootWorkspaceId} liveness=${root.liveness} action=${root.action}`) : ["  (none)"]));
  lines.push("Controller root records to unregister:");
  lines.push(...(plan.controllerRoots.length ? plan.controllerRoots.map((root) => `  ${root.orchestratorId} program=${root.programId} pane=${root.rootPaneId} workspace=${root.rootWorkspaceId} liveness=${root.liveness}`) : ["  (none)"]));
  lines.push("Identity-drift recovery candidates:");
  lines.push(...(plan.identityDriftRecovery.length ? plan.identityDriftRecovery.map((item) => `  ${JSON.stringify(item)}`) : ["  (none proven)"]));
  lines.push("Target manifest/state files to archive/delete:");
  lines.push(...(plan.files.length ? plan.files.map((file) => `  ${file}`) : ["  (none)"]));
  lines.push("Active leases to release:");
  lines.push(...(plan.leaseCandidates.length ? plan.leaseCandidates.map((lease) => `  ${lease.id ?? "<unknown>"} resource=${lease.resource ?? "<unknown>"} owner=${lease.workflowId ?? "<unknown>"}/${lease.laneId ?? "<unknown>"}${lease.label ? ` label=${lease.label}` : ""}`) : ["  (none)"]));
  lines.push(`Keep: ${plan.keeps.join("; ")}`, `Clear: ${plan.clears.join("; ")}`);
  if (plan.worktreesLeftAlone.length) lines.push(`Worktrees NOT touched: ${plan.worktreesLeftAlone.join(", ")}`);
  if (plan.blockers.length) lines.push("BLOCKERS (nothing will be applied):", ...plan.blockers.map((item) => `  ${item}`));
  return lines.join("\n");
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
    const info = nativeResult(run(["pane", "get", pane])).pane;
    if (info?.pane_id === pane && (!env.HERDR_WORKSPACE_ID || info.workspace_id === env.HERDR_WORKSPACE_ID) && info.tab_id) tabs.add(info.tab_id);
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

function parseNativeJson(output, label) {
  try { return JSON.parse(output); } catch { throw new Error(`Herdr ${label} returned invalid JSON.`); }
}

function controllerPathFor(env, run) {
  if (env.HERDR_CONTROLLER_CONFIG_PATH) return resolve(env.HERDR_CONTROLLER_CONFIG_PATH);
  if (env.HERDR_PLUGIN_CONFIG_DIR) return join(resolve(env.HERDR_PLUGIN_CONFIG_DIR), "config.json");
  if (!env.HERDR_PANE_ID) {
    if (env !== process.env) return undefined;
    const conventional = join(env.HOME || homedir(), ".config", "herdr", "plugins", "config", "herdr-orchestrator-controller", "config.json");
    return existsSync(conventional) ? conventional : undefined;
  }
  const output = run(["plugin", "config-dir", "herdr-orchestrator-controller"]).trim();
  let value;
  try { value = JSON.parse(output); } catch { value = output; }
  const result = value?.result ?? value;
  const directory = typeof result === "string" ? result : result?.config_dir;
  if (typeof directory !== "string" || !directory) throw new Error("Herdr controller config directory is unavailable; reset refused.");
  return join(resolve(directory), "config.json");
}

function nativeResult(output) {
  const value = JSON.parse(output);
  return value?.result ?? value;
}

function rootSessionRecord(manifest, orchestrator) {
  return (manifest?.rootSessionLogs ?? []).find((entry) => entry.kind === "root" && entry.rootId === orchestrator.id) ??
    (manifest?.rootSessionLogs ?? []).find((entry) => entry.kind === "root" && entry.paneId === orchestrator.root?.pane_id && entry.workspaceId === orchestrator.root?.workspace_id);
}

export function probeRootLiveness(orchestrator, manifest, run) {
  const root = orchestrator.root ?? {};
  const session = rootSessionRecord(manifest, orchestrator)?.sessionRef;
  const sessionId = session?.sessionId ?? session?.value;
  if (!root.pane_id || !root.workspace_id || !sessionId) return "ambiguous";
  let paneAbsent = false;
  try {
    const pane = nativeResult(run(["pane", "get", root.pane_id])).pane;
    if (pane?.pane_id !== root.pane_id || pane?.workspace_id !== root.workspace_id) return "ambiguous";
    const agents = nativeResult(run(["agent", "list"])).agents;
    if (!Array.isArray(agents)) return "ambiguous";
    const exact = agents.some((item) => item?.pane_id === root.pane_id && item?.workspace_id === root.workspace_id && item?.agent_session?.value === sessionId);
    if (exact) return "live";
    const drift = agents.find((item) => item?.pane_id === root.pane_id && item?.workspace_id === root.workspace_id && typeof item?.agent_session?.value === "string");
    return drift ? { status: "identity-drift", recoveryProof: { orchestratorId: orchestrator.id, paneId: root.pane_id, workspaceId: root.workspace_id, expectedSessionId: sessionId, observedSessionId: drift.agent_session.value } } : "ambiguous";
  } catch (error) {
    if (!/not.?found|no such|unknown pane/i.test(`${error.stdout ?? ""} ${error.stderr ?? ""} ${error.message}`)) return "ambiguous";
    paneAbsent = true;
  }
  let workspaces;
  let agents;
  try {
    workspaces = nativeResult(run(["workspace", "list"])).workspaces;
    agents = nativeResult(run(["agent", "list"])).agents;
  } catch { return "ambiguous"; }
  if (!paneAbsent || !Array.isArray(workspaces) || !Array.isArray(agents)) return "ambiguous";
  const workspaceLive = workspaces.some((item) => item.workspace_id === root.workspace_id);
  const sessionLive = agents.some((item) => item?.agent_session?.value === sessionId);
  return !workspaceLive && !sessionLive ? "stale" : "ambiguous";
}

function currentRootIdentity(env) {
  return {
    paneId: env.HERDR_PANE_ID,
    workspaceId: env.HERDR_WORKSPACE_ID,
    nativeSessionId: env.PI_SESSION_ID ?? env.CLAUDE_CODE_SESSION_ID ?? env.BAA_TON_SESSION_ID,
  };
}

function getRecordedPaneProcesses(lane, run, rows) {
  if (!lane.paneId || !lane.workspaceId) throw new Error(`lane ${lane.id} lacks an exact pane/workspace identity`);
  const pane = nativeResult(run(["pane", "get", lane.paneId])).pane;
  if (pane?.pane_id !== lane.paneId || pane?.workspace_id !== lane.workspaceId || (lane.tabId && pane?.tab_id !== lane.tabId))
    throw new Error(`lane ${lane.id} pane/workspace/tab identity could not be proved`);
  const info = nativeResult(run(["pane", "process-info", "--pane", lane.paneId])).process_info;
  if (!info || !Object.hasOwn(info, "shell_pid") || !Array.isArray(info.foreground_processes))
    throw new Error(`lane ${lane.id} pane process inventory is incomplete`);
  const listed = [info.shell_pid, ...info.foreground_processes.map((entry) => entry?.pid)];
  const pids = new Set();
  for (const value of listed) {
    const pid = Number(value);
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`lane ${lane.id} pane process inventory contains an invalid PID`);
    pids.add(pid);
  }
  const records = [];
  for (const pid of pids) {
    const matches = rows.filter((row) => row.pid === pid);
    if (matches.length !== 1) throw new Error(`lane ${lane.id} process PID ${pid} is ${matches.length ? "ambiguous" : "missing"} from the Windows CIM inventory`);
    const { createdAt } = matches[0];
    if (typeof createdAt !== "string" || !createdAt) throw new Error(`lane ${lane.id} process PID ${pid} creation time is unavailable`);
    records.push({ pid, createdAt });
  }
  return records;
}

function isProvablyAbsentTab(error, tabId) {
  const id = String(tabId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const absent = new RegExp(`^(?:tab(?:\\s+${id})?\\s+(?:not found|does not exist)|no such tab(?:\\s+${id})?|unknown tab(?:\\s+${id})?|tab_not_found)[.!]?$`, "i");
  return [error?.code, error?.stderr, error?.stdout, error?.message]
    .filter((value) => typeof value === "string")
    .some((value) => absent.test(value.trim().replace(/^Error:\s*/i, "")));
}

function readOptionalSpecState(path) {
  try { return readFileSync(path); }
  catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function applyControllerCleanup(config, plan) {
  const routes = new Set(plan.controllerRoutes.map((item) => `${item.orchestratorId}\0${item.workflowId}\0${item.manifestPath}\0${item.programId}\0${item.rootPaneId}\0${item.rootWorkspaceId}`));
  const roots = new Map(plan.controllerRoots.map((item) => [item.orchestratorId, item]));
  const orchestrators = [];
  for (const orchestrator of config.orchestrators ?? []) {
    const program = orchestrator.program ?? {};
    const root = orchestrator.root ?? {};
    const programId = canonicalPath(program.id ?? "");
    const matchingRoot = roots.get(orchestrator.id);
    if (matchingRoot && matchingRoot.liveness === "stale" && root.pane_id === matchingRoot.rootPaneId && root.workspace_id === matchingRoot.rootWorkspaceId && programId === matchingRoot.programId) continue;
    const workflows = (orchestrator.workflows ?? []).filter((route) => !routes.has(`${orchestrator.id}\0${route.workflow_id}\0${canonicalPath(route.manifest_path ?? "")}\0${programId}\0${root.pane_id}\0${root.workspace_id}`));
    orchestrators.push({ ...orchestrator, workflows });
  }
  return { ...config, orchestrators };
}

async function withControllerLock(configPath, wait, work) {
  if (!configPath) return work();
  const lock = `${configPath}.lock`;
  const deadline = Date.now() + wait;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), configPath })}\n`, { mode: 0o600 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw new Error(`Herdr controller config is busy: ${configPath}; nothing was changed.`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try { return await work(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

/**
 * Apply a reset. The displayed plan is fingerprinted and re-read before any
 * destructive action; --yes never opens a confirmation prompt.
 */
export async function runReset({
  projectRoot,
  apply = false,
  includeSpec = false,
  expectedFingerprint,
  env = process.env,
  now = Date.now(),
  closeTab,
  rootTabIds: suppliedRootTabIds,
  killLane,
  controllerConfigPath: suppliedConfigPath,
  probeRoot = probeRootLiveness,
  processTable = (platform) => readProcessTable({ platform }),
  platform = process.platform,
  runHerdr = (args) => herdr(args, env),
  identityDriftRecovery = [],
  lockWaitMs = 10_000,
} = {}) {
  const project = canonicalPath(projectRoot ?? process.cwd());
  const stateDir = join(project, STATE_SUBPATH);
  const manifestPath = join(stateDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return { plan: planReset({ workflows: [] }, { stateDir, projectRoot: project }), applied: false, note: `no orchestrator state under ${stateDir}` };
  const firstRootTabs = suppliedRootTabIds ? new Set(suppliedRootTabIds) : rootTabs(env, runHerdr);
  if (apply && env.HERDR_PANE_ID && !firstRootTabs.size)
    throw new Error("Cannot tell which tab holds this root, so nothing was applied.");
  const configPath = suppliedConfigPath ? resolve(suppliedConfigPath) : controllerPathFor(env, runHerdr);
  const rootTabsNow = () => suppliedRootTabIds ? new Set(suppliedRootTabIds) : rootTabs(env, runHerdr);
  const readManifest = () => readFileSync(manifestPath, "utf8");
  const readConfig = () => {
    if (!configPath) return { bytes: undefined, value: undefined };
    if (!existsSync(configPath)) return { bytes: undefined, value: undefined, blocker: `controller config is missing at ${configPath}` };
    try {
      const info = lstatSync(configPath);
      if (!info.isFile() || info.isSymbolicLink()) return { bytes: undefined, value: undefined, blocker: `controller config is not a regular non-symlink file: ${configPath}` };
      const bytes = readFileSync(configPath, "utf8");
      const value = JSON.parse(bytes);
      if (!value || value.version !== 2 || value.owner !== "herdr-orchestrator" || !Array.isArray(value.orchestrators))
        return { bytes, value, blocker: `controller config is not a validated version-2 orchestrator document: ${configPath}` };
      return { bytes, value };
    } catch (error) {
      return { bytes: undefined, value: undefined, blocker: `controller config cannot be read: ${error.message}` };
    }
  };
  const inventory = async () => {
    const manifestBytes = readManifest();
    const manifest = JSON.parse(manifestBytes);
    const controller = readConfig();
    const specStatePath = join(stateDir, "spec-state.json");
    const specStateBytes = readOptionalSpecState(specStatePath);
    const roots = {};
    const driftProofs = [...identityDriftRecovery];
    for (const orchestrator of controller.value?.orchestrators ?? []) {
      const program = orchestrator.program ?? {};
      if (canonicalPath(program.id ?? "") !== project || canonicalPath(program.parent_manifest_path ?? "") !== canonicalPath(manifestPath)) continue;
      const state = await probeRoot(orchestrator, manifest, runHerdr);
      roots[orchestrator.id] = state;
      if (state?.recoveryProof) driftProofs.push(state.recoveryProof);
    }
    let rows = [];
    const processCandidates = [];
    const processRecords = new Map();
    const processBlockers = [];
    const hasIntents = (manifest.workflows ?? []).some((flow) => (flow.lanes ?? []).some((lane) => lane.startupIntentPath));
    if (hasIntents) {
      try { rows = await processTable(platform); }
      catch (error) { processBlockers.push(`process inventory unavailable: ${error.message}`); }
      for (const flow of manifest.workflows ?? []) for (const lane of flow.lanes ?? []) {
        if (!lane.startupIntentPath) continue;
        let recordedProcesses = [];
        if (platform === "win32") {
          try { recordedProcesses = getRecordedPaneProcesses(lane, runHerdr, rows); }
          catch (error) { processBlockers.push(`processes for ${flow.id}/${lane.id}: ${error.message}`); continue; }
          processRecords.set(`${flow.id}/${lane.id}`, recordedProcesses);
        }
        const candidates = laneProcesses(rows, lane.startupIntentPath, { recordedProcesses });
        for (const process of candidates) processCandidates.push({ pid: process.pid, ppid: process.ppid, createdAt: process.createdAt, command: process.line.split(/\s+/)[0].split(/[\\/]/).pop(), workflowId: flow.id, laneId: lane.id, intentPath: lane.startupIntentPath });
      }
    }
    const rootTabIds = rootTabsNow();
    const sourceHashes = {
      manifest: createHash("sha256").update(manifestBytes).digest("hex"),
      ...(controller.bytes !== undefined ? { controllerConfig: createHash("sha256").update(controller.bytes).digest("hex") } : {}),
      ...(specStateBytes !== undefined ? { specState: createHash("sha256").update(specStateBytes).digest("hex") } : {}),
    };
    const plan = planReset(manifest, {
      stateDir, projectRoot: project, names: readdirSync(stateDir), rootTabIds, includeSpec,
      specStatePresent: specStateBytes !== undefined, controllerConfig: controller.value,
      controllerConfigPath: configPath, rootLiveness: roots, processCandidates, identityDriftRecovery: driftProofs,
      sourceHashes, currentRoot: currentRootIdentity(env),
    });
    if (controller.blocker) plan.blockers.push(controller.blocker);
    plan.blockers.push(...processBlockers);
    return { plan, manifest, manifestBytes, controller: controller.value, controllerBytes: controller.bytes, specStateBytes, processRecords, rootTabIds };
  };

  const initial = await inventory();
  const plan = initial.plan;
  const fingerprint = resetFingerprint(plan);
  if (!apply) return { plan, fingerprint, applied: false };
  if (expectedFingerprint && expectedFingerprint !== fingerprint)
    throw new Error(`Reset preview fingerprint changed (expected ${expectedFingerprint}, current ${fingerprint}); nothing was applied.`);
  if (plan.blockers.length)
    throw new Error(`Reset inventory is ambiguous; nothing was applied:\n${plan.blockers.map((item) => `  ${item}`).join("\n")}`);
  if (env.HERDR_PANE_ID && !initial.rootTabIds.size)
    throw new Error("Cannot tell which tab holds this root, so nothing was applied.");

  // Immediately before the first mutation, re-read the complete planned state,
  // controller routes, native root liveness, root tab and process identities.
  const verified = await inventory();
  const verifiedFingerprint = resetFingerprint(verified.plan);
  if (verifiedFingerprint !== fingerprint)
    throw new Error(`Reset inventory changed after preview (planned ${fingerprint}, current ${verifiedFingerprint}); nothing was applied.`);
  if (verified.plan.blockers.length) throw new Error(`Reset inventory became ambiguous; nothing was applied: ${verified.plan.blockers.join("; ")}`);

  const close = closeTab ?? ((tabId) => runHerdr(["tab", "close", tabId]));
  const stopLane = killLane ?? ((lane, recordedProcesses, expectedPids) => killLaneProcesses({ intentPath: lane.intentPath, recordedProcesses, expectedPids, platform }));
  const failures = [];
  for (const lane of plan.intents) {
    try {
      const expectedPids = plan.processCandidates.filter((candidate) => candidate.workflowId === lane.workflowId && candidate.laneId === lane.laneId).map((candidate) => candidate.pid).sort((a, b) => a - b);
      const result = await stopLane(lane, initial.processRecords.get(`${lane.workflowId}/${lane.laneId}`) ?? [], expectedPids);
      if (result?.survivors?.length) failures.push(`processes for ${lane.workflowId}/${lane.laneId} survived: ${result.survivors.join(", ")}`);
      if (Array.isArray(result?.signalled)) {
        const actualPids = result.signalled.map((candidate) => candidate.pid).sort((a, b) => a - b);
        if (actualPids.join(",") !== expectedPids.join(",")) failures.push(`process inventory changed for ${lane.workflowId}/${lane.laneId}: planned=[${expectedPids}] observed=[${actualPids}]`);
      }
    } catch (error) { failures.push(`processes for ${lane.workflowId}/${lane.laneId}: ${error.message}`); }
  }
  if (failures.length) throw new Error(`Reset process cleanup is incomplete; state was not archived or cleared:\n${failures.map((item) => `  ${item}`).join("\n")}`);
  for (const tab of plan.tabs) {
    try { await close(tab.tabId); }
    catch (error) {
      if (isProvablyAbsentTab(error, tab.tabId)) continue;
      throw new Error(`Reset could not close tab ${tab.tabId}; durable state was not archived or cleared: ${String(error.message ?? error).split("\n")[0]}`);
    }
  }

  // Before clearing durable state, confirm the root pane/tab/session proof is
  // still the one shown in the inventory. A changed native identity leaves
  // the manifest and routes intact, even if lane tabs were already stopped.
  const latestRootTabs = rootTabsNow();
  if (stable([...latestRootTabs].sort()) !== stable([...initial.rootTabIds].sort()))
    throw new Error("Current root tab identity changed during reset; durable state was not cleared.");
  for (const orchestrator of initial.controller?.orchestrators ?? []) {
    const program = orchestrator.program ?? {};
    if (canonicalPath(program.id ?? "") !== project || canonicalPath(program.parent_manifest_path ?? "") !== canonicalPath(manifestPath)) continue;
    const expected = plan.controllerRootCandidates.find((candidate) => candidate.orchestratorId === orchestrator.id)?.liveness;
    let observed;
    try { observed = await probeRoot(orchestrator, initial.manifest, runHerdr); }
    catch { observed = "ambiguous"; }
    const status = typeof observed === "string" ? observed : observed?.status ?? "ambiguous";
    const expectedProof = plan.identityDriftRecovery.find((proof) => proof.orchestratorId === orchestrator.id);
    if (status !== expected || stable(observed?.recoveryProof) !== stable(expectedProof))
      throw new Error(`Controller root ${orchestrator.id} identity/liveness changed during reset; durable state was not cleared.`);
  }

  const stamp = new Date(now).toISOString().replaceAll(":", "").replace(/\..*/, "");
  const specStatePath = join(stateDir, "spec-state.json");
  const assertSpecStateUnchanged = () => {
    const current = readOptionalSpecState(specStatePath);
    const planned = initial.specStateBytes;
    if ((current === undefined) !== (planned === undefined) || (current && !current.equals(planned)))
      throw new Error("spec-state.json content changed before reset commit; preview again. The file was not archived, deleted or overwritten.");
    return current;
  };
  await withLock(stateDir, lockWaitMs, () => withControllerLock(configPath, lockWaitMs, async () => {
    const currentManifestBytes = readManifest();
    const currentController = readConfig();
    assertSpecStateUnchanged();
    if (currentManifestBytes !== initial.manifestBytes || currentController.bytes !== initial.controllerBytes)
      throw new Error("Manifest or controller config changed before reset commit; preview again. No manifest/config reset was applied.");
    const currentManifest = JSON.parse(currentManifestBytes);
    const archive = join(stateDir, "archive");
    assertSpecStateUnchanged();
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    writeFileSync(join(archive, `reset-${stamp}.manifest.json.gz`), gzipSync(currentManifestBytes), { mode: 0o600 });
    if (configPath && (plan.controllerRoutes.length || plan.controllerRoots.length)) {
      const next = applyControllerCleanup(currentController.value, plan);
      if (next.orchestrators.length) {
        const temporary = `${configPath}.${process.pid}.reset.tmp`;
        writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        renameSync(temporary, configPath);
      } else rmSync(configPath);
    }
    const fresh = { version: 2, workflows: [], ...Object.fromEntries(KEPT_MANIFEST_KEYS.filter((key) => currentManifest[key] !== undefined).map((key) => [key, currentManifest[key]])) };
    const temporary = `${manifestPath}.reset.tmp`;
    writeFileSync(temporary, `${JSON.stringify(fresh, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, manifestPath);
    if (includeSpec && initial.specStateBytes !== undefined) {
      const specArchive = join(archive, `reset-${stamp}.spec-state.json.gz`);
      assertSpecStateUnchanged();
      writeFileSync(specArchive, gzipSync(initial.specStateBytes), { mode: 0o600, flag: "wx" });
      try {
        assertSpecStateUnchanged();
        rmSync(specStatePath);
      } catch (error) {
        rmSync(specArchive, { force: true });
        throw error;
      }
    }
  }));
  removeFiles(plan.files);
  return { plan, fingerprint, applied: true, failures };
}
