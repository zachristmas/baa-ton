import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { setTimeout as lockRetryDelay } from "node:timers/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { blocksUnmanagedAgentCommand } from "./command-policy.js";
import { ConfirmQueue } from "./confirm-queue.js";
import { resolvePiSessionIdentity, registerPiIdentityBridge } from "./pi-session-identity.mjs";
import {
  AUTHORIZATION_CAPABILITIES,
  SUPPORTED_AGENT_KINDS,
  toPersistenceHandle,
  type AgentKind,
  type ApprovalRequest,
  type AuthorizationCapability,
  type AuthorizationDecision,
  type AuthorizationPolicy,
  type AutonomousOperation,
  type ControllerConfig,
  type ControllerLaneMapping,
  type ControllerOrchestrator,
  type ControllerRootMapping,
  type ControllerWorkflowMapping,
  type EventControllerRegistration,
  type ExecResult,
  type GoalOutcome,
  type GoalRecord,
  type GoalStatus,
  type GoalResumeReceipt,
  type Lane,
  type LaneInput,
  type Manifest,
  type MessageRecord,
  type NativeSessionRef,
  type ParentGoal,
  type ParentGoalStatus,
  type ParentQuestionRequest,
  type PersistenceHandle,
  type RootTurn,
  type SessionLogEntry,
  type SessionLogStatus,
  type WorktreeBinding,
  type Workflow,
} from "./contract.js";

export type {
  GoalOwnership,
  OperatorClosure,
} from "./contract.js";
import {
  dispatchTask,
  laneSlug,
  resumeTask,
} from "./dispatch-task.js";
import {
  LAUNCH_PROFILE_SCHEMA_VERSION,
  type LaunchProfile,
  type LaunchProfileVersion,
  validateLaunchProfile,
} from "./launch-profile.js";
import {
  piLaunchAdapter,
  verifyActualProfile,
  mapPiToolNamesToProtocolOperations,
} from "./pi-launch-adapter.js";
import { claudeLaunchAdapter } from "./claude-launch-adapter.js";
import { codexLaunchAdapter } from "./codex-launch-adapter.js";
import { opencodeLaunchAdapter } from "./opencode-launch-adapter.js";
import {
  HarnessAdapterRegistry,
  STARTUP_PROOF_REQUIRED_OPERATIONS,
} from "./harness-adapter.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acknowledgeActivation } from "./activation-ack.mjs";
import { loadTaskProfileConfig, resolveTaskProfile } from "./profile-config.mjs";
import {
  authorizeStanding,
  approvalPolicySummary,
  validateApprovalPolicy,
  approvalPolicyHash,
  type ApprovalPolicyAck,
  type StandingOperation,
  type StandingResult,
} from "./approval-policy.js";
import {
  activeLeases,
  allocateLease,
  ledgerConflicts,
  leaseLines,
  leaseValue,
  probePort,
  releaseLeases,
  validateRuntimeConfig,
  type Lease,
} from "./leases.js";
import {
  matchRuntimeCommand,
  openRequests,
  requestKey,
  requestPayload,
  requestSummary,
  retireStopCommands,
  type LaneRequest,
  type LaneRequestKind,
} from "./lane-requests.js";
import { rootRecoveryPlan, recoveryHash, readRecoveryFiles, assertNoPendingRecovery, commitRootRecovery } from "./root-recovery.mjs";
import {
  applyHerdrIdentity,
  currentAppliedHerdrIdentity,
  resolveHerdrIdentity,
} from "./live-identity.mjs";
import { legacyStateStatus } from "./state-migration.mjs";
import { classifyLocalValidation } from "./known-safe.mjs";
import {
  SPEC_PATH,
  SPEC_STATE_PATH,
  loadSpec,
  loadSpecState,
  specStatusTable,
  targetRepo,
  validateSpecState,
  verifySpec,
} from "./spec.mjs";
import { advanceSpec, buildObjective, reviewObjective } from "./spec-driver.mjs";

// routeChildMessage lives in the controller package, which is a sibling of
// this package inside the baa-ton checkout. Pi may load this extension
// through the ~/.pi/agent/extensions symlink, and that loader does not
// resolve symlinks before resolving relative imports (the 4f8b38c lesson:
// extensions must stay loadable across their symlink). Resolve from the
// realpath of this module so the import works in both contexts.
async function importRouteChildMessage() {
  const fromRealPath = new URL(
    "../controller/controller.mjs",
    pathToFileURL(realpathSync(fileURLToPath(import.meta.url))),
  );
  const fromSpecifier = new URL("../controller/controller.mjs", import.meta.url);
  for (const candidate of [fromRealPath, fromSpecifier]) {
    try {
      return (await import(fileURLToPath(candidate))) as typeof import("../controller/controller.mjs");
    } catch {
      continue;
    }
  }
  throw new Error(
    "Cannot load the controller package for child-message routing; the baa-ton checkout layout is unavailable from this extension path.",
  );
}

const {
  routeChildMessage,
  sampleCapacity,
  loadedCode,
  recordRuntime,
  listRuntime,
  codeFingerprint,
  gitCommit,
  describeIdleServices,
  idleLaneServices,
  isHarnessCommand,
  paneServiceProcesses,
  parseProcessIdentity,
} = await importRouteChildMessage();
// What this process loaded, captured once: herdr_doctor compares it (and the
// other running pieces' records) with the checkout on disk.
const LOADED_CODE = loadedCode();

const MANIFEST_DIR = ".baa-ton/herdr-orchestrator";
const MANIFEST_NAME = "manifest.json";
const OWNER = "herdr-orchestrator";
const BB029_AUTHORIZATION_SCOPE = "BB-029";
const HERDR_COMMAND_TIMEOUT_MS = 35_000;
const execFile = promisify(execFileCallback);
const RECENT_AGENT_OUTPUT_LINES = 120;
const GOAL_PAUSE_OUTPUT_LIMIT = 6000;
const MESSAGE_SUMMARY_MAX_LENGTH = 4000;
const MESSAGE_DETAILS_MAX_LENGTH = 6000;
const MESSAGE_DEDUPE_WINDOW_MS = 60_000;
const RECENT_MESSAGE_WINDOW_MS = 86_400_000;
const HERDR_PANE_ID_ENV = "HERDR_PANE_ID";
const HERDR_PLUGIN_CONFIG_DIR_ENV = "HERDR_PLUGIN_CONFIG_DIR";
const CONTROLLER_PLUGIN_ID = "herdr-orchestrator-controller";
const CONTROLLER_CONFIG_NAME = "config.json";
const SCOPED_GOALS_SCHEMA_VERSION = 1 as const;
const GOAL_HISTORY_SCHEMA_VERSION = 1 as const;
const ROOT_GOALS_SCHEMA_VERSION = 1 as const;
const ROOT_QUEUES_SCHEMA_VERSION = 1 as const;
const QUEUE_SCHEMA_VERSION = 1 as const;
const QUEUE_DEDUPE_WINDOW_MS = 60_000;
const QUEUE_ITEM_STATES = [
  "pending",
  "dispatched",
  "verified",
  "landed",
  "dropped",
] as const;
type QueueItemState = (typeof QUEUE_ITEM_STATES)[number];
type QueueItem = {
  version: typeof QUEUE_SCHEMA_VERSION;
  id: string;
  objective: string;
  notes?: string;
  files: string[];
  after: string[];
  state: QueueItemState;
  createdAt: string;
  updatedAt: string;
  workflowId?: string;
  evidence?: string;
};
type QueueStore = {
  version: typeof QUEUE_SCHEMA_VERSION;
  items: QueueItem[];
};
type RootParentGoal = ParentGoal & {
  rootId: string;
  root: ControllerRootMapping;
};
type RootGoalStore = Record<string, RootParentGoal>;
type RootGoalRecord = {
  rootId: string;
  root: ControllerRootMapping;
  goal?: RootParentGoal;
  goalHistory: GoalHistoryRecord[];
};
type RootSessionLogEntry = SessionLogEntry & {
  rootId: string;
  root: ControllerRootMapping;
};
type RootQueueRecord = {
  version: typeof ROOT_QUEUES_SCHEMA_VERSION;
  rootId: string;
  root: ControllerRootMapping;
  itemIds: string[];
};
type RootQueueStore = {
  version: typeof ROOT_QUEUES_SCHEMA_VERSION;
  roots: RootQueueRecord[];
};
type ManifestWithRootState = ManifestWithGoalHistory & {
  queue?: QueueStore;
  parentGoals?: RootGoalStore;
  goalHistoryByRoot?: Record<string, GoalHistoryRecord[]>;
  rootSessionLogs?: RootSessionLogEntry[];
  rootQueues?: RootQueueStore;
};
type ManifestWithQueue = ManifestWithRootState;
type QueueBlockers = {
  dependencies: Array<{ id: string; state?: QueueItemState }>;
  files: Array<{ itemId: string; files: string[] }>;
};
type QueueReadiness = {
  item: QueueItem | undefined;
  blockers: QueueBlockers;
};
type GoalHistoryRecord = ParentGoal & {
  version: typeof GOAL_HISTORY_SCHEMA_VERSION;
  archivedAt: string;
  force?: boolean;
  reason?: string;
};
type ManifestWithGoalHistory = Manifest & {
  goalHistory?: GoalHistoryRecord[];
  /** The standing approvalPolicy hash the root has confirmed once. */
  approvalPolicyAck?: ApprovalPolicyAck;
  /** Runtime lease ledger; active entries never share a port or name. */
  leases?: Lease[];
  /** Directives to a root; open until the root acknowledges them. */
  directives?: RootDirective[];
  /** Controller-owned per-root capacity gate, alerts and watchdog state. */
  rootSupervision?: RootSupervision[];
};
type CapacityGate = {
  id: string;
  status: "waiting" | "cleared" | "cancelled";
  reason: string;
  minFreeMemoryGb?: number;
  maxSwapUsedGb?: number;
  maxLoadPerCpu?: number;
  createdAt: string;
  clearedAt?: string;
  cancelledAt?: string;
  escalatedAt?: string;
  sample?: Record<string, number>;
  escalation?: { status: string; reason?: string };
};
type RootSupervision = {
  rootId: string;
  /** 2: the goal's nudge interval was chosen under the repeating-nudge policy. */
  nudgeIntervalPolicy?: 2;
  capacityGate?: CapacityGate;
  alerts?: unknown[];
  watchdog?: Record<string, unknown>;
};
type RootDirective = {
  id: string;
  rootId: string;
  from: string;
  text: string;
  createdAt: string;
  status: "open" | "acked";
  sends?: number;
  sentAt?: string;
  delivery?: { status: string; attempts?: number; updatedAt: string; reason?: string };
  escalatedAt?: string;
  escalation?: { status: string; reason?: string };
  ackedAt?: string;
  ackNote?: string;
};
type ParentGoalActionResult =
  | { goal: ParentGoal; goalHistoryCount: number }
  | {
      reset: true;
      archivedGoalId: string;
      historyLength: number;
    };
const now = () => new Date().toISOString();
const manifestPath = (cwd: string) => join(cwd, MANIFEST_DIR, MANIFEST_NAME);
const jsonText = (value: unknown) => JSON.stringify(value, null, 2);
const clip = (text: string, limit = 6000) =>
  text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;

async function runDirectGit(
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await execFile("git", args, {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      signal,
      timeout: HERDR_COMMAND_TIMEOUT_MS,
    });
    return result.stdout.trim();
  } catch (error) {
    const failure = error as {
      message?: unknown;
      stderr?: unknown;
      stdout?: unknown;
    };
    const detail =
      typeof failure.stderr === "string" && failure.stderr.trim()
        ? failure.stderr.trim()
        : typeof failure.stdout === "string" && failure.stdout.trim()
          ? failure.stdout.trim()
          : typeof failure.message === "string"
            ? failure.message
            : String(error);
    throw new Error(`git ${args.join(" ")} failed: ${clip(detail, 1600)}`);
  }
}

async function rootBootstrapPrompt(cwd: string): Promise<string> {
  if (!isRootOrchestrator()) return "";
  const manifest = await loadManifest(cwd);
  const scope = currentRootScope(cwd);
  const scoped = scope ? rootGoalFor(manifest, cwd, scope).goal : undefined;
  const goal = scope ? scoped : manifest.parentGoal;
  const rootGoal = goal
    ? `${goal.status}: ${clip(goal.objective, 4000)} Next: ${clip(goal.nextAction, 1000)}`
    : "No registered parent goal.";
  const active = manifest.workflows
    .filter((workflow) => workflow.status !== "closed")
    .map((workflow) => ({
      id: workflow.id,
      status: workflow.status,
      lanes: workflow.lanes.length,
    }));
  return `\n\nHerdr parent-root bootstrap: you are the sole parent executor. Registered parent goal: ${rootGoal}. Herdr's durable manifest at ${manifestPath(cwd)} is authoritative; current workflows: ${jsonText(active)}. You may use herdr_plan, herdr_dispatch, herdr_observe, herdr_resume, and herdr_close only through their documented parent/root paths. Treat controller-delivered lane lifecycle, child-message, parent-question-required, parent-approval-required, and blocker records as durable work signals: read the record and continue through safe local actions under existing authorization. Persist a truthful state when waiting for an external event, blocked, paused, or complete; do not stop merely because one tool or parent action finished. Never ask the user to operate a child pane or Pi goal UI; children persist requests and Herdr wakes you. Do not poll or create detached agents. Do not push, merge, create PRs, deploy, mutate production, or close resources without explicit user approval.`;
}

function pausedGoalIds(output: string): string[] {
  const goalIds = new Set<string>();
  for (const line of clip(output, GOAL_PAUSE_OUTPUT_LIMIT).split(/\r?\n/)) {
    if (!/\bpaus(?:e|ed|ing)\b/i.test(line)) continue;
    for (const match of line.matchAll(/\bpi-goal-[a-z0-9][a-z0-9_-]*\b/gi))
      goalIds.add(match[0].toLowerCase());
  }
  return [...goalIds].sort((left, right) => left.localeCompare(right));
}

function goalStatus(value: unknown, fallback: GoalStatus): GoalStatus {
  return typeof value === "string" &&
    ["planned", "ready", "running", "blocked", "completed", "paused"].includes(
      value,
    )
    ? (value as GoalStatus)
    : fallback;
}

function goalOutcome(value: unknown, fallback: GoalOutcome): GoalOutcome {
  return typeof value === "string" &&
    ["unresolved", "success", "failure", "cancelled"].includes(value)
    ? (value as GoalOutcome)
    : fallback;
}

function normalizeWorkflowGoals(workflow: Workflow): Workflow {
  if (!Array.isArray(workflow.lanes)) return workflow;
  const rootGoalId =
    typeof workflow.rootGoalId === "string" && workflow.rootGoalId
      ? workflow.rootGoalId
      : `goal-${workflow.id}`;
  const existing = Array.isArray(workflow.goals) ? workflow.goals : [];
  const byId = new Map(
    existing
      .filter(
        (goal): goal is GoalRecord =>
          isRecord(goal) && typeof goal.id === "string",
      )
      .map((goal) => [goal.id, goal]),
  );
  const timestamp =
    typeof workflow.updatedAt === "string" && workflow.updatedAt
      ? workflow.updatedAt
      : now();
  const rootExisting = byId.get(rootGoalId);
  const root: GoalRecord = {
    version: 1,
    id: rootGoalId,
    revision:
      typeof rootExisting?.revision === "number" &&
      Number.isSafeInteger(rootExisting.revision) &&
      rootExisting.revision > 0
        ? rootExisting.revision
        : 1,
    dependencies: Array.isArray(rootExisting?.dependencies)
      ? rootExisting.dependencies.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    objective: workflow.objective,
    status: goalStatus(rootExisting?.status, "planned"),
    outcome: goalOutcome(rootExisting?.outcome, "unresolved"),
    ownership: {
      scope: "workflow",
      workflowId: workflow.id,
      authority: "authorized-root",
    },
    updatedAt: rootExisting?.updatedAt ?? timestamp,
  };
  const laneGoals: GoalRecord[] = [];
  for (const lane of workflow.lanes) {
    if (lane.nativeSession && !lane.persistenceHandle) {
      lane.persistenceHandle = toPersistenceHandle(
        lane.nativeSession,
        lane.launchProfile?.provider ??
          workflow.launchProfile?.provider ??
          lane.agentKind ??
          workflow.agentKind ??
          "herdr",
      );
    }
    // Migrate manifests that already have the durable provider identity but
    // predate the session-log field. The identity is never reconstructed from
    // a pane/tab alias; only existing persistence evidence is adopted.
    if (lane.persistenceHandle && !lane.sessionLog) {
      const laneStatus =
        lane.completionReceipt ||
        lane.status === "completion-reported" ||
        lane.status === "completed" ||
        lane.status === "operator-closed"
          ? "completed"
          : lane.status === "planned"
            ? "planned"
            : "dispatched";
      lane.sessionLog = {
        kind: "lane",
        sessionRef: lane.persistenceHandle,
        startedAt:
          lane.agentStartedAt ??
          lane.incarnationStartedAt ??
          workflow.dispatchedAt ??
          workflow.createdAt,
        status: laneStatus,
        workflowId: workflow.id,
        laneId: lane.id,
        ...(lane.paneId ? { paneId: lane.paneId } : {}),
        ...(lane.tabId ? { tabId: lane.tabId } : {}),
        ...(workflow.ownership.workspaceId
          ? { workspaceId: workflow.ownership.workspaceId }
          : {}),
        ...(workflow.worktree ? { worktree: workflow.worktree } : {}),
      };
    }
    const goalId =
      typeof lane.goalId === "string" && lane.goalId
        ? lane.goalId
        : `${rootGoalId}/${lane.id}`;
    const existingGoal = byId.get(goalId);
    const explicitSuccess = Boolean(lane.completionReceipt);
    const revision =
      typeof existingGoal?.revision === "number" &&
      Number.isSafeInteger(existingGoal.revision) &&
      existingGoal.revision > 0
        ? existingGoal.revision
        : Number.isSafeInteger(lane.goalRevision) && lane.goalRevision! > 0
          ? lane.goalRevision!
          : 1;
    const dependencies = Array.isArray(lane.dependencies)
      ? lane.dependencies.filter(
          (item): item is string => typeof item === "string",
        )
      : Array.isArray(existingGoal?.dependencies)
        ? existingGoal.dependencies.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
    const goal: GoalRecord = {
      version: 1,
      id: goalId,
      revision,
      parentId: rootGoalId,
      dependencies,
      objective: lane.objective,
      status: explicitSuccess
        ? "completed"
        : goalStatus(existingGoal?.status, "planned"),
      outcome: explicitSuccess
        ? "success"
        : goalOutcome(existingGoal?.outcome, "unresolved"),
      ownership: {
        scope: "lane",
        workflowId: workflow.id,
        laneId: lane.id,
        authority: "lane",
      },
      updatedAt: existingGoal?.updatedAt ?? timestamp,
    };
    lane.goalId = goal.id;
    lane.goalRevision = goal.revision;
    lane.dependencies = goal.dependencies;
    lane.goalOwnership = goal.ownership;
    if (lane.launchProfile && lane.launchProfileVersion === undefined)
      lane.launchProfileVersion = LAUNCH_PROFILE_SCHEMA_VERSION;
    laneGoals.push(goal);
  }
  workflow.goalSchemaVersion = SCOPED_GOALS_SCHEMA_VERSION;
  workflow.rootGoalId = rootGoalId;
  workflow.goals = [root, ...laneGoals];
  if (workflow.launchProfile && workflow.launchProfileVersion === undefined)
    workflow.launchProfileVersion = LAUNCH_PROFILE_SCHEMA_VERSION;
  return workflow;
}

function queueStore(value: unknown, label = "manifest.queue"): QueueStore {
  if (Array.isArray(value)) {
    // Accept the early array-only draft in memory; all new writes use the
    // versioned wrapper so the queue schema can evolve independently.
    value = { version: QUEUE_SCHEMA_VERSION, items: value };
  }
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  if (value.version !== QUEUE_SCHEMA_VERSION)
    throw new Error(`${label}.version must be ${QUEUE_SCHEMA_VERSION}.`);
  if (!Array.isArray(value.items))
    throw new Error(`${label}.items must be an array.`);
  const ids = new Set<string>();
  const items = value.items.map((raw, index) => {
    const itemLabel = `${label}.items[${index}]`;
    if (!isRecord(raw)) throw new Error(`${itemLabel} must be an object.`);
    const allowed = new Set([
      "version",
      "id",
      "objective",
      "notes",
      "files",
      "after",
      "state",
      "createdAt",
      "updatedAt",
      "workflowId",
      "evidence",
    ]);
    for (const key of Object.keys(raw))
      if (!allowed.has(key)) throw new Error(`${itemLabel}.${key} is not allowed.`);
    if (raw.version !== QUEUE_SCHEMA_VERSION)
      throw new Error(`${itemLabel}.version must be ${QUEUE_SCHEMA_VERSION}.`);
    if (
      typeof raw.id !== "string" ||
      !/^queue-[0-9a-f]{8}$/i.test(raw.id)
    )
      throw new Error(`${itemLabel}.id must match queue-<8hex>.`);
    if (ids.has(raw.id)) throw new Error(`Duplicate queue item ID: ${raw.id}.`);
    ids.add(raw.id);
    if (typeof raw.objective !== "string" || !raw.objective.trim())
      throw new Error(`${itemLabel}.objective must be non-empty.`);
    if ("notes" in raw && typeof raw.notes !== "string")
      throw new Error(`${itemLabel}.notes must be a string when present.`);
    if (
      !Array.isArray(raw.files) ||
      raw.files.some((file) => typeof file !== "string" || !file.trim())
    )
      throw new Error(`${itemLabel}.files must contain non-empty strings.`);
    if (
      !Array.isArray(raw.after) ||
      raw.after.some((dependency) => typeof dependency !== "string" || !dependency)
    )
      throw new Error(`${itemLabel}.after must contain queue item IDs.`);
    if (!QUEUE_ITEM_STATES.includes(raw.state as QueueItemState))
      throw new Error(`${itemLabel}.state is invalid.`);
    for (const key of ["createdAt", "updatedAt"])
      if (typeof raw[key] !== "string" || !raw[key])
        throw new Error(`${itemLabel}.${key} must be a non-empty string.`);
    if ("workflowId" in raw && typeof raw.workflowId !== "string")
      throw new Error(`${itemLabel}.workflowId must be a string when present.`);
    if ("evidence" in raw && typeof raw.evidence !== "string")
      throw new Error(`${itemLabel}.evidence must be a string when present.`);
    return raw as unknown as QueueItem;
  });
  for (const item of items)
    for (const dependency of item.after)
      if (!ids.has(dependency))
        throw new Error(`Queue item ${item.id} depends on unknown item ${dependency}.`);
  return { version: QUEUE_SCHEMA_VERSION, items };
}

function queueForManifest(
  manifest: ManifestWithQueue,
  create = false,
): QueueStore | undefined {
  if (!("queue" in manifest) || manifest.queue === undefined) {
    if (!create) return undefined;
    manifest.queue = { version: QUEUE_SCHEMA_VERSION, items: [] };
    return manifest.queue;
  }
  const normalized = queueStore(manifest.queue);
  // Normalize an array-only draft when a writer touches the manifest.
  manifest.queue = normalized;
  return normalized;
}

function queuePathKey(cwd: string, file: string): string {
  return resolve(cwd, file);
}

function queueReadiness(
  manifest: ManifestWithQueue,
  candidate: QueueItem | undefined,
  cwd: string,
  visibleIds?: Set<string>,
): QueueReadiness {
  const blockers: QueueBlockers = { dependencies: [], files: [] };
  if (!candidate) return { item: undefined, blockers };
  const queue = queueForManifest(manifest) ?? { version: QUEUE_SCHEMA_VERSION, items: [] };
  for (const dependencyId of candidate.after) {
    const dependency = queue.items.find(
      (item) =>
        item.id === dependencyId &&
        (!visibleIds || visibleIds.has(item.id)),
    );
    if (!dependency || !["landed", "dropped"].includes(dependency.state))
      blockers.dependencies.push({
        id: dependencyId,
        ...(dependency ? { state: dependency.state } : {}),
      });
  }
  const candidateFiles = new Map(
    candidate.files.map((file) => [queuePathKey(cwd, file), file]),
  );
  if (candidateFiles.size > 0) {
    for (const other of queue.items) {
      if (
        (visibleIds && !visibleIds.has(other.id)) ||
        other.id === candidate.id ||
        ["landed", "dropped"].includes(other.state)
      )
        continue;
      const workflow = manifest.workflows.find(
        (item) =>
          (item as Workflow & { queueItemId?: string }).queueItemId === other.id,
      );
      const undischarged =
        other.state === "dispatched" ||
        other.state === "verified" ||
        Boolean(
          other.workflowId ||
            (workflow &&
              ["planned", "starting", "running", "blocked", "dispatch-failed"].includes(
                workflow.status,
              )),
        );
      if (!undischarged) continue;
      const overlap = other.files.filter((file) =>
        candidateFiles.has(queuePathKey(cwd, file)),
      );
      if (overlap.length)
        blockers.files.push({ itemId: other.id, files: overlap });
    }
  }
  return { item: candidate, blockers };
}

function queueHead(
  manifest: ManifestWithQueue,
  cwd: string,
  visibleIds?: Set<string>,
): QueueReadiness {
  const queue = queueForManifest(manifest);
  const candidate = queue?.items.find(
    (item) =>
      item.state === "pending" &&
      (!visibleIds || visibleIds.has(item.id)),
  );
  return queueReadiness(manifest, candidate, cwd, visibleIds);
}

function queueBlockerText(blockers: QueueBlockers): string {
  const parts: string[] = [];
  if (blockers.dependencies.length)
    parts.push(
      `dependencies: ${blockers.dependencies
        .map((item) => `${item.id}${item.state ? ` (${item.state})` : ""}`)
        .join(", ")}`,
    );
  if (blockers.files.length)
    parts.push(
      `files: ${blockers.files
        .map((item) => `${item.itemId} [${item.files.join(", ")}]`)
        .join(", ")}`,
    );
  return parts.join("; ");
}

function rootGoalStore(value: unknown, label = "manifest.parentGoals"): RootGoalStore {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  // Accept the first internal draft of the scoped schema while normalizing all
  // new writes to the root-id keyed shape consumed by the controller.
  if (value.version === ROOT_GOALS_SCHEMA_VERSION && Array.isArray(value.roots)) {
    const normalized: RootGoalStore = {};
    for (const [index, raw] of value.roots.entries()) {
      if (!isRecord(raw)) throw new Error(`${label}.roots[${index}] must be an object.`);
      if (typeof raw.rootId !== "string" || !raw.rootId)
        throw new Error(`${label}.roots[${index}].rootId must be a non-empty string.`);
      if (raw.goal !== undefined && !isRecord(raw.goal))
        throw new Error(`${label}.roots[${index}].goal must be an object when present.`);
      const goal = raw.goal as RootParentGoal | undefined;
      if (goal) normalized[raw.rootId] = goal;
    }
    return normalized;
  }
  const normalized: RootGoalStore = {};
  for (const [rootId, raw] of Object.entries(value)) {
    if (!isRecord(raw)) throw new Error(`${label}.${rootId} must be an object.`);
    // Root ownership is carried on the goal when the extension writes it. A
    // controller-created map may omit it because the map key is authoritative.
    if (isRecord(raw.goal)) {
      const goal = raw.goal as RootParentGoal;
      normalized[rootId] = {
        ...goal,
        rootId:
          typeof raw.rootId === "string" && raw.rootId ? raw.rootId : rootId,
        ...(isRecord(raw.root) ? { root: validateControllerRoot(raw.root) } : {}),
      } as RootParentGoal;
    } else {
      normalized[rootId] = {
        ...raw,
        rootId:
          typeof raw.rootId === "string" && raw.rootId ? raw.rootId : rootId,
      } as unknown as RootParentGoal;
      if (isRecord(raw.root))
        normalized[rootId].root = validateControllerRoot(raw.root);
    }
  }
  return normalized;
}

function rootGoalHistoryStore(
  value: unknown,
  label = "manifest.goalHistoryByRoot",
): Record<string, GoalHistoryRecord[]> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const result: Record<string, GoalHistoryRecord[]> = {};
  for (const [rootId, history] of Object.entries(value)) {
    if (!Array.isArray(history)) throw new Error(`${label}.${rootId} must be an array.`);
    result[rootId] = history as GoalHistoryRecord[];
  }
  return result;
}

function rootSessionLogStore(
  value: unknown,
  label = "manifest.rootSessionLogs",
): RootSessionLogEntry[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const ids = new Set<string>();
  return value.map((raw, index) => {
    const itemLabel = `${label}[${index}]`;
    if (!isRecord(raw)) throw new Error(`${itemLabel} must be an object.`);
    if (typeof raw.rootId !== "string" || !raw.rootId)
      throw new Error(`${itemLabel}.rootId must be a non-empty string.`);
    if (ids.has(raw.rootId)) throw new Error(`Duplicate root session log ID: ${raw.rootId}.`);
    ids.add(raw.rootId);
    validateControllerRoot(raw.root);
    return raw as unknown as RootSessionLogEntry;
  });
}

function rootQueueStore(value: unknown, label = "manifest.rootQueues"): RootQueueStore {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  if (value.version !== ROOT_QUEUES_SCHEMA_VERSION)
    throw new Error(`${label}.version must be ${ROOT_QUEUES_SCHEMA_VERSION}.`);
  if (!Array.isArray(value.roots)) throw new Error(`${label}.roots must be an array.`);
  const ids = new Set<string>();
  const itemIds = new Set<string>();
  const roots = value.roots.map((raw, index) => {
    const itemLabel = `${label}.roots[${index}]`;
    if (!isRecord(raw)) throw new Error(`${itemLabel} must be an object.`);
    if (raw.version !== ROOT_QUEUES_SCHEMA_VERSION)
      throw new Error(`${itemLabel}.version must be ${ROOT_QUEUES_SCHEMA_VERSION}.`);
    if (typeof raw.rootId !== "string" || !raw.rootId)
      throw new Error(`${itemLabel}.rootId must be a non-empty string.`);
    if (ids.has(raw.rootId)) throw new Error(`Duplicate root queue ID: ${raw.rootId}.`);
    ids.add(raw.rootId);
    validateControllerRoot(raw.root);
    if (!Array.isArray(raw.itemIds) || raw.itemIds.some((id) => typeof id !== "string" || !id))
      throw new Error(`${itemLabel}.itemIds must contain non-empty strings.`);
    for (const id of raw.itemIds) {
      if (itemIds.has(id)) throw new Error(`Queue item ${id} has multiple root owners.`);
      itemIds.add(id);
    }
    return raw as unknown as RootQueueRecord;
  });
  return { version: ROOT_QUEUES_SCHEMA_VERSION, roots };
}

async function loadManifest(cwd: string): Promise<ManifestWithQueue> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(cwd), "utf8")) as {
      version?: unknown;
      workflows?: unknown;
      parentGoal?: ParentGoal;
      parentGoals?: unknown;
      questionRequests?: ParentQuestionRequest[];
      messageRequests?: MessageRecord[];
      sessionLog?: SessionLogEntry;
      rootSessionLogs?: unknown;
      goalHistory?: unknown;
      queue?: unknown;
      rootQueues?: unknown;
      goalHistoryByRoot?: unknown;
      approvalPolicyAck?: ApprovalPolicyAck;
      leases?: Lease[];
      directives?: RootDirective[];
      rootSupervision?: RootSupervision[];
    };
    if (
      (parsed.version === 1 || parsed.version === 2) &&
      Array.isArray(parsed.workflows)
    ) {
      stripSupervisorIntervalPolicy(parsed);
      return {
        version: 2,
        workflows: (parsed.workflows as Workflow[]).map((workflow) =>
          normalizeWorkflowGoals(workflow),
        ),
        parentGoal: parsed.parentGoal,
        questionRequests: parsed.questionRequests,
        messageRequests: parsed.messageRequests,
        ...(parsed.sessionLog ? { sessionLog: parsed.sessionLog } : {}),
        ...(Array.isArray(parsed.goalHistory)
          ? { goalHistory: parsed.goalHistory as GoalHistoryRecord[] }
          : {}),
        ...(parsed.parentGoals !== undefined
          ? { parentGoals: rootGoalStore(parsed.parentGoals) }
          : {}),
        ...(parsed.goalHistoryByRoot !== undefined
          ? { goalHistoryByRoot: rootGoalHistoryStore(parsed.goalHistoryByRoot) }
          : {}),
        ...(parsed.rootSessionLogs !== undefined
          ? { rootSessionLogs: rootSessionLogStore(parsed.rootSessionLogs) }
          : {}),
        ...(parsed.rootQueues !== undefined
          ? { rootQueues: rootQueueStore(parsed.rootQueues) }
          : {}),
        ...(parsed.queue !== undefined
          ? { queue: queueStore(parsed.queue) }
          : {}),
        ...(await durableApprovalAck(cwd, parsed.approvalPolicyAck)),
        ...(Array.isArray(parsed.leases) ? { leases: parsed.leases } : {}),
        ...(Array.isArray(parsed.directives) ? { directives: parsed.directives } : {}),
        ...(Array.isArray(parsed.rootSupervision) ? { rootSupervision: parsed.rootSupervision } : {}),
      };
    }
    return { version: 2, workflows: [] };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // An empty manifest here would silently orphan a run that an older
      // Baa-ton recorded under .pi/herdr-orchestrator (renamed in f00b5e5).
      const legacy = await legacyStateStatus(cwd);
      if (legacy.needsMigration)
        throw new Error(
          `Herdr orchestrator state for ${cwd} is still at ${legacy.legacyDirectory}. Run \`node ${join(dirname(fileURLToPath(import.meta.url)), "state-migration.mjs")} --project-root "${cwd}" --controller-config-dir "$(herdr plugin config-dir herdr-orchestrator-controller)"\` (or rerun Baa-ton setup) to migrate it before using the orchestrator.`,
        );
      return { version: 2, workflows: [] };
    }
    throw new Error(`Cannot read Herdr manifest: ${(error as Error).message}`);
  }
}

/** Drop the #28 `supervisor.intervalPolicy` key from every goal copy: bridges
 * loaded from earlier releases reject unknown supervisor keys. The marker
 * lives in rootSupervision instead (see hasNudgeIntervalPolicy). */
function stripSupervisorIntervalPolicy(manifest: Record<string, unknown>): void {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "supervisor" && isRecord(child)) delete child.intervalPolicy;
      visit(child);
    }
  };
  for (const key of ["parentGoal", "parentGoals", "goalHistory", "goalHistoryByRoot"]) visit(manifest[key]);
}

function hasNudgeIntervalPolicy(manifest: ManifestWithQueue, rootId: string): boolean {
  return Boolean(
    manifest.rootSupervision?.some((entry) => entry.rootId === rootId && entry.nudgeIntervalPolicy === 2),
  );
}

function markNudgeIntervalPolicy(manifest: ManifestWithQueue, rootId: string): void {
  const entries = (manifest.rootSupervision ??= []);
  let entry = entries.find((item) => item.rootId === rootId);
  if (!entry) {
    entry = { rootId, alerts: [] };
    entries.push(entry);
  }
  entry.nudgeIntervalPolicy = 2;
}

const APPROVAL_ACK_NAME = "approval-policy-ack.json";
const writtenApprovalAcks = new Map<string, string>();

function approvalAckPath(cwd: string): string {
  return join(dirname(manifestPath(cwd)), APPROVAL_ACK_NAME);
}

function isApprovalAck(value: unknown): value is ApprovalPolicyAck {
  return (
    isRecord(value) &&
    typeof value.hash === "string" &&
    /^[0-9a-f]{64}$/.test(value.hash) &&
    Array.isArray(value.grants) &&
    typeof value.ackedAt === "string" &&
    typeof value.rootPaneId === "string"
  );
}

/**
 * The standing-policy acknowledgement is also kept in its own file beside
 * the manifest. Manifest writers from before #21 (still running in lanes
 * dispatched before an upgrade) rebuild the manifest from the top-level keys
 * they know and drop approvalPolicyAck, and a stale in-memory manifest saved
 * late can do the same. The newer of the two copies wins.
 */
async function durableApprovalAck(
  cwd: string,
  inManifest: unknown,
): Promise<{ approvalPolicyAck?: ApprovalPolicyAck }> {
  let inFile: ApprovalPolicyAck | undefined;
  try {
    const parsed = JSON.parse(await readFile(approvalAckPath(cwd), "utf8"));
    if (isApprovalAck(parsed)) inFile = parsed;
  } catch {
    // Missing or unreadable: fall back to the manifest copy.
  }
  const fromManifest = isApprovalAck(inManifest) ? inManifest : undefined;
  const ack =
    inFile && fromManifest
      ? Date.parse(fromManifest.ackedAt) > Date.parse(inFile.ackedAt)
        ? fromManifest
        : inFile
      : (inFile ?? fromManifest);
  return ack ? { approvalPolicyAck: ack } : {};
}

async function persistApprovalAck(cwd: string, ack: ApprovalPolicyAck | undefined): Promise<void> {
  if (!ack) return;
  const path = approvalAckPath(cwd);
  const text = `${jsonText(ack)}\n`;
  if (writtenApprovalAcks.get(path) === text) return;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
  writtenApprovalAcks.set(path, text);
}

async function saveManifest(cwd: string, manifest: Manifest): Promise<void> {
  const path = manifestPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${jsonText(manifest)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await persistApprovalAck(cwd, (manifest as ManifestWithQueue).approvalPolicyAck);
}

async function acquireManifestLock(
  cwd: string,
  waitMs = 0,
): Promise<() => Promise<void>> {
  const path = manifestPath(cwd);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = join(
    dirname(path),
    `.${MANIFEST_NAME}.herdr-orchestrator.lock`,
  );
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(
        join(lockPath, "owner.json"),
        `${jsonText({ pid: process.pid, createdAt: now() })}\n`,
        { mode: 0o600 },
      );
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        if (Date.now() < deadline) {
          // Bounded contention on the shared filesystem lock, never agent polling.
          await lockRetryDelay(10);
          continue;
        }
        throw new Error(
          `Herdr manifest is busy: ${path}. Wait for the active controller operation, then retry.`,
        );
      }
      throw error;
    }
  }
}

async function acquireControllerConfigLock(
  configPath: string,
  waitMs = 10_000,
): Promise<() => Promise<void>> {
  const lockPath = `${configPath}.lock`;
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(
        join(lockPath, "owner.json"),
        `${jsonText({ pid: process.pid, createdAt: now(), configPath })}\n`,
        { mode: 0o600 },
      );
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        if (Date.now() < deadline) {
          await lockRetryDelay(10);
          continue;
        }
        throw new Error(
          `Herdr controller config is busy: ${configPath}. Wait for the active root operation, then retry.`,
        );
      }
      throw error;
    }
  }
}

// The single transactional state owner for the manifest: every writer that
// needs to mutate durable state after any await (a terminal/network call,
// user confirmation, etc.) must reconcile against a freshly reloaded copy
// under this same lock rather than blindly overwriting whatever it read
// before that await. Never hold this across a terminal/network call; gather
// external results first, then pass only the resulting mutation in.
async function withManifestTransaction<T>(
  cwd: string,
  mutate: (manifest: ManifestWithRootState) => T,
  waitMs = 10_000,
): Promise<T> {
  const release = await acquireManifestLock(cwd, waitMs);
  try {
    const manifest = await loadManifest(cwd);
    const result = mutate(manifest);
    await saveManifest(cwd, manifest);
    return result;
  } finally {
    await release();
  }
}

const PARENT_GOAL_STATUSES = new Set<ParentGoalStatus>([
  "active",
  "waiting-for-event",
  "action-required",
  "review-requested",
  "blocked",
  "completed",
  "paused",
]);
const MIN_PARENT_GOAL_NUDGE_INTERVAL_SECONDS = 5;

// A lane is terminal for operator-closure stamping when its own work is
// reconciled: a receipt, an operator closure, a reported completion, or a
// recorded completion outcome.
const TERMINAL_LANE_STATUSES = new Set([
  "operator-closed",
  "completion-reported",
  "completed",
  "superseded",
]);

type LaneRetirementRecord = {
  version: 1;
  status: "partial" | "retired";
  workspaceId: string;
  tabIds: string[];
  closedTabIds: string[];
  failedTabIds: string[];
  pendingTabIds: string[];
  requestedAt: string;
  completedAt?: string;
  evidence: string[];
};

type WorkflowWithLaneRetirement = Workflow & {
  laneRetirement?: LaneRetirementRecord;
};

type CleanupTabCandidate = {
  workflowId: string;
  tabId: string;
  label: string;
  workspaceId: string;
};

type CleanupWorktreeCandidate = {
  workflowId: string;
  path: string;
  branch: string;
  openWorkspaceId?: string | null;
};

type CleanupLeaseCandidate = {
  leaseId: string;
  workflowId: string;
  laneId: string;
  resource: string;
  value: string;
  reason: string;
};

type CleanupInventory = {
  root: { paneId: string; workspaceId: string; orchestratorId: string };
  laneTabs: CleanupTabCandidate[];
  worktrees: CleanupWorktreeCandidate[];
  leases: CleanupLeaseCandidate[];
  issues: Array<{ workflowId?: string; resource?: string; error: string }>;
};

const MAX_PARENT_GOAL_NUDGE_INTERVAL_SECONDS = 86_400;

const TERMINAL_WORKFLOW_STATUSES = new Set([
  "completed",
  "closed",
  "operator-closed",
  "superseded",
]);
const TERMINAL_WORKFLOW_OUTCOMES = new Set([
  "completed",
  "closed",
  "operator-closed",
  "superseded",
]);

function workflowOwnedByRoot(
  workflow: Workflow,
  scope: { rootId: string; root: ControllerRootMapping },
  cwd?: string,
): boolean {
  if (
    workflow.taskBinding &&
    workflow.taskBinding.rootPaneId === scope.root.pane_id &&
    workflow.taskBinding.workspaceId === scope.root.workspace_id
  )
    return true;
  const registration = workflow.eventControllerRegistration;
  if (
    registration?.root &&
    registration.root.pane_id === scope.root.pane_id &&
    registration.root.workspace_id === scope.root.workspace_id
  )
    return true;
  if (workflow.ownership?.workspaceId)
    return workflow.ownership.workspaceId === scope.root.workspace_id;
  return cwd ? legacyRootIdForManifest(cwd) === scope.rootId : true;
}

function nonTerminalWorkflowIds(
  manifest: ManifestWithGoalHistory,
  scope?: { rootId: string; root: ControllerRootMapping },
  cwd?: string,
): string[] {
  return manifest.workflows
    .filter((workflow) => !scope || workflowOwnedByRoot(workflow, scope, cwd))
    .filter((workflow) => {
      const hasStatus = typeof workflow.status === "string";
      const hasOutcome = typeof workflow.outcome === "string";
      const hasLaneLifecycle = workflow.lanes.some(
        (lane) => lane.status !== undefined || lane.completionReceipt !== undefined,
      );
      const nonTerminalLane = workflow.lanes.some(
        (lane) =>
          !lane.completionReceipt &&
          lane.status !== undefined &&
          !TERMINAL_LANE_STATUSES.has(lane.status),
      );
      // Old diagnostic manifests omitted lifecycle fields. Preserve their
      // ability to be rewritten while treating every explicitly non-terminal
      // state conservatively during a parent-goal reset. If a legacy record
      // does carry lane telemetry, use it as the lifecycle evidence.
      if (!hasStatus && !hasOutcome && !hasLaneLifecycle)
        return false;
      return (
        nonTerminalLane ||
        (hasStatus && !TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) ||
        (hasOutcome && !TERMINAL_WORKFLOW_OUTCOMES.has(workflow.outcome))
      );
    })
    .map((workflow) => workflow.id);
}

const DEFAULT_PARENT_GOAL_NUDGE_INTERVAL_SECONDS = 300;

function parentGoalNudgeInterval(value: number | undefined): number {
  const interval = value ?? DEFAULT_PARENT_GOAL_NUDGE_INTERVAL_SECONDS;
  if (
    !Number.isSafeInteger(interval) ||
    interval < MIN_PARENT_GOAL_NUDGE_INTERVAL_SECONDS ||
    interval > MAX_PARENT_GOAL_NUDGE_INTERVAL_SECONDS
  )
    throw new Error(
      `nudgeIntervalSeconds must be an integer from ${MIN_PARENT_GOAL_NUDGE_INTERVAL_SECONDS} to ${MAX_PARENT_GOAL_NUDGE_INTERVAL_SECONDS}.`,
    );
  return interval;
}

function requireRootGoalExecutor(): void {
  requireHerdr();
  if (!isRootOrchestrator())
    throw new Error(
      "Only the verified controller-mapped root may create or update the parent goal or queue.",
    );
}

function requireRootOperator(): void {
  requireHerdr();
  if (!isRootOrchestrator())
    throw new Error(
      "Only the verified controller-mapped root may record an operator closure.",
    );
}

async function parentGoal(
  cwd: string,
  action:
    | "initialize"
    | "set-state"
    | "status"
    | "start"
    | "stop"
    | "pause"
    | "reset",
  objective?: string,
  status?: string,
  nextAction?: string,
  nudgeIntervalSeconds?: number,
  pauseReason?: string,
  force = false,
  reason?: string,
  rootTurn?: RootTurn,
): Promise<ParentGoalActionResult> {
  requireRootGoalExecutor();
  const scope = requireRootManifestExecutor(cwd);
  const release = await acquireManifestLock(cwd);
  try {
    const manifest = await loadManifest(cwd);
    const scoped = rootGoalFor(manifest, cwd, scope);
    const record = scoped.record;
    const goal = scoped.goal ?? record?.goal;
    const history = record
      ? ((manifest.goalHistoryByRoot ??= {})[scope.rootId] ??= record.goalHistory)
      : Array.isArray(manifest.goalHistory)
        ? manifest.goalHistory
        : [];
    const legacyOwner = legacyRootIdForManifest(cwd) === scope.rootId;
    const syncLegacyProjection = (value: ParentGoal | undefined): void => {
      if (legacyOwner && (!record || record.rootId === scope.rootId)) {
        if (value) manifest.parentGoal = value;
        else delete manifest.parentGoal;
      }
      if (record) {
        record.root = scope.root;
        if (value && manifest.parentGoals) {
          const scopedGoal = value as RootParentGoal;
          scopedGoal.rootId = scope.rootId;
          scopedGoal.root = scope.root;
          manifest.parentGoals[scope.rootId] = scopedGoal;
        }
      }
    };
    if (action === "status") {
      if (!goal) throw new Error("No parent goal is registered.");
      return { goal, goalHistoryCount: history.length };
    }
    if (action === "reset") {
      if (!goal)
        throw new Error("No parent goal is registered; initialize one first.");
      const activeWorkflowIds = nonTerminalWorkflowIds(manifest, scope, cwd);
      const normalizedReason = reason?.trim();
      if (activeWorkflowIds.length > 0 && !force)
        throw new Error(
          `Cannot reset parent goal while routed workflow(s) are non-terminal: ${activeWorkflowIds.join(", ")}. Use force=true with a reason to archive it anyway.`,
        );
      if (force && !normalizedReason)
        throw new Error("reason is required when force=true.");
      const timestamp = now();
      const archived = JSON.parse(JSON.stringify(goal)) as GoalHistoryRecord;
      archived.version = GOAL_HISTORY_SCHEMA_VERSION;
      archived.archivedAt = timestamp;
      if (force) {
        archived.force = true;
        archived.reason = normalizedReason!;
      }
      history.push(archived);
      if (record) {
        record.goal = undefined;
        delete manifest.parentGoals?.[scope.rootId];
      }
      if (!record || record.rootId === legacyRootIdForManifest(cwd))
        manifest.goalHistory = history;
      syncLegacyProjection(undefined);
      await saveManifest(cwd, manifest);
      return {
        reset: true,
        archivedGoalId: goal.id,
        historyLength: history.length,
      };
    }
    if (action === "initialize") {
      if (goal)
        throw new Error("A parent goal is already registered; use set-state.");
      if (!objective?.trim())
        throw new Error("objective is required to initialize a parent goal.");
      const timestamp = now();
      // A new goal (including the one after a reset) is supervised from the
      // start: the #28 goal loop must not depend on a separate start call.
      // It keeps the previous goal's interval, and stays paused only when
      // that goal was explicitly paused.
      const previous = [...history].reverse().find((item) =>
        isRecord((item as { supervisor?: unknown }).supervisor),
      ) as { supervisor?: ParentGoal["supervisor"] } | undefined;
      const previousControl = previous?.supervisor;
      const carriedPause =
        previousControl?.state === "paused" && previousControl.pauseReason?.trim()
          ? previousControl.pauseReason.trim()
          : undefined;
      const previousInterval =
        previousControl && Number.isSafeInteger(previousControl.intervalSeconds)
          ? hasNudgeIntervalPolicy(manifest, scope.rootId)
            ? previousControl.intervalSeconds
            : Math.min(previousControl.intervalSeconds, DEFAULT_PARENT_GOAL_NUDGE_INTERVAL_SECONDS)
          : undefined;
      const intervalSeconds = parentGoalNudgeInterval(nudgeIntervalSeconds ?? previousInterval);
      const initialized: ParentGoal = {
        version: 1,
        id: `parent-goal-${randomUUID().slice(0, 12)}`,
        objective: objective.trim(),
        status: "active",
        nextAction:
          nextAction?.trim() ||
          "Choose one dependency-ready Herdr action or wait for a durable event.",
        signals: [],
        supervisor: {
          version: 1,
          state: carriedPause ? "paused" : "running",
          intervalSeconds,
          ...(carriedPause ? { pauseReason: carriedPause } : {}),
          nudgeCount: 0,
          nextNudgeAt: carriedPause
            ? null
            : new Date(Date.parse(timestamp) + intervalSeconds * 1000).toISOString(),
          rootActivity: { status: "unknown", observedAt: timestamp },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      // Retain the original field for a legacy manifest/root. A second root
      // gets a private record without replacing that compatibility projection.
      const useLegacyField = !manifest.parentGoals && legacyOwner;
      if (useLegacyField) manifest.parentGoal = initialized;
      else {
        const target = record ?? ensureRootGoalRecord(manifest, cwd, scope);
        const scopedGoal: RootParentGoal = {
          ...initialized,
          rootId: scope.rootId,
          root: scope.root,
        };
        target.root = scope.root;
        target.goal = scopedGoal;
        manifest.parentGoals![scope.rootId] = scopedGoal;
      }
      syncLegacyProjection(initialized);
      if (rootTurn && initialized.supervisor)
        initialized.supervisor.rootTurn = rootTurn;
      markNudgeIntervalPolicy(manifest, scope.rootId);
      await saveManifest(cwd, manifest);
      return {
        goal: initialized,
        goalHistoryCount: history.length,
      };
    }
    if (!goal)
      throw new Error("No parent goal is registered; initialize one first.");
    const timestamp = now();
    const supervisor = () =>
      (goal.supervisor ??= {
        version: 1,
        state: "stopped",
        intervalSeconds: parentGoalNudgeInterval(undefined),
        nudgeCount: 0,
        nextNudgeAt: null,
        rootActivity: { status: "unknown", observedAt: timestamp },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    const previousWork = JSON.stringify([
      goal.status,
      goal.objective,
      goal.nextAction,
    ]);
    const previousSupervisorState = goal.supervisor?.state;
    if (action === "set-state") {
      if (!status || !PARENT_GOAL_STATUSES.has(status as ParentGoalStatus))
        throw new Error(
          `status must be one of: ${[...PARENT_GOAL_STATUSES].join(", ")}.`,
        );
      if (status === "paused")
        throw new Error("Use action=pause with a non-empty pauseReason.");
      goal.status = status as ParentGoalStatus;
      if (objective?.trim()) goal.objective = objective.trim();
      if (nextAction?.trim()) goal.nextAction = nextAction.trim();
      // Only completion ends supervision. A blocked goal keeps being nudged
      // while actionable work exists, so the root cannot park out of it.
      if (status === "completed") {
        const control = supervisor();
        control.state = "stopped";
        control.nextNudgeAt = null;
        control.updatedAt = timestamp;
      }
    } else if (action === "start") {
      if (goal.status === "completed")
        throw new Error("A completed parent goal cannot be started.");
      const control = supervisor();
      control.state = "running";
      control.intervalSeconds = parentGoalNudgeInterval(
        nudgeIntervalSeconds ??
          (hasNudgeIntervalPolicy(manifest, scope.rootId)
            ? control.intervalSeconds
            : Math.min(control.intervalSeconds, DEFAULT_PARENT_GOAL_NUDGE_INTERVAL_SECONDS)),
      );
      markNudgeIntervalPolicy(manifest, scope.rootId);
      if (previousSupervisorState !== "running") {
        control.nextNudgeAt = new Date(
          Date.parse(timestamp) + control.intervalSeconds * 1000,
        ).toISOString();
        delete control.lastDelivery;
      }
      delete control.pauseReason;
      control.updatedAt = timestamp;
      if (goal.status === "paused") goal.status = "active";
      if (nextAction?.trim()) goal.nextAction = nextAction.trim();
    } else if (action === "stop") {
      const control = supervisor();
      control.state = "stopped";
      control.nextNudgeAt = null;
      control.updatedAt = timestamp;
    } else if (action === "pause") {
      if (!pauseReason?.trim())
        throw new Error("pauseReason is required when action=pause.");
      const control = supervisor();
      control.state = "paused";
      control.pauseReason = pauseReason.trim();
      control.nextNudgeAt = null;
      control.updatedAt = timestamp;
      goal.status = "paused";
    }
    const control = goal.supervisor;
    if (
      control &&
      previousWork !== JSON.stringify([goal.status, goal.objective, goal.nextAction])
    ) {
      if (
        control.lastDelivery?.status !== "sending" &&
        control.lastDelivery?.status !== "uncertain"
      ) {
        delete control.lastDelivery;
        control.nextNudgeAt =
          goal.status !== "completed" && goal.status !== "paused" && control.state === "running"
            ? new Date(
                Date.parse(timestamp) + control.intervalSeconds * 1000,
              ).toISOString()
            : null;
      }
      control.updatedAt = timestamp;
    }
    goal.updatedAt = timestamp;
    if (rootTurn && goal.supervisor) goal.supervisor.rootTurn = rootTurn;
    syncLegacyProjection(goal);
    await saveManifest(cwd, manifest);
    return { goal, goalHistoryCount: history.length };
  } finally {
    await release();
  }
}

async function plannedCwd(
  callerCwd: string,
  worktreeCwd?: string,
): Promise<{ cwd: string; worktree: string | null }> {
  if (!worktreeCwd) return { cwd: resolve(callerCwd), worktree: null };
  if (!isAbsolute(worktreeCwd))
    throw new Error("worktreeCwd must be an absolute existing directory.");
  let details: Awaited<ReturnType<typeof stat>>;
  try {
    details = await stat(worktreeCwd);
  } catch {
    throw new Error(`worktreeCwd does not exist: ${worktreeCwd}`);
  }
  if (!details.isDirectory())
    throw new Error(`worktreeCwd is not a directory: ${worktreeCwd}`);
  // Canonicalize only an existing checkout; never create or modify a Git worktree.
  const cwd = await realpath(worktreeCwd);
  return { cwd, worktree: cwd };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function samePath(left: string, right: string): boolean {
  const leftResolved = resolve(left);
  const rightResolved = resolve(right);
  if (leftResolved === rightResolved) return true;
  try {
    return realpathSync(leftResolved) === realpathSync(rightResolved);
  } catch {
    return false;
  }
}

function validateAgentKind(value: unknown, label = "agentKind"): AgentKind {
  if (
    typeof value === "string" &&
    SUPPORTED_AGENT_KINDS.includes(value as AgentKind)
  )
    return value as AgentKind;
  throw new Error(
    `${label} must be one of ${SUPPORTED_AGENT_KINDS.join(", ")}.`,
  );
}

function laneAgentKind(workflow: Workflow, lane: Lane): AgentKind {
  // Manifests written before agentKind are Pi workflows by definition.
  return validateAgentKind(lane.agentKind ?? workflow.agentKind ?? "pi");
}

// Tool names are "mcp__<server>__<tool>"; neither segment contains "__", so
// a non-greedy match up to the first literal "__" isolates the server key.
const MCP_TOOL_REFERENCE_PATTERN = /\bmcp__([A-Za-z0-9._-]*?)__[A-Za-z0-9_]+/g;

export function referencedMcpServers(text: string): string[] {
  const servers = new Set<string>();
  for (const match of text.matchAll(MCP_TOOL_REFERENCE_PATTERN))
    if (match[1] && match[1] !== "herdr-orchestrator") servers.add(match[1]);
  return [...servers];
}

export function assertMcpServersGranted(
  laneId: string,
  objective: string,
  granted: Record<string, unknown> | undefined,
): void {
  const grantedKeys = new Set(Object.keys(granted ?? {}));
  const missing = referencedMcpServers(objective).filter(
    (name) => !grantedKeys.has(name),
  );
  if (missing.length)
    throw new Error(
      `Lane ${laneId} objective references mcp__${missing[0]}__* tools, but mcpServers does not grant "${missing[0]}". ` +
        `--strict-mcp-config scopes a dispatched lane to herdr-orchestrator plus whatever mcpServers lists, so any other server -- including a claude.ai account connector -- is unreachable unless granted there. ` +
        `Add its raw --mcp-config entry to this lane's mcpServers, or remove the reference from the objective.`,
    );
}

function normalizedLanes(
  objective: string,
  inputs: LaneInput[],
  defaultAgentKind: AgentKind,
  workflowId: string,
  rootGoalId: string,
  defaultReadOnly = false,
  profileResolver?: (name: string) => ReturnType<typeof resolveTaskProfile>,
): Lane[] {
  const values = inputs.length ? inputs : [objective];
  return values.map((input, index) => {
    const laneId = `lane-${index + 1}`;
    const goalId = `${rootGoalId}/${laneId}`;
    if (typeof input === "string") {
      assertMcpServersGranted(laneId, input, undefined);
      return {
        id: laneId,
        objective: input,
        readOnly: defaultReadOnly,
        agentKind: defaultAgentKind,
        status: "planned",
        goalId,
        goalRevision: 1,
        dependencies: [],
        goalOwnership: {
          scope: "lane" as const,
          workflowId,
          laneId,
          authority: "lane" as const,
        },
      };
    }
    if (!input || typeof input.objective !== "string" || !input.objective)
      throw new Error("Each lane object needs a non-empty objective.");
    const configuredProfile = input.taskProfile
      ? profileResolver?.(input.taskProfile)
      : undefined;
    if (input.taskProfile && !profileResolver)
      throw new Error(`Task profile ${input.taskProfile} cannot be resolved in this planning context.`);
    if (input.taskProfile && input.launchProfile !== undefined)
      throw new Error(`Lane ${laneId} cannot specify both taskProfile and launchProfile.`);
    if (
      input.mcpServers !== undefined &&
      (typeof input.mcpServers !== "object" ||
        input.mcpServers === null ||
        Array.isArray(input.mcpServers))
    )
      throw new Error(`Lane ${laneId} mcpServers must be an object of server definitions.`);
    if (input.mcpServers && "herdr-orchestrator" in input.mcpServers)
      throw new Error(`Lane ${laneId} mcpServers cannot override the reserved herdr-orchestrator entry.`);
    assertMcpServersGranted(laneId, input.objective, input.mcpServers);
    const launchProfile =
      configuredProfile?.launchProfile ??
      (input.launchProfile === undefined
        ? undefined
        : validateLaunchProfile(
            input.launchProfile,
            `Lane ${laneId} launchProfile`,
          ));
    return {
      id: laneId,
      objective: input.objective,
      readOnly: defaultReadOnly || configuredProfile?.readOnly === true || input.readOnly === true,
      agentKind: validateAgentKind(
        input.agentKind ?? configuredProfile?.agentKind ?? defaultAgentKind,
      ),
      status: "planned",
      goalId,
      goalRevision: 1,
      dependencies: Array.isArray(input.dependencies ?? input.dependsOn)
        ? [...(input.dependencies ?? input.dependsOn)!]
        : [],
      goalOwnership: {
        scope: "lane" as const,
        workflowId,
        laneId,
        authority: "lane" as const,
      },
      ...(launchProfile
        ? {
            launchProfile,
            launchProfileVersion: LAUNCH_PROFILE_SCHEMA_VERSION,
          }
        : {}),
      ...(input.taskProfile ? { taskProfile: input.taskProfile } : {}),
      ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
    };
  });
}

function createWorkflowGoals(
  workflowId: string,
  objective: string,
  lanes: Lane[],
): { rootGoalId: string; goals: GoalRecord[] } {
  const rootGoalId = `goal-${workflowId}`;
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const laneGoalIds = new Map(lanes.map((lane) => [lane.id, lane.goalId!]));
  const root: GoalRecord = {
    version: 1,
    id: rootGoalId,
    revision: 1,
    dependencies: [],
    objective,
    status: "planned",
    outcome: "unresolved",
    ownership: {
      scope: "workflow",
      workflowId,
      authority: "authorized-root",
    },
    updatedAt: now(),
  };
  const laneGoals = lanes.map((lane) => {
    const requested = lane.dependencies ?? [];
    for (const dependency of requested)
      if (!laneIds.has(dependency))
        throw new Error(
          `Lane ${lane.id} dependency must reference another lane ID: ${dependency}.`,
        );
    if (requested.includes(lane.id))
      throw new Error(`Lane ${lane.id} cannot depend on itself.`);
    const dependencies = requested.map(
      (dependency) => laneGoalIds.get(dependency)!,
    );
    lane.dependencies = dependencies;
    const goal: GoalRecord = {
      version: 1,
      id: lane.goalId!,
      revision: 1,
      parentId: rootGoalId,
      dependencies,
      objective: lane.objective,
      status: "planned",
      outcome: "unresolved",
      ownership: lane.goalOwnership!,
      updatedAt: now(),
    };
    return goal;
  });
  return { rootGoalId, goals: [root, ...laneGoals] };
}

function laneGoal(workflow: Workflow, lane: Lane): GoalRecord {
  const goal = workflow.goals.find((item) => item.id === lane.goalId);
  if (
    !goal ||
    goal.ownership.scope !== "lane" ||
    goal.ownership.laneId !== lane.id
  )
    throw new Error(`Lane ${lane.id} has no scoped goal owned by that lane.`);
  return goal;
}

function updateLaneGoal(
  workflow: Workflow,
  lane: Lane,
  status: GoalStatus,
  outcome: GoalOutcome,
): void {
  const goal = laneGoal(workflow, lane);
  if (goal.status === status && goal.outcome === outcome) return;
  goal.revision += 1;
  goal.status = status;
  goal.outcome = outcome;
  goal.updatedAt = now();
  lane.goalRevision = goal.revision;
}

function workflowHasExplicitSuccess(workflow: Workflow): boolean {
  return (
    workflow.lanes.length > 0 &&
    workflow.lanes.every((lane) => {
      const goal = laneGoal(workflow, lane);
      return goal.outcome === "success";
    })
  );
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys.slice().sort()[index])
  );
}

function controllerString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function controllerObject(
  value: unknown,
  label: string,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed.`);
  for (const key of required)
    if (!(key in value)) throw new Error(`${label}.${key} is required.`);
  return value;
}

function validateControllerTarget(
  value: Record<string, unknown>,
  label: string,
  paneId: string,
): Pick<ControllerRootMapping, "target" | "target_kind"> {
  const target = controllerString(value.target, `${label}.target`);
  const targetKind = controllerString(
    value.target_kind,
    `${label}.target_kind`,
  );
  if (targetKind !== "name" && targetKind !== "pane_id")
    throw new Error(`${label}.target_kind must be name or pane_id.`);
  if (targetKind === "pane_id" && target !== paneId)
    throw new Error(`${label}.target must equal ${label}.pane_id.`);
  return { target, target_kind: targetKind };
}

function validateControllerRoot(input: unknown): ControllerRootMapping {
  const value = controllerObject(
    input,
    "controller config.root",
    ["target", "target_kind", "pane_id", "workspace_id"],
    ["agent_kind"],
  );
  const paneId = controllerString(
    value.pane_id,
    "controller config.root.pane_id",
  );
  const root: ControllerRootMapping = {
    ...validateControllerTarget(value, "controller config.root", paneId),
    pane_id: paneId,
    workspace_id: controllerString(
      value.workspace_id,
      "controller config.root.workspace_id",
    ),
  };
  if ("agent_kind" in value)
    root.agent_kind = controllerString(
      value.agent_kind,
      "controller config.root.agent_kind",
    );
  return root;
}

function validateControllerLane(
  input: unknown,
  label: string,
): ControllerLaneMapping {
  const value = controllerObject(
    input,
    label,
    ["lane_id", "target", "target_kind", "pane_id", "workspace_id"],
    ["relationship_id"],
  );
  const paneId = controllerString(value.pane_id, `${label}.pane_id`);
  return {
    lane_id: controllerString(value.lane_id, `${label}.lane_id`),
    ...validateControllerTarget(value, label, paneId),
    pane_id: paneId,
    workspace_id: controllerString(value.workspace_id, `${label}.workspace_id`),
    ...(typeof value.relationship_id === "string"
      ? {
          relationship_id: controllerString(
            value.relationship_id,
            `${label}.relationship_id`,
          ),
        }
      : {}),
  };
}

function validateControllerWorkflow(
  input: unknown,
  label: string,
): ControllerWorkflowMapping {
  const value = controllerObject(
    input,
    label,
    ["workflow_id", "manifest_path", "lanes"],
    ["pi_goal_pause_detection"],
  );
  const manifest = controllerString(
    value.manifest_path,
    `${label}.manifest_path`,
  );
  if (!isAbsolute(manifest))
    throw new Error(`${label}.manifest_path must be absolute.`);
  if (!Array.isArray(value.lanes) || value.lanes.length === 0)
    throw new Error(`${label}.lanes must be a non-empty array.`);
  if (
    "pi_goal_pause_detection" in value &&
    typeof value.pi_goal_pause_detection !== "boolean"
  )
    throw new Error(`${label}.pi_goal_pause_detection must be a boolean.`);
  const lanes = value.lanes.map((lane, index) =>
    validateControllerLane(lane, `${label}.lanes[${index}]`),
  );
  if (new Set(lanes.map((lane) => lane.lane_id)).size !== lanes.length)
    throw new Error(`${label}.lanes cannot repeat lane_id values.`);
  if (new Set(lanes.map((lane) => lane.pane_id)).size !== lanes.length)
    throw new Error(`${label}.lanes cannot repeat pane_id values.`);
  if (
    new Set(lanes.map((lane) => `${lane.target_kind}:${lane.target}`)).size !==
    lanes.length
  )
    throw new Error(`${label}.lanes cannot repeat targets.`);
  return {
    workflow_id: controllerString(value.workflow_id, `${label}.workflow_id`),
    manifest_path: resolve(manifest),
    ...(typeof value.pi_goal_pause_detection === "boolean"
      ? { pi_goal_pause_detection: value.pi_goal_pause_detection }
      : {}),
    lanes,
  };
}

function validateControllerConfig(input: unknown): ControllerConfig {
  if (!isRecord(input) || input.owner !== OWNER)
    throw new Error(`controller config.owner must be ${OWNER}.`);
  // Read v1 as one isolated legacy record. The next registration writes v2.
  if (input.version === 1) {
    const legacy = controllerObject(input, "controller config", [
      "version",
      "owner",
      "root",
      "workflows",
    ]);
    const root = validateControllerRoot(legacy.root);
    if (!Array.isArray(legacy.workflows) || legacy.workflows.length === 0)
      throw new Error("controller config.workflows must be a non-empty array.");
    return {
      version: 2,
      owner: OWNER,
      orchestrators: [
        {
          id: `legacy:${root.workspace_id}:${root.pane_id}`,
          root,
          program: { id: "legacy-global", workspace_id: root.workspace_id },
          workflows: legacy.workflows.map((item, index) =>
            validateControllerWorkflow(
              item,
              `controller config.workflows[${index}]`,
            ),
          ),
        },
      ],
    };
  }
  const value = controllerObject(input, "controller config", [
    "version",
    "owner",
    "orchestrators",
  ]);
  if (value.version !== 2)
    throw new Error("controller config.version must be 1 or 2.");
  if (!Array.isArray(value.orchestrators) || value.orchestrators.length === 0)
    throw new Error(
      "controller config.orchestrators must be a non-empty array.",
    );
  const orchestrators = value.orchestrators.map((item, index) => {
    const record = controllerObject(
      item,
      `controller config.orchestrators[${index}]`,
      ["id", "root", "program", "workflows"],
    );
    const root = validateControllerRoot(record.root);
    const program = controllerObject(
      record.program,
      `controller config.orchestrators[${index}].program`,
      ["id", "workspace_id"],
      [
        "parent_manifest_path",
        "digest_window_seconds",
        "directive_escalate_minutes",
        "capacity_escalate_minutes",
        "watchdog_minutes",
      ],
    );
    const minuteKeys = ["directive_escalate_minutes", "capacity_escalate_minutes", "watchdog_minutes"] as const;
    for (const key of minuteKeys) {
      const value = program[key];
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_440)
      )
        throw new Error(`controller program.${key} must be an integer from 1 to 1440.`);
    }
    const digestWindowSeconds = program.digest_window_seconds;
    if (
      digestWindowSeconds !== undefined &&
      (!Number.isSafeInteger(digestWindowSeconds) ||
        (digestWindowSeconds as number) < 0 ||
        (digestWindowSeconds as number) > 3_600)
    )
      throw new Error(
        "controller program.digest_window_seconds must be an integer from 0 to 3600.",
      );
    if (!Array.isArray(record.workflows))
      throw new Error("controller orchestrator.workflows must be an array.");
    const programId = controllerString(program.id, "controller program.id");
    const workspaceId = controllerString(
      program.workspace_id,
      "controller program.workspace_id",
    );
    if (workspaceId !== root.workspace_id)
      throw new Error(
        "controller program workspace must match root workspace.",
      );
    const parentManifestPath =
      "parent_manifest_path" in program
        ? controllerString(
            program.parent_manifest_path,
            "controller program.parent_manifest_path",
          )
        : undefined;
    if (parentManifestPath && !isAbsolute(parentManifestPath))
      throw new Error(
        "controller program.parent_manifest_path must be absolute.",
      );
    return {
      id: controllerString(record.id, "controller orchestrator.id"),
      root,
      program: {
        id: programId,
        workspace_id: workspaceId,
        ...(parentManifestPath
          ? { parent_manifest_path: resolve(parentManifestPath) }
          : {}),
        ...(digestWindowSeconds !== undefined
          ? { digest_window_seconds: digestWindowSeconds as number }
          : {}),
        ...Object.fromEntries(
          minuteKeys
            .filter((key) => program[key] !== undefined)
            .map((key) => [key, program[key] as number]),
        ),
      },
      workflows: record.workflows.map((workflow, workflowIndex) =>
        validateControllerWorkflow(
          workflow,
          `controller config.orchestrators[${index}].workflows[${workflowIndex}]`,
        ),
      ),
    };
  });
  if (
    new Set(orchestrators.map((item) => item.id)).size !== orchestrators.length
  )
    throw new Error("controller config cannot repeat orchestrator IDs.");
  // Workflow IDs are scoped to an orchestrator; isolated roots may use the
  // same ID because their manifest paths and pane routes remain distinct.
  if (
    orchestrators.some((orchestrator) => {
      const workflowIds = orchestrator.workflows.map(
        (workflow) => workflow.workflow_id,
      );
      return new Set(workflowIds).size !== workflowIds.length;
    })
  )
    throw new Error(
      "controller config cannot repeat workflow IDs within an orchestrator.",
    );
  return { version: 2, owner: OWNER, orchestrators };
}

function controllerRecordId(root: ControllerRootMapping, cwd: string): string {
  return `orchestrator:${root.workspace_id}:${root.pane_id}:${resolve(cwd)}`;
}

function findControllerRecord(
  config: ControllerConfig,
  root: ControllerRootMapping,
  cwd: string,
): ControllerOrchestrator | undefined {
  const id = controllerRecordId(root, cwd);
  return config.orchestrators.find((record) => record.id === id);
}

function recordForRegistration(
  config: ControllerConfig,
  registration: EventControllerRegistration,
): ControllerOrchestrator | undefined {
  if (!registration.root || !registration.workflow) return undefined;
  return config.orchestrators.find(
    (record) =>
      sameControllerRoot(record.root, registration.root!) &&
      record.workflows.some((workflow) =>
        sameControllerWorkflow(workflow, registration.workflow!),
      ),
  );
}

function sameControllerRoot(
  left: ControllerRootMapping,
  right: ControllerRootMapping,
): boolean {
  return (
    left.target === right.target &&
    left.target_kind === right.target_kind &&
    left.pane_id === right.pane_id &&
    left.workspace_id === right.workspace_id &&
    left.agent_kind === right.agent_kind
  );
}

function sameControllerWorkflow(
  left: ControllerWorkflowMapping,
  right: ControllerWorkflowMapping,
): boolean {
  return (
    left.workflow_id === right.workflow_id &&
    samePath(left.manifest_path, right.manifest_path) &&
    (left.pi_goal_pause_detection ?? false) ===
      (right.pi_goal_pause_detection ?? false) &&
    left.lanes.length === right.lanes.length &&
    left.lanes.every((lane) => {
      const other = right.lanes.find(
        (candidate) => candidate.lane_id === lane.lane_id,
      );
      return (
        lane.target === other?.target &&
        lane.target_kind === other.target_kind &&
        lane.pane_id === other.pane_id &&
        lane.workspace_id === other.workspace_id
      );
    })
  );
}

async function secureControllerConfigDirectory(path: string): Promise<string> {
  if (!isAbsolute(path))
    throw new Error("Herdr controller config directory must be absolute.");
  const directory = resolve(path);
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    details = await lstat(directory);
  }
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Error(
      "Herdr controller config directory must be a real directory.",
    );
  const identity = { dev: details.dev, ino: details.ino };
  // Node exposes POSIX mode bits on Unix, but Windows ACLs do not map to
  // those bits and chmod is not a privacy control there. The directory is
  // still required to be a real, non-symlink directory; on Windows it lives
  // under Herdr's per-user plugin config root, whose ACLs are managed by the
  // Herdr installation. Keep the strict mode repair/check on POSIX hosts.
  if (process.platform !== "win32") {
    await chmod(directory, 0o700);
    details = await lstat(directory);
    if (
      !details.isDirectory() ||
      details.isSymbolicLink() ||
      details.dev !== identity.dev ||
      details.ino !== identity.ino ||
      (details.mode & 0o077) !== 0
    )
      throw new Error(
        "Herdr controller config directory could not be securely repaired to private mode (0700).",
      );
  }
  return directory;
}

async function loadControllerConfig(
  path: string,
): Promise<ControllerConfig | undefined> {
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink())
    throw new Error("Herdr controller config must be a regular file.");
  // Windows ACLs are not represented by POSIX mode bits; Herdr owns the
  // per-user plugin directory there, so the mode-bit writable check applies
  // only on hosts where Node can report meaningful POSIX permissions.
  if (process.platform !== "win32" && (details.mode & 0o022) !== 0)
    throw new Error(
      "Herdr controller config must not be group- or world-writable.",
    );
  try {
    return validateControllerConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new Error(
      `Herdr controller config is invalid: ${(error as Error).message}`,
    );
  }
}

async function saveControllerConfig(
  configPath: string,
  config: ControllerConfig,
): Promise<void> {
  const temporary = join(
    dirname(configPath),
    `.${CONTROLLER_CONFIG_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${jsonText(config)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, configPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function removeControllerConfig(configPath: string): Promise<void> {
  const temporary = join(
    dirname(configPath),
    `.${CONTROLLER_CONFIG_NAME}.removed.${process.pid}.${randomUUID()}.tmp`,
  );
  await rename(configPath, temporary);
  await rm(temporary, { force: true });
}

function validateAuthorizationPolicy(input: unknown): AuthorizationPolicy {
  if (
    !isRecord(input) ||
    !exactKeys(input, ["version", "scope", "capabilities"])
  )
    throw new Error(
      "authorizationPolicy must contain only version, scope, and capabilities.",
    );
  if (input.version !== 1)
    throw new Error("authorizationPolicy.version must be 1.");
  if (
    !isRecord(input.scope) ||
    !exactKeys(input.scope, ["workflow", "localOnly"])
  )
    throw new Error(
      "authorizationPolicy.scope must contain only workflow and localOnly.",
    );
  if (
    input.scope.workflow !== BB029_AUTHORIZATION_SCOPE ||
    input.scope.localOnly !== true
  )
    throw new Error(
      `authorizationPolicy is restricted to ${BB029_AUTHORIZATION_SCOPE} local-only work.`,
    );
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0)
    throw new Error(
      "authorizationPolicy.capabilities must be a non-empty array.",
    );
  const capabilities = input.capabilities.map((capability) => {
    if (
      typeof capability !== "string" ||
      !AUTHORIZATION_CAPABILITIES.includes(
        capability as AuthorizationCapability,
      )
    )
      throw new Error(
        `authorizationPolicy cannot authorize ${String(capability)}.`,
      );
    return capability as AuthorizationCapability;
  });
  if (new Set(capabilities).size !== capabilities.length)
    throw new Error(
      "authorizationPolicy.capabilities must not contain duplicates.",
    );
  return {
    version: 1,
    scope: { workflow: BB029_AUTHORIZATION_SCOPE, localOnly: true },
    capabilities,
  };
}

function authorizationDecision(
  workflow: Workflow,
  operation: AutonomousOperation,
): AuthorizationDecision {
  if (!workflow.authorizationPolicy)
    return {
      allowed: false,
      operation,
      reason:
        "no authorizationPolicy is recorded; explicit root approval is required",
    };
  let policy: AuthorizationPolicy;
  try {
    policy = validateAuthorizationPolicy(workflow.authorizationPolicy);
  } catch (error) {
    return {
      allowed: false,
      operation,
      reason: `recorded authorizationPolicy is invalid: ${(error as Error).message}`,
    };
  }
  if (
    !new RegExp(`\\b${BB029_AUTHORIZATION_SCOPE}\\b`, "i").test(
      workflow.objective,
    )
  )
    return {
      allowed: false,
      operation,
      reason: `workflow objective is not bound to ${BB029_AUTHORIZATION_SCOPE}`,
      policy,
    };
  const required: Record<AutonomousOperation, AuthorizationCapability[]> = {
    dispatch: ["local-herdr-topology", "foreground-tests", "durable-ledger"],
    retry: [
      "local-herdr-topology",
      "foreground-tests",
      "observe-retry-review",
      "durable-ledger",
    ],
    resume: ["observe-retry-review", "durable-ledger", "paused-goal-recovery"],
  };
  if (workflow.worktree) required[operation].push("clean-local-worktrees");
  const missing = required[operation].filter(
    (capability) => !policy.capabilities.includes(capability),
  );
  return missing.length === 0
    ? {
        allowed: true,
        operation,
        reason: "preauthorized local operation",
        policy,
      }
    : {
        allowed: false,
        operation,
        reason: `authorizationPolicy lacks ${missing.join(", ")}`,
        policy,
      };
}

function auditAuthorization(
  workflow: Workflow,
  decision: AuthorizationDecision,
): void {
  workflow.evidence.push({
    at: now(),
    kind: decision.allowed
      ? "authorization-policy-granted"
      : "authorization-policy-denied",
    text: `Autonomous ${decision.operation}: ${decision.reason}${
      decision.policy
        ? `; scope=${decision.policy.scope.workflow}; capabilities=${decision.policy.capabilities.join(",")}`
        : ""
    }`,
  });
}

function workflowFor(manifest: Manifest, id: string): Workflow {
  const workflow = manifest.workflows.find((item) => item.id === id);
  if (!workflow) throw new Error(`Unknown Herdr workflow: ${id}`);
  return workflow;
}

function parseJson(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Herdr returned non-JSON output: ${clip(stdout, 1000)}`);
  }
}

function deepString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  for (const key of keys)
    if (typeof object[key] === "string" && object[key])
      return object[key] as string;
  for (const child of Object.values(object)) {
    const found = deepString(child, keys);
    if (found) return found;
  }
  return undefined;
}

function deepState(value: unknown): string | undefined {
  return deepString(value, ["agent_status", "state", "agent_state", "status"]);
}

function nativeSessionFromAgent(value: unknown): NativeSessionRef | undefined {
  if (!isRecord(value) || !isRecord(value.agent_session)) return undefined;
  const session = value.agent_session;
  if (
    (session.kind !== "path" && session.kind !== "id") ||
    typeof session.value !== "string" ||
    !session.value
  )
    return undefined;
  return { kind: session.kind, value: session.value };
}

const SESSION_LOG_STATUSES: SessionLogStatus[] = [
  "planned",
  "dispatched",
  "working",
  "idle",
  "done",
  "completed",
  "retired",
  "gone",
];

function validSessionLogStatus(
  value: unknown,
  fallback: SessionLogStatus,
): SessionLogStatus {
  return typeof value === "string" && SESSION_LOG_STATUSES.includes(value as SessionLogStatus)
    ? (value as SessionLogStatus)
    : fallback;
}

function laterTimestamp(
  left: string | undefined,
  right: string | undefined,
): string | undefined {
  if (!left) return right;
  if (!right) return left;
  const leftAt = Date.parse(left);
  const rightAt = Date.parse(right);
  if (!Number.isFinite(leftAt)) return right;
  if (!Number.isFinite(rightAt)) return left;
  return rightAt > leftAt ? right : left;
}

function latestLaneLedgerResponseAt(
  workflow: Workflow,
  lane: Lane,
): string | undefined {
  const events = workflow.eventController?.events;
  if (!Array.isArray(events)) return undefined;
  let latest: string | undefined;
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.pane_id !== undefined) {
      if (event.pane_id !== lane.paneId) continue;
    } else if (event.lane_id !== lane.id) continue;
    const at =
      typeof event.received_at === "string"
        ? event.received_at
        : typeof event.at === "string"
          ? event.at
          : undefined;
    if (at && Number.isFinite(Date.parse(at))) latest = laterTimestamp(latest, at);
  }
  return latest;
}

function sessionStatusForLane(
  lane: Lane,
  nativeState?: string,
  fallback: SessionLogStatus = "dispatched",
): SessionLogStatus {
  if (lane.sessionLog?.status === "retired") return "retired";
  if (
    lane.completionReceipt ||
    lane.status === "completion-reported" ||
    lane.status === "completed" ||
    lane.status === "operator-closed"
  )
    return "completed";
  if (nativeState === "working") return "working";
  if (nativeState === "idle") return "idle";
  if (nativeState === "done") return "done";
  if (nativeState === "gone") return "gone";
  // Herdr's blocked state has no corresponding session-log state. Preserve a
  // prior valid lifecycle state rather than inventing a second vocabulary.
  return validSessionLogStatus(lane.sessionLog?.status, fallback);
}

function syncLaneSessionLog(
  workflow: Workflow,
  lane: Lane,
  nativeState?: string,
): void {
  const current = lane.sessionLog;
  if (!current) return;
  const responseAt = latestLaneLedgerResponseAt(workflow, lane);
  lane.sessionLog = {
    ...current,
    kind: "lane",
    workflowId: workflow.id,
    laneId: lane.id,
    ...(lane.paneId ? { paneId: lane.paneId } : {}),
    ...(lane.tabId ? { tabId: lane.tabId } : {}),
    ...(workflow.ownership.workspaceId
      ? { workspaceId: workflow.ownership.workspaceId }
      : {}),
    ...(workflow.worktree ? { worktree: workflow.worktree } : {}),
    status: sessionStatusForLane(lane, nativeState),
    ...(responseAt
      ? { lastResponseAt: laterTimestamp(current.lastResponseAt, responseAt) }
      : {}),
  };
}

const piRootSessionPathHints = new WeakMap<object, string>();

function attestedPiRootSessionPath(
  root: ControllerRootMapping,
  native: NativeSessionRef | undefined,
  sessionPath: string | undefined,
): string | undefined {
  if (
    root.agent_kind !== "pi" ||
    native?.kind !== "id" ||
    typeof sessionPath !== "string" ||
    !isAbsolute(sessionPath)
  )
    return undefined;
  try {
    const info = lstatSync(sessionPath);
    const canonical = realpathSync(sessionPath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !basename(canonical).endsWith(`_${native.value}.jsonl`)
    )
      return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

function rootSessionPersistence(
  root: ControllerRootMapping,
  agent: unknown,
): PersistenceHandle {
  const native = nativeSessionFromAgent(agent);
  const sessionPath = attestedPiRootSessionPath(
    root,
    native,
    isRecord(agent) ? piRootSessionPathHints.get(agent) : undefined,
  );
  if (native && sessionPath)
    return {
      provider: "pi",
      sessionId: native.value,
      nativeHandle: native,
      metadata: { sessionPath },
    };
  if (native)
    return toPersistenceHandle(native, root.agent_kind ?? "herdr");
  const sessionId =
    (isRecord(agent) && typeof agent.session_id === "string" && agent.session_id) ||
    `${root.workspace_id}:${root.pane_id}`;
  return {
    provider: root.agent_kind ?? "herdr",
    sessionId,
    nativeHandle: {
      kind: "pane",
      paneId: root.pane_id,
      workspaceId: root.workspace_id,
    },
  };
}

function rootSessionStatus(
  agent: unknown,
  fallback: SessionLogStatus = "idle",
): SessionLogStatus {
  const state = deepState(agent);
  if (state === "working") return "working";
  if (state === "idle") return "idle";
  if (state === "done") return "done";
  return validSessionLogStatus(fallback, "idle");
}

function rootSessionEntry(
  root: ControllerRootMapping,
  agent: unknown,
  previous: SessionLogEntry | undefined,
  startedAt: string,
  lastResponseAt: string | undefined,
): SessionLogEntry {
  const prior =
    previous?.kind === "root" &&
    previous.paneId === root.pane_id &&
    previous.workspaceId === root.workspace_id
      ? previous
      : undefined;
  return {
    kind: "root",
    sessionRef: rootSessionPersistence(root, agent),
    startedAt: prior?.startedAt ?? startedAt,
    ...(laterTimestamp(prior?.lastResponseAt, lastResponseAt)
      ? {
          lastResponseAt: laterTimestamp(
            prior?.lastResponseAt,
            lastResponseAt,
          ),
        }
      : {}),
    status: rootSessionStatus(agent, prior?.status),
    paneId: root.pane_id,
    workspaceId: root.workspace_id,
  };
}

function sessionLogEntries(
  manifest: ManifestWithRootState,
  rootId?: string,
): SessionLogEntry[] {
  const entries: SessionLogEntry[] = [];
  const scopedRoots = rootId
    ? manifest.rootSessionLogs?.filter((entry) => entry.rootId === rootId) ?? []
    : manifest.rootSessionLogs ?? [];
  entries.push(...scopedRoots.map((entry) => ({ ...entry })));
  if (
    manifest.sessionLog &&
    (!rootId || !manifest.rootSessionLogs)
  ) {
    const alreadyIncluded = scopedRoots.some(
      (entry) =>
        entry.paneId === manifest.sessionLog!.paneId &&
        entry.workspaceId === manifest.sessionLog!.workspaceId,
    );
    if (!alreadyIncluded) entries.push({ ...manifest.sessionLog });
  }
  for (const workflow of manifest.workflows)
    for (const lane of workflow.lanes)
      if (lane.sessionLog) {
        const responseAt = latestLaneLedgerResponseAt(workflow, lane);
        entries.push({
          ...lane.sessionLog,
          ...(responseAt
            ? {
                lastResponseAt: laterTimestamp(
                  lane.sessionLog.lastResponseAt,
                  responseAt,
                ),
              }
            : {}),
        });
      }
  return entries;
}

function goneAgentError(error: unknown): boolean {
  return /agent_not_found|agent_not_running|agent_pane_not_found|agent_pane_unavailable|ENOENT/i.test(
    String(error),
  );
}

function contract(workflow: Workflow, lane: Lane): string {
  const agentKind = laneAgentKind(workflow, lane);
  return [
    "You are a delegated coding-agent session managed exclusively by Herdr.",
    `Agent kind: ${agentKind}`,
    `Workflow: ${workflow.id}`,
    `Objective: ${lane.objective}`,
    `Lane: ${lane.id}`,
    `Parent-child relationship: ${lane.relationshipId ?? "pending"}`,
    lane.readOnly
      ? "This lane is declared read-only: do not modify files, Git state, or external systems."
      : "Contract: work only in the assigned cwd; report concise progress, commands, tests, evidence, and blockers.",
    "Do not create subagents, background jobs, detached tasks, or another agent session.",
    "Run tests synchronously in this pane, or ask the caller to create an explicit Herdr test pane.",
    "Frozen installs, builds, codegen, typecheck, lint and tests in this worktree are routine: run them. When the root's policy grants local-validation, a permission prompt for one is answered by policy; never ask for them in chat.",
    "A recorded local authorization policy applies only to the designated root's dispatch, retry, and Pi paused-goal recovery; it grants this child no approval authority.",
    "Use herdr_message for durable informational facts the parent should review, including after herdr_complete; use the question flow for Zach's decisions and herdr_complete for the one lane receipt.",
    "Ask for ports, database names, runtime launches and approvals with herdr_request (lease, runtime-launch, approval), never in chat; policy-matching requests are answered at once and the rest stay open until the root answers.",
    "Never push, merge, deploy, create a PR, mutate production or external services, or close Herdr resources.",
    `Before ending, you MUST call herdr_complete({ workflowId: "${workflow.id}", summary: "<outcome, evidence, blockers>" }) exactly once after verifying the work. A chat-only outcome is insufficient and does not complete this lane.`,
    "Then state the same outcome/evidence clearly. Generic Herdr done events are fallback-only; the durable herdr_complete receipt is required for normal completion.",
  ].join("\n");
}

/** The lane assignment plus the runtime leases it must use. */
function contractWithLeases(
  workflow: Workflow,
  lane: Lane,
  leases: Lease[] | undefined,
): string {
  const base = contract(workflow, lane);
  if (!leases?.length) return base;
  return [
    base,
    "Runtime leases reserved for this lane (use only these ports and names; request more with herdr_lease):",
    ...leaseLines(leases).map((line) => `- ${line}`),
  ].join("\n");
}

function requireHerdr(): void {
  if (process.env.HERDR_ENV !== "1")
    throw new Error(
      "HERDR_ENV=1 is required; dispatch and close are unavailable outside a Herdr pane.",
    );
}

type GitMetadataDirectories = {
  gitDirectory: string;
  commonDirectory: string;
};

/** Resolve the directories Git will mutate for a checkout without invoking a
 * mutating Git command. Linked worktrees keep their administrative metadata
 * outside the checkout, which is the path Codex's workspace-write sandbox can
 * leave unwritable. */
async function gitMetadataDirectories(
  cwd: string,
): Promise<GitMetadataDirectories> {
  const dotGit = join(resolve(cwd), ".git");
  const details = await lstat(dotGit);
  if (details.isSymbolicLink())
    throw new Error(
      ".git is a symbolic link; Git metadata ownership is ambiguous.",
    );
  let gitDirectory: string;
  if (details.isDirectory()) gitDirectory = dotGit;
  else if (details.isFile()) {
    const pointer = (await readFile(dotGit, "utf8")).trim();
    const match = /^gitdir:\s*(.+)$/i.exec(pointer);
    if (!match)
      throw new Error(".git is not a valid Git worktree metadata pointer.");
    gitDirectory = resolve(dirname(dotGit), match[1].trim());
  } else throw new Error(".git is not a regular directory or worktree pointer.");

  let commonDirectory = gitDirectory;
  try {
    const common = (await readFile(join(gitDirectory, "commondir"), "utf8"))
      .trim();
    if (common) commonDirectory = resolve(gitDirectory, common);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { gitDirectory, commonDirectory };
}

async function inspectCodexSandboxGitMetadata(
  cwd: string,
): Promise<{ status: "ok" | "warn" | "fail"; detail: string }> {
  let directories: GitMetadataDirectories;
  try {
    directories = await gitMetadataDirectories(cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        status: "warn",
        detail: `No Git metadata found under ${resolve(cwd)}; this check is not applicable to a non-Git checkout.`,
      };
    return {
      status: "fail",
      detail: `Cannot resolve Git metadata for ${resolve(cwd)}: ${(error as Error).message}`,
    };
  }
  const paths = [
    ...new Set([directories.gitDirectory, directories.commonDirectory]),
  ];
  const blocked: string[] = [];
  for (const path of paths) {
    try {
      const details = await lstat(path);
      if (!details.isDirectory() || details.isSymbolicLink())
        blocked.push(`${path} (not a real directory)`);
      else await access(path, fsConstants.W_OK);
    } catch {
      blocked.push(path);
    }
  }
  if (blocked.length)
    return {
      status: "fail",
      detail: `Codex sandbox cannot write Git metadata: ${blocked.join(", ")}. A parent-side commit/reconciliation is required.`,
    };
  return {
    status: "ok",
    detail: `Git metadata directories are writable: ${paths.join(", ")}.`,
  };
}

function configuredControllerConfigPath(): string | undefined {
  const configuredDirectory = process.env[HERDR_PLUGIN_CONFIG_DIR_ENV];
  if (configuredDirectory && isAbsolute(configuredDirectory)) {
    const configuredPath = join(
      resolve(configuredDirectory),
      CONTROLLER_CONFIG_NAME,
    );
    try {
      const details = lstatSync(configuredPath);
      if (details.isFile() && !details.isSymbolicLink()) return configuredPath;
    } catch {
      // A project-scoped harness registration can freeze a path from a
      // different platform or Herdr installation. Fall through to the native
      // platform location instead of treating that snapshot as authoritative.
    }
  }
  return undefined;
}

function rootConfigPath(): string {
  const configuredPath = configuredControllerConfigPath();
  if (configuredPath) return configuredPath;
  const directory =
    process.platform === "win32"
      ? join(
          process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
          "herdr",
          "plugins",
          "config",
          CONTROLLER_PLUGIN_ID,
        )
      : join(
          homedir(),
          ".config",
          "herdr",
          "plugins",
          "config",
          CONTROLLER_PLUGIN_ID,
        );
  return join(directory, CONTROLLER_CONFIG_NAME);
}

function readControllerConfigForCurrentPane(): ControllerConfig | undefined {
  try {
    const path = rootConfigPath();
    const details = lstatSync(path);
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      (process.platform !== "win32" && (details.mode & 0o022) !== 0)
    )
      return undefined;
    return validateControllerConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

function isRegisteredRootIdentity(identity: {
  paneId?: string;
  workspaceId?: string;
}): boolean {
  if (!identity.paneId || !identity.workspaceId) return false;
  return (
    readControllerConfigForCurrentPane()?.orchestrators.some(
      (record) =>
        record.root.pane_id === identity.paneId &&
        record.root.workspace_id === identity.workspaceId,
    ) ?? false
  );
}

function liveClaudeAgentAtIdentity(
  agents: unknown[],
  identity: { paneId?: string; workspaceId?: string },
): boolean {
  return agents.some((value) => {
    if (!isRecord(value)) return false;
    const session = isRecord(value.agent_session)
      ? value.agent_session
      : undefined;
    const kind =
      typeof value.agent === "string"
        ? value.agent
        : typeof session?.agent === "string"
          ? session.agent
          : undefined;
    return (
      kind === "claude" &&
      value.pane_id === identity.paneId &&
      value.workspace_id === identity.workspaceId
    );
  });
}

function isRootOrchestrator(): boolean {
  return isRegisteredRootIdentity({
    paneId: process.env[HERDR_PANE_ID_ENV],
    workspaceId: process.env.HERDR_WORKSPACE_ID,
  });
}

function currentResolvedIdentityDescription(): string {
  return `(resolved pane_id=${process.env[HERDR_PANE_ID_ENV] ?? "<unset>"}, workspace_id=${process.env.HERDR_WORKSPACE_ID ?? "<unset>"})`;
}

type CurrentRootScope = {
  rootId: string;
  root: ControllerRootMapping;
  orchestrator: ControllerOrchestrator;
};

function rootOwnsManifest(record: ControllerOrchestrator, cwd: string): boolean {
  const target = resolve(cwd);
  return (
    record.program.id === "legacy-global" ||
    samePath(record.program.id, target) ||
    (record.program.parent_manifest_path !== undefined &&
      samePath(record.program.parent_manifest_path, manifestPath(cwd)))
  );
}

function currentRootScope(cwd: string): CurrentRootScope | undefined {
  const paneId = process.env[HERDR_PANE_ID_ENV];
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (!paneId || !workspaceId) return undefined;
  const record = readControllerConfigForCurrentPane()?.orchestrators.find(
    (candidate) =>
      candidate.root.pane_id === paneId &&
      candidate.root.workspace_id === workspaceId &&
      rootOwnsManifest(candidate, cwd),
  );
  return record
    ? { rootId: record.id, root: record.root, orchestrator: record }
    : undefined;
}

function isRootForManifest(cwd: string): boolean {
  return currentRootScope(cwd) !== undefined;
}

function manifestRootCandidates(cwd: string): ControllerOrchestrator[] {
  return (
    readControllerConfigForCurrentPane()?.orchestrators.filter((record) =>
      rootOwnsManifest(record, cwd),
    ) ?? []
  );
}

function legacyRootIdForManifest(cwd: string): string | undefined {
  const candidates = manifestRootCandidates(cwd);
  const session = readManifestRootSession(cwd);
  if (session) {
    const match = candidates.find(
      (record) =>
        record.root.pane_id === session.paneId &&
        record.root.workspace_id === session.workspaceId,
    );
    if (match) return match.id;
  }
  return candidates[0]?.id;
}

function readManifestRootSession(cwd: string): SessionLogEntry | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(manifestPath(cwd), "utf8"),
    ) as { sessionLog?: unknown };
    return isRecord(parsed.sessionLog) && parsed.sessionLog.kind === "root"
      ? (parsed.sessionLog as unknown as SessionLogEntry)
      : undefined;
  } catch {
    return undefined;
  }
}

function rootSessionLogFor(
  manifest: ManifestWithRootState,
  rootId: string,
): RootSessionLogEntry | undefined {
  return manifest.rootSessionLogs?.find((entry) => entry.rootId === rootId);
}

function ensureRootGoalStore(
  manifest: ManifestWithRootState,
  cwd: string,
): RootGoalStore {
  if (!manifest.parentGoals) manifest.parentGoals = {};
  const ownerId = legacyRootIdForManifest(cwd);
  const owner = ownerId
    ? manifestRootCandidates(cwd).find((record) => record.id === ownerId)
    : undefined;
  if (ownerId && manifest.parentGoal && !manifest.parentGoals[ownerId]) {
    manifest.parentGoals[ownerId] = {
      ...JSON.parse(JSON.stringify(manifest.parentGoal)),
      rootId: ownerId,
      root: owner?.root,
    } as RootParentGoal;
    if (Array.isArray(manifest.goalHistory))
      (manifest.goalHistoryByRoot ??= {})[ownerId] = JSON.parse(
        JSON.stringify(manifest.goalHistory),
      ) as GoalHistoryRecord[];
  }
  return manifest.parentGoals;
}

function rootGoalRecordFor(
  manifest: ManifestWithRootState,
  cwd: string,
  scope: CurrentRootScope,
  create = false,
): RootGoalRecord | undefined {
  const store = create
    ? ensureRootGoalStore(manifest, cwd)
    : manifest.parentGoals;
  const goal = store?.[scope.rootId];
  if (!goal) return undefined;
  return {
    rootId: scope.rootId,
    root: goal.root ?? scope.root,
    goal,
    goalHistory: manifest.goalHistoryByRoot?.[scope.rootId] ?? [],
  };
}

function ensureRootGoalRecord(
  manifest: ManifestWithRootState,
  cwd: string,
  scope: CurrentRootScope,
): RootGoalRecord {
  const existing = rootGoalRecordFor(manifest, cwd, scope, true);
  if (existing) return existing;
  if (!manifest.goalHistoryByRoot) manifest.goalHistoryByRoot = {};
  const goalHistory = (manifest.goalHistoryByRoot[scope.rootId] ??= []);
  return {
    rootId: scope.rootId,
    root: scope.root,
    goalHistory,
  };
}

function rootGoalFor(
  manifest: ManifestWithRootState,
  cwd: string,
  scope: CurrentRootScope,
): { goal?: ParentGoal; record?: RootGoalRecord; legacy: boolean } {
  const record = rootGoalRecordFor(manifest, cwd, scope);
  if (record) return { goal: record.goal, record, legacy: false };
  const legacyOwnerId = legacyRootIdForManifest(cwd);
  if (manifest.parentGoal && legacyOwnerId === scope.rootId)
    return { goal: manifest.parentGoal, legacy: true };
  return { legacy: false };
}

function rootSessionEntryFor(
  manifest: ManifestWithRootState,
  cwd: string,
  scope: CurrentRootScope,
  agent: unknown,
  startedAt: string,
  lastResponseAt?: string,
  forceScoped = false,
): RootSessionLogEntry {
  const priorScoped = rootSessionLogFor(manifest, scope.rootId);
  const legacyOwner = legacyRootIdForManifest(cwd) === scope.rootId;
  const prior = priorScoped ?? (legacyOwner ? manifest.sessionLog : undefined);
  const entry: RootSessionLogEntry = {
    ...rootSessionEntry(scope.root, agent, prior, startedAt, lastResponseAt),
    rootId: scope.rootId,
    root: scope.root,
  };
  const useScoped = forceScoped || Boolean(manifest.rootSessionLogs) || Boolean(manifest.parentGoals);
  if (useScoped) {
    const entries = (manifest.rootSessionLogs ??= []);
    const legacyOwnerId = legacyRootIdForManifest(cwd);
    const legacyOwner = legacyOwnerId
      ? manifestRootCandidates(cwd).find((candidate) => candidate.id === legacyOwnerId)
      : undefined;
    if (
      legacyOwnerId &&
      manifest.sessionLog &&
      !entries.some((candidate) => candidate.rootId === legacyOwnerId)
    )
      entries.push({
        ...manifest.sessionLog,
        rootId: legacyOwnerId,
        root: legacyOwner?.root ?? scope.root,
      });
    const index = entries.findIndex((candidate) => candidate.rootId === scope.rootId);
    if (index === -1) entries.push(entry);
    else entries[index] = entry;
  }
  // Keep the original single-root field as a compatibility projection. The
  // controller still consumes it, and it always belongs to the first root
  // that owned a legacy manifest.
  if (
    legacyOwner &&
    (!useScoped || scope.rootId === legacyRootIdForManifest(cwd))
  ) {
    const { rootId: _rootId, root: _root, ...legacyEntry } = entry;
    manifest.sessionLog = legacyEntry;
  }
  return entry;
}

function rootQueueRecordFor(
  manifest: ManifestWithRootState,
  rootId: string,
): RootQueueRecord | undefined {
  return manifest.rootQueues?.roots.find((record) => record.rootId === rootId);
}

function ensureRootQueueRecord(
  manifest: ManifestWithRootState,
  cwd: string,
  scope: CurrentRootScope,
): RootQueueRecord {
  const store = ensureRootQueueStore(manifest, cwd);
  const existing = store.roots.find((record) => record.rootId === scope.rootId);
  if (existing) {
    existing.root = scope.root;
    return existing;
  }
  const record: RootQueueRecord = {
    version: ROOT_QUEUES_SCHEMA_VERSION,
    rootId: scope.rootId,
    root: scope.root,
    itemIds: [],
  };
  store.roots.push(record);
  return record;
}

function ensureRootQueueStore(
  manifest: ManifestWithRootState,
  cwd: string,
): RootQueueStore {
  if (!manifest.rootQueues)
    manifest.rootQueues = { version: ROOT_QUEUES_SCHEMA_VERSION, roots: [] };
  const ownerId = legacyRootIdForManifest(cwd);
  const owner = ownerId
    ? manifestRootCandidates(cwd).find((record) => record.id === ownerId)
    : undefined;
  if (ownerId && !rootQueueRecordFor(manifest, ownerId))
    manifest.rootQueues.roots.push({
      version: ROOT_QUEUES_SCHEMA_VERSION,
      rootId: ownerId,
      root: owner?.root ?? {
        target: ownerId,
        target_kind: "pane_id",
        pane_id: ownerId,
        workspace_id: "legacy",
      },
      itemIds: manifest.queue?.items.map((item) => item.id) ?? [],
    });
  return manifest.rootQueues;
}

function queueItemIdsForRoot(
  manifest: ManifestWithRootState,
  cwd: string,
  scope: CurrentRootScope,
): Set<string> {
  const record = rootQueueRecordFor(manifest, scope.rootId);
  if (record) return new Set(record.itemIds);
  // A legacy queue has no ownership metadata and is entirely owned by the
  // originally registered root until a second root writes to it.
  return legacyRootIdForManifest(cwd) === scope.rootId
    ? new Set(manifest.queue?.items.map((item) => item.id) ?? [])
    : new Set();
}

function queueViewForRoot(
  manifest: ManifestWithQueue,
  cwd: string,
  scope: CurrentRootScope | undefined,
): QueueStore | undefined {
  const queue = queueForManifest(manifest);
  if (!queue || !scope) return queue;
  const ids = queueItemIdsForRoot(manifest, cwd, scope);
  return { ...queue, items: queue.items.filter((item) => ids.has(item.id)) };
}

function requireRootManifestExecutor(cwd: string): CurrentRootScope {
  requireRootGoalExecutor();
  const scope = currentRootScope(cwd);
  if (!scope)
    throw new Error(
      "The verified controller-mapped root does not own this queue manifest.",
    );
  return scope;
}

function isRegisteredChildLane(): boolean {
  const paneId = process.env[HERDR_PANE_ID_ENV];
  if (!paneId) return false;
  return (
    readControllerConfigForCurrentPane()?.orchestrators.some((record) =>
      record.workflows.some((workflow) =>
        workflow.lanes.some((lane) => lane.pane_id === paneId),
      ),
    ) ?? false
  );
}

function requestParentApproval(
  workflow: Workflow,
  action: ApprovalRequest["action"],
): ApprovalRequest {
  workflow.approvalRequests ??= [];
  const existing = workflow.approvalRequests.find(
    (request) =>
      request.action === action &&
      request.status === "parent-approval-required",
  );
  if (existing) return existing;
  const request: ApprovalRequest = {
    id: `approval-${randomUUID().slice(0, 8)}`,
    action,
    status: "parent-approval-required",
    requestedAt: now(),
    request:
      `Parent approval required for ${action} of ${workflow.id}. ` +
      "Observe the requesting child through Herdr, then run from the verified controller-mapped root.",
  };
  workflow.approvalRequests.push(request);
  workflow.evidence.push({
    at: now(),
    kind: "parent-approval-required",
    text: request.request,
  });
  return request;
}

function resolveParentApproval(
  workflow: Workflow,
  action: ApprovalRequest["action"],
  status: "approved" | "cancelled",
): void {
  const request = workflow.approvalRequests
    ?.slice()
    .reverse()
    .find(
      (item) =>
        item.action === action && item.status === "parent-approval-required",
    );
  if (!request) return;
  request.status = status;
  request.resolvedAt = now();
}

function currentChildAssignment() {
  const paneId = process.env.HERDR_PANE_ID;
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  const matches =
    readControllerConfigForCurrentPane()?.orchestrators.flatMap((record) =>
      record.workflows.flatMap((workflow) =>
        workflow.lanes
          .filter(
            (lane) =>
              lane.pane_id === paneId && lane.workspace_id === workspaceId,
          )
          .map((lane) => ({ record, workflow, lane })),
      ),
    ) ?? [];
  if (matches.length !== 1)
    throw new Error(
      "Child routing requires exactly one registered pane/workspace assignment; no cwd fallback is allowed.",
    );
  const match = matches[0];
  const cwd = dirname(dirname(dirname(match.workflow.manifest_path)));
  if (resolve(manifestPath(cwd)) !== resolve(match.workflow.manifest_path))
    throw new Error(
      "Registered child manifest path does not use the supported store layout.",
    );
  return { ...match, cwd };
}

async function persistParentQuestion(
  cwd: string,
  input: unknown,
): Promise<{ request: ParentQuestionRequest; created: boolean }> {
  const assignment = currentChildAssignment();
  // cwd is a code location, never routing authority.
  cwd = assignment.cwd;
  const release = await acquireManifestLock(cwd, 10_000);
  try {
    const manifest = await loadManifest(cwd);
    const workflow = workflowFor(manifest, assignment.workflow.workflow_id);
    if (
      !workflow.lanes.some(
        (lane) =>
          lane.id === assignment.lane.lane_id &&
          lane.paneId === assignment.lane.pane_id,
      )
    )
      throw new Error(
        "Child assignment differs from the authoritative manifest.",
      );
    const question = clip(jsonText(input), 6000);
    const paneId = assignment.lane.pane_id;
    const requests = (workflow.questionRequests ??= []);
    const existing = requests.find(
      (request) =>
        request.status === "parent-question-required" &&
        request.question === question &&
        request.paneId === paneId,
    );
    if (existing) return { request: existing, created: false };
    const request: ParentQuestionRequest = {
      id: `question-${randomUUID().slice(0, 8)}`,
      kind: "question",
      status: "parent-question-required",
      requestedAt: now(),
      workflowId: workflow.id,
      paneId,
      question,
      delivery: { status: "pending", updatedAt: now() },
    };
    requests.push(request);
    workflow.evidence.push({
      at: now(),
      kind: "parent-question-required",
      text: `Question ${request.id} is durable in the authoritative parent store.`,
    });
    await saveManifest(cwd, manifest);
    return { request, created: true };
  } finally {
    await release();
  }
}

async function persistParentMessage(
  cwd: string,
  workflowId: string,
  summary: string,
  details?: string,
): Promise<{ request: MessageRecord; created: boolean }> {
  requireHerdr();
  if (isRootOrchestrator())
    throw new Error(
      "The verified root has no parent to message; use the root's normal workflow tools instead.",
    );
  const assignment = currentChildAssignment();
  // cwd is a code location, never routing authority.
  cwd = assignment.cwd;
  if (assignment.workflow.workflow_id !== workflowId)
    throw new Error("Message is outside this participant's assignment.");
  const normalizedSummary = summary.trim();
  if (!normalizedSummary)
    throw new Error("Message summary must be a non-empty string.");
  if (normalizedSummary.length > MESSAGE_SUMMARY_MAX_LENGTH)
    throw new Error(
      `Message summary must be no longer than ${MESSAGE_SUMMARY_MAX_LENGTH} characters.`,
    );
  const normalizedDetails = details?.trim();
  if (normalizedDetails && normalizedDetails.length > MESSAGE_DETAILS_MAX_LENGTH)
    throw new Error(
      `Message details must be no longer than ${MESSAGE_DETAILS_MAX_LENGTH} characters.`,
    );
  const requestedAt = now();
  const release = await acquireManifestLock(cwd, 10_000);
  try {
    const manifest = await loadManifest(cwd);
    const workflow = workflowFor(manifest, workflowId);
    if (
      !workflow.lanes.some(
        (lane) =>
          lane.id === assignment.lane.lane_id &&
          lane.paneId === assignment.lane.pane_id,
      )
    )
      throw new Error(
        "Child assignment differs from the authoritative manifest.",
      );
    const requests = (workflow.messageRequests ??= []);
    const existing = requests.find((request) => {
      if (
        request.workflowId !== workflow.id ||
        request.laneId !== assignment.lane.lane_id ||
        request.summary !== normalizedSummary
      )
        return false;
      const at = Date.parse(request.requestedAt);
      return Number.isFinite(at) &&
        Math.abs(Date.parse(requestedAt) - at) <= MESSAGE_DEDUPE_WINDOW_MS;
    });
    if (existing) return { request: existing, created: false };
    const request: MessageRecord = {
      version: 1,
      id: `message-${randomUUID().slice(0, 8)}`,
      workflowId: workflow.id,
      laneId: assignment.lane.lane_id,
      summary: normalizedSummary,
      ...(normalizedDetails ? { details: normalizedDetails } : {}),
      kind: "informational",
      requestedAt,
      delivery: {
        status: "pending",
        attempts: 0,
        updatedAt: requestedAt,
      },
    };
    requests.push(request);
    workflow.evidence.push({
      at: now(),
      kind: "child-message",
      text: `Informational message ${request.id} is durable for ${request.workflowId}/${request.laneId}.`,
    });
    await saveManifest(cwd, manifest);
    return { request, created: true };
  } finally {
    await release();
  }
}

/** Release a workflow's active leases inside the caller's manifest write. */
function releaseWorkflowLeases(
  manifest: { leases?: Lease[] },
  workflow: Workflow,
  reason: string,
): Lease[] {
  const released = releaseLeases(
    manifest.leases,
    (lease) => lease.workflowId === workflow.id,
    reason,
    now(),
  );
  if (released.length)
    workflow.evidence.push({
      at: now(),
      kind: "lease-released",
      text: `${reason}: ${released.map((lease) => `${lease.id} ${lease.resource}=${leaseValue(lease)}`).join(", ")}`,
    });
  return released;
}

// Process-wide: Pi renders one extension dialog at a time.
const nativeConfirms = new ConfirmQueue();

async function confirmExecution(
  ctx: ExtensionContext,
  label: string,
  explicitConfirm = false,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!isRootOrchestrator())
    throw new Error(
      "Only the verified controller-mapped root may request direct approval.",
    );
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    // A headless MCP/JSON bridge has no native confirm UI to render at all.
    // The calling harness (Claude, Codex, OpenCode) is contractually required
    // to have obtained explicit user intent before setting explicitConfirm;
    // BAA.md's dispatch guidance already states this. Without it, fail closed
    // exactly as before.
    if (explicitConfirm) return true;
    throw new Error(
      `${label} requires TUI confirmation from the designated root orchestrator.`,
    );
  }
  return nativeConfirms.confirm(
    ctx.ui,
    "Herdr orchestrator",
    `${label}? Only extension-owned resources will be changed.`,
    signal,
  );
}

export default function herdrOrchestrator(pi: ExtensionAPI) {
  registerPiIdentityBridge(pi, (ctx) => inspectPiRootIdentity(ctx, ctx.signal));

  async function inspectPiRootIdentity(ctx: ExtensionContext, signal?: AbortSignal) {
    requireHerdr();
    await refreshHerdrIdentity(signal);
    const scope = requireRootManifestExecutor(ctx.cwd);
    const root = scope.root;
    const registrations = readControllerConfigForCurrentPane()?.orchestrators.filter(
      (item) => item.id === scope.rootId || item.root.pane_id === root.pane_id || item.root.workspace_id === root.workspace_id,
    );
    if (registrations?.length !== 1)
      throw new Error("Native Pi root registration is ambiguous; no identity proof issued.");
    const raw = await runHerdr(["agent", "get", root.pane_id], signal);
    const live = liveAgentIdentity(raw, "Pi root identity");
    if (root.agent_kind !== "pi" || live.kind !== "pi" ||
        live.paneId !== root.pane_id || live.workspaceId !== root.workspace_id ||
        (root.target_kind === "name" && live.name !== root.target))
      throw new Error("Registered root differs from the live Pi pane/workspace/harness.");
    const proof = await resolvePiSessionIdentity({
      agent: responseRecord(raw, "Pi root identity").agent, runtime: ctx.sessionManager,
      paneId: root.pane_id, workspaceId: root.workspace_id, cwd: ctx.cwd,
    });
    return { ...proof, registrationId: scope.rootId };
  }

  async function rootSessionMatches(native: unknown, stored: string | undefined, ctx: ExtensionContext, signal?: AbortSignal) {
    if (!isRecord(native) || !isRecord(native.agent_session)) return false;
    if (native.agent !== "pi") return native.agent_session.value === stored;
    const proof = await inspectPiRootIdentity(ctx, signal);
    // Historical UUID bindings remain immutable and require the same fresh proof.
    if (stored === proof.sessionId || stored === proof.sessionPath) return true;
    if (!stored || !isAbsolute(stored) || /[\u0000-\u001f\u007f]/.test(stored)) return false;
    try { return await realpath(stored) === proof.sessionPath; } catch { return false; }
  }

  async function runHerdrRaw(
    args: string[],
    signal?: AbortSignal,
    timeoutMs = HERDR_COMMAND_TIMEOUT_MS,
  ): Promise<string> {
    const result = (await pi.exec("herdr", args, {
      signal,
      timeout: timeoutMs,
    })) as ExecResult;
    if (result.code !== 0)
      throw new Error(
        `herdr ${args.join(" ")} failed: ${clip(result.stderr || result.stdout, 2000)}`,
      );
    return result.stdout;
  }

  async function runHerdr(
    args: string[],
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<any> {
    return parseJson(await runHerdrRaw(args, signal, timeoutMs));
  }

  async function refreshHerdrIdentity(
    signal?: AbortSignal,
  ): Promise<{ paneId?: string; workspaceId?: string }> {
    if (!configuredControllerConfigPath()) await controllerConfigPath(signal);
    const identity =
      currentAppliedHerdrIdentity() ??
      (await resolveHerdrIdentity({
        env: process.env,
        listAgents: () => runHerdr(["agent", "list"], signal),
        currentCwd: process.cwd(),
        allowStaticFallback: ({ fallback, agents }) =>
          isRegisteredRootIdentity(fallback) &&
          liveClaudeAgentAtIdentity(agents, fallback),
      }));
    applyHerdrIdentity(process.env, identity);
    return identity;
  }

  async function sendMessage(
    cwd: string,
    workflowId: string,
    summary: string,
    details: string | undefined,
    signal?: AbortSignal,
  ) {
    const persisted = await persistParentMessage(
      cwd,
      workflowId,
      summary,
      details,
    );
    const request = persisted.request;
    if (!persisted.created && request.delivery.status !== "pending")
      return { ...persisted, delivery: request.delivery.status };
    const herdr = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "agent.get")
          return runHerdr(
            ["agent", "get", String(params.target)],
            signal,
          );
        if (method === "agent.prompt")
          return runHerdr(
            [
              "agent",
              "prompt",
              String(params.target),
              String(params.text),
            ],
            signal,
          );
        throw new Error(`Unsupported controller Herdr request: ${method}`);
      },
    };
    const routed = (await routeChildMessage({
      configDir: resolve(dirname(rootConfigPath())),
      workflowId,
      laneId: request.laneId,
      messageId: request.id,
      herdr,
    })) as { delivery?: unknown } & Record<string, unknown>;
    return { ...persisted, ...routed, delivery: routed.delivery };
  }

  async function assertCleanLocalWorktree(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const root = (await pi.exec(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { signal, timeout: HERDR_COMMAND_TIMEOUT_MS },
    )) as ExecResult;
    if (root.code !== 0 || !root.stdout.trim())
      throw new Error(
        `worktreeCwd must be an existing local Git worktree: ${clip(root.stderr || root.stdout, 1000)}`,
      );
    const checkoutPath = resolve(root.stdout.trim());
    if (!samePath(cwd, checkoutPath))
      throw new Error(
        "worktreeCwd must name the Git worktree root, not a subdirectory.",
      );
    const result = (await pi.exec(
      "git",
      ["-C", checkoutPath, "status", "--porcelain", "--untracked-files=all"],
      { signal, timeout: HERDR_COMMAND_TIMEOUT_MS },
    )) as ExecResult;
    if (result.code !== 0)
      throw new Error(
        `worktreeCwd must be an existing local Git worktree: ${clip(result.stderr || result.stdout, 1000)}`,
      );
    if (result.stdout.trim())
      throw new Error("worktreeCwd must be clean before Herdr dispatch.");
    return checkoutPath;
  }

  /** Adapter from the extension to the standing-policy core. */
  function standingAuthorization(
    cwd: string,
    workflow: Workflow,
    operation: StandingOperation,
    ctx: ExtensionContext,
    label: string,
    signal?: AbortSignal,
  ): Promise<StandingResult> {
    return authorizeStanding(
      {
        policy: () => loadTaskProfileConfig(cwd)?.approvalPolicy,
        ack: async () => (await loadManifest(cwd)).approvalPolicyAck,
        interactive: ctx.mode === "tui" && ctx.hasUI,
        confirm: (title, message) =>
          nativeConfirms.confirm(ctx.ui, title, message, signal),
        ...(workflow.worktree
          ? {
              cleanWorktree: async () => {
                await assertCleanLocalWorktree(workflow.worktree!, signal);
              },
            }
          : {}),
        now,
        rootPaneId: workflow.taskBinding?.rootPaneId ?? "unknown",
      },
      workflow,
      operation,
      label,
    );
  }

  function applyStanding(
    manifest: ManifestWithQueue,
    workflow: Workflow,
    result: StandingResult,
  ): void {
    if (result.ack) manifest.approvalPolicyAck = result.ack;
    workflow.evidence.push(...result.evidence);
  }

  async function persistStanding(
    cwd: string,
    workflowId: string,
    result: StandingResult,
  ): Promise<void> {
    if (!result.evidence.length && !result.ack) return;
    const release = await acquireManifestLock(cwd, 10_000);
    try {
      const current = await loadManifest(cwd);
      applyStanding(current, workflowFor(current, workflowId), result);
      await saveManifest(cwd, current);
    } finally {
      await release();
    }
  }

  async function policyStatus(cwd: string) {
    const raw = loadTaskProfileConfig(cwd)?.approvalPolicy;
    const ack = (await loadManifest(cwd)).approvalPolicyAck;
    if (raw === undefined) return { configured: false as const, ack };
    try {
      const policy = validateApprovalPolicy(raw);
      const hash = approvalPolicyHash(policy);
      return { configured: true as const, valid: true as const, policy, hash, acknowledged: ack?.hash === hash, ack };
    } catch (error) {
      return { configured: true as const, valid: false as const, error: (error as Error).message, ack };
    }
  }

  async function acknowledgePolicy(
    cwd: string,
    ctx: ExtensionContext,
    confirm: boolean,
    signal?: AbortSignal,
  ) {
    requireRootManifestExecutor(cwd);
    const status = await policyStatus(cwd);
    if (!status.configured)
      throw new Error("No approvalPolicy is configured in .baa-ton/config.json.");
    if (!status.valid)
      throw new Error(`approvalPolicy is invalid: ${status.error}`);
    if (status.acknowledged) return { ...status, unchanged: true };
    let approved: boolean;
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      if (!confirm)
        throw new Error(
          "Acknowledging approvalPolicy requires native TUI confirmation or confirm=true after the user has explicitly approved this exact policy in this conversation.",
        );
      approved = true;
    } else
      approved = await nativeConfirms.confirm(
        ctx.ui,
        "Herdr standing approval policy",
        `${approvalPolicySummary(status.policy, status.hash)}\n\nRecord this policy?`,
        signal,
      );
    if (!approved) return { ...status, cancelled: true };
    const ack: ApprovalPolicyAck = {
      hash: status.hash,
      grants: status.policy.grants,
      ackedAt: now(),
      rootPaneId: (await currentPaneRoot(signal)).pane_id,
    };
    const release = await acquireManifestLock(cwd, 10_000);
    try {
      const current = await loadManifest(cwd);
      current.approvalPolicyAck = ack;
      await saveManifest(cwd, current);
    } finally {
      await release();
    }
    return { ...status, acknowledged: true, ack };
  }

  function runtimeConfigFor(cwd: string) {
    const raw = loadTaskProfileConfig(cwd)?.runtime;
    return raw === undefined ? undefined : validateRuntimeConfig(raw);
  }

  /** Reserve each writer lane's dispatchLeases before launch; idempotent, so
   * a retry keeps the leases the first attempt took. */
  async function allocateDispatchLeases(
    cwd: string,
    workflow: Workflow,
  ): Promise<Map<string, Lease[]>> {
    const byLane = new Map<string, Lease[]>();
    const config = runtimeConfigFor(cwd);
    if (!config?.dispatchLeases.length) return byLane;
    const writers = workflow.lanes.filter((lane) => !lane.readOnly);
    if (!writers.length) return byLane;
    const release = await acquireManifestLock(cwd, 10_000);
    try {
      const manifest = await loadManifest(cwd);
      const stored = workflowFor(manifest, workflow.id);
      const ledger = (manifest.leases ??= []);
      for (const lane of writers) {
        for (const resource of config.dispatchLeases) {
          const { lease, created } = await allocateLease(
            ledger,
            config,
            { resource, workflowId: workflow.id, laneId: lane.id, grantedBy: "dispatch" },
            { probe: probePort, now },
          );
          if (created)
            stored.evidence.push({
              at: now(),
              kind: "lease-granted",
              text: `Dispatch lease for ${lane.id}: ${leaseLines([lease])[0]}`,
            });
        }
        byLane.set(
          lane.id,
          activeLeases(ledger).filter(
            (lease) => lease.workflowId === workflow.id && lease.laneId === lane.id,
          ),
        );
      }
      await saveManifest(cwd, manifest);
    } finally {
      await release();
    }
    return byLane;
  }

  /** Why a lane may not take a lease by itself, or undefined when the
   * acknowledged approvalPolicy grants `lease`. */
  function laneLeaseRefusal(
    cwd: string,
    ack: ApprovalPolicyAck | undefined,
    grant: "lease" | "runtime-launch" | "retire" | "local-validation" | "dispatch" | "integrate" = "lease",
  ) {
    const raw = loadTaskProfileConfig(cwd)?.approvalPolicy;
    if (raw === undefined) return "no approvalPolicy is configured";
    try {
      const policy = validateApprovalPolicy(raw);
      if (!policy.grants.includes(grant)) return `approvalPolicy does not grant ${grant}`;
      if (ack?.hash !== approvalPolicyHash(policy))
        return "approvalPolicy is not acknowledged by the root";
      return undefined;
    } catch (error) {
      return `approvalPolicy is invalid: ${(error as Error).message}`;
    }
  }

  type WorkflowWithRequests = Workflow & {
    laneRequests?: LaneRequest[];
    laneMessages?: LaneMessage[];
    laneServices?: LaneService[];
  };

  /** A service registered to a lane with herdr_service (see
   * controller/lane-services.mjs); retire stops it. */
  type LaneService = {
    id: string;
    laneId: string;
    name: string;
    kind: "pane" | "process";
    paneId?: string;
    pid?: number;
    start?: string;
    command?: string;
    registeredBy: "lane" | "root";
    registeredAt: string;
    state: "active" | "stopped" | "released";
    stoppedAt?: string;
    stopNote?: string;
  };

  async function processIdentity(pid: number, signal?: AbortSignal) {
    try {
      const result = (await pi.exec("ps", ["-o", "lstart=,command=", "-p", String(pid)], { timeout: 10_000, signal })) as ExecResult;
      return result.code === 0 ? parseProcessIdentity(result.stdout) : undefined;
    } catch {
      return undefined;
    }
  }

  async function serviceTool(
    ctx: ExtensionContext,
    params: {
      action: "register" | "list" | "release";
      workflowId?: string;
      laneId?: string;
      name?: string;
      paneId?: string;
      pid?: number;
      serviceId?: string;
    },
    signal?: AbortSignal,
  ) {
    const child = isRegisteredChildLane() ? currentChildAssignment() : undefined;
    let cwd: string;
    let workflowId = params.workflowId;
    let laneId = params.laneId;
    let scope: ReturnType<typeof requireRootManifestExecutor> | undefined;
    if (child) {
      cwd = child.cwd;
      if ((workflowId && workflowId !== child.workflow.workflow_id) || (laneId && laneId !== child.lane.lane_id))
        throw new Error("A lane may register services only for itself.");
      workflowId = child.workflow.workflow_id;
      laneId = child.lane.lane_id;
    } else {
      scope = requireRootManifestExecutor(ctx.cwd);
      cwd = ctx.cwd;
    }
    if (params.action === "list") {
      const manifest = await loadManifest(cwd);
      const services = manifest.workflows
        .filter((workflow) => !workflowId || workflow.id === workflowId)
        .flatMap((workflow) =>
          ((workflow as WorkflowWithRequests).laneServices ?? [])
            .filter((service) => !child || service.laneId === laneId)
            .map((service) => ({ workflowId: workflow.id, ...service })),
        );
      return { kind: "list" as const, services, idle: child ? [] : idleLaneServices(manifest.workflows) };
    }
    if (!workflowId || !laneId) throw new Error("workflowId and laneId are required when the root registers or releases a service.");
    if (params.action === "release") {
      if (!params.serviceId) throw new Error("serviceId is required to release a service.");
      return withManifestTransaction(cwd, (manifest) => {
        const workflow = workflowFor(manifest, workflowId!) as WorkflowWithRequests;
        if (scope && !workflowOwnedByRoot(workflow, scope, cwd)) throw new Error(`Workflow ${workflowId} is not owned by this root.`);
        const service = workflow.laneServices?.find((item) => item.id === params.serviceId && item.laneId === laneId);
        if (!service) throw new Error(`Unknown service ${params.serviceId} for lane ${laneId}.`);
        if (service.state === "active") {
          service.state = "released";
          service.stoppedAt = now();
          service.stopNote = "released without stopping";
          workflow.evidence.push({ at: now(), kind: "lane-service-released", text: `${service.id} ${service.name} (${laneId})` });
        }
        return { kind: "service" as const, service: { ...service } };
      });
    }
    const name = params.name?.trim();
    if (!name || !/^[\w.:@/-]{1,60}$/.test(name)) throw new Error("name must be a short service name (letters, digits and . : @ / - _).");
    if ((params.paneId === undefined) === (params.pid === undefined)) throw new Error("Give exactly one of paneId or pid.");
    let identity: { start: string; command: string } | undefined;
    if (params.pid !== undefined) {
      const pid = params.pid;
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid)
        throw new Error(`pid ${pid} cannot be registered as a service.`);
      identity = await processIdentity(pid, signal);
      if (!identity) throw new Error(`No running process ${pid}.`);
      if (isHarnessCommand(identity.command))
        throw new Error(`pid ${pid} is an agent or Herdr/Baa-ton process, not a service.`);
    } else {
      const paneId = params.paneId!;
      try {
        await runHerdr(["pane", "get", paneId], signal);
      } catch (error) {
        throw new Error(`Pane ${paneId} is not available: ${clip((error as Error).message, 200)}`);
      }
    }
    return withManifestTransaction(cwd, (manifest) => {
      const workflow = workflowFor(manifest, workflowId!) as WorkflowWithRequests;
      if (scope && !workflowOwnedByRoot(workflow, scope, cwd)) throw new Error(`Workflow ${workflowId} is not owned by this root.`);
      const lane = workflow.lanes.find((item) => item.id === laneId);
      if (!lane) throw new Error(`Workflow ${workflowId} has no lane ${laneId}.`);
      if (params.paneId !== undefined && manifest.workflows.some((flow) => flow.lanes.some((item) => item.paneId === params.paneId)))
        throw new Error(`Pane ${params.paneId} is a lane's own agent pane, not a service.`);
      const services = (workflow.laneServices ??= []);
      const duplicate = manifest.workflows
        .flatMap((flow) => (flow as WorkflowWithRequests).laneServices ?? [])
        .find(
          (item) =>
            item.state === "active" &&
            (params.pid !== undefined ? item.pid === params.pid && item.start === identity!.start : item.paneId === params.paneId),
        );
      if (duplicate) throw new Error(`Already registered as ${duplicate.id} (${duplicate.name}, lane ${duplicate.laneId}).`);
      const service: LaneService = {
        id: `service-${randomUUID().slice(0, 8)}`,
        laneId: laneId!,
        name,
        kind: params.pid !== undefined ? "process" : "pane",
        ...(params.pid !== undefined ? { pid: params.pid, start: identity!.start, command: clip(identity!.command, 300) } : { paneId: params.paneId }),
        registeredBy: child ? "lane" : "root",
        registeredAt: now(),
        state: "active",
      };
      services.push(service);
      workflow.evidence.push({
        at: service.registeredAt,
        kind: "lane-service-registered",
        text: `${service.id} ${name} for ${laneId}: ${service.kind === "pane" ? `pane ${service.paneId}` : `pid ${service.pid}`}`,
      });
      workflow.updatedAt = service.registeredAt;
      return { kind: "service" as const, service: { ...service } };
    });
  }

  /** Stop one registered service; never signals a reused pid or an agent. */
  async function stopLaneService(service: LaneService, signal?: AbortSignal): Promise<{ ok: boolean; note: string }> {
    const term = (pid: number) => {
      try {
        process.kill(pid, "SIGTERM");
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    };
    if (service.kind === "process") {
      const identity = await processIdentity(service.pid!, signal);
      if (!identity) return { ok: true, note: "already stopped" };
      if (identity.start !== service.start) return { ok: true, note: `pid ${service.pid} now belongs to another process; not signalled` };
      return term(service.pid!) ? { ok: true, note: `SIGTERM pid ${service.pid}` } : { ok: false, note: `could not signal pid ${service.pid}` };
    }
    let info: unknown;
    try {
      const raw = await runHerdr(["pane", "process-info", "--pane", service.paneId!], signal);
      info = isRecord(raw) && isRecord(raw.result) ? raw.result : raw;
    } catch (error) {
      if (/not[ _-]?found|no such pane|unknown pane/i.test((error as Error).message)) return { ok: true, note: "pane is gone" };
      return { ok: false, note: `pane process-info failed: ${clip((error as Error).message, 200)}` };
    }
    const processes = paneServiceProcesses(info);
    if (!processes.length) return { ok: true, note: `nothing running in pane ${service.paneId}` };
    const failed = processes.filter((item) => !term(item.pid));
    return failed.length
      ? { ok: false, note: `could not signal ${failed.map((item) => item.pid).join(", ")}` }
      : { ok: true, note: `SIGTERM ${processes.map((item) => `${item.name} (${item.pid})`).join(", ")} in pane ${service.paneId}` };
  }

  /** Root-to-lane message (herdr_tell). */
  type LaneMessage = {
    id: string;
    laneId: string;
    from: "root";
    text: string;
    createdAt: string;
    delivery: LaneDelivery;
  };
  type LaneDelivery = {
    status: "delivered" | "pending" | "uncertain";
    updatedAt: string;
    attempts?: number;
    reason?: string;
    text?: string;
  };

  /** Type text into a lane only while it is idle. A busy or unreachable lane
   * gets nothing typed and the delivery stays pending for the supervisor; a
   * failed prompt is uncertain and never retyped. */
  async function deliverToLane(
    paneId: string | undefined,
    text: string,
    signal?: AbortSignal,
  ): Promise<LaneDelivery> {
    const stamp = now();
    if (!paneId) return { status: "pending", updatedAt: stamp, reason: "the lane has no recorded pane", text };
    let status: unknown;
    try {
      const agent = responseRecord(await runHerdr(["agent", "get", paneId], signal), "lane agent").agent;
      status = isRecord(agent) ? agent.agent_status : undefined;
    } catch (error) {
      return { status: "pending", updatedAt: stamp, reason: `lane unavailable: ${clip((error as Error).message, 300)}`, text };
    }
    if (status === "working" || status === "blocked")
      return { status: "pending", updatedAt: stamp, reason: `lane is ${status}`, text };
    try {
      await runHerdr(["agent", "prompt", paneId, text], signal);
      return { status: "delivered", updatedAt: now(), attempts: 1 };
    } catch (error) {
      return { status: "uncertain", updatedAt: now(), attempts: 1, reason: clip((error as Error).message, 500) };
    }
  }

  function laneMessageText(message: { id: string; text: string }) {
    return `[Baa-ton root message] ${message.id}: ${message.text}\n(Reply with herdr_message if the root needs an answer.)`;
  }

  /** herdr_tell: the root sends a durable message to one of its live lanes. */
  async function tellLane(
    cwd: string,
    params: { workflowId: string; laneId: string; text: string },
    signal?: AbortSignal,
  ) {
    const scope = requireRootManifestExecutor(cwd);
    const text = params.text.trim();
    if (!text) throw new Error("text is required.");
    let message: LaneMessage;
    let paneId: string | undefined;
    const release = await acquireManifestLock(cwd, 10_000);
    try {
      const manifest = await loadManifest(cwd);
      const workflow = workflowFor(manifest, params.workflowId) as WorkflowWithRequests;
      if (!workflowOwnedByRoot(workflow, scope, cwd))
        throw new Error(`Workflow ${workflow.id} is not owned by this root.`);
      const lane = workflow.lanes.find((item) => item.id === params.laneId);
      if (!lane) throw new Error(`Workflow ${workflow.id} has no lane ${params.laneId}.`);
      if (!lane.paneId) throw new Error(`Lane ${lane.id} has not been dispatched to a pane yet.`);
      paneId = lane.paneId;
      message = {
        id: `lane-message-${randomUUID().slice(0, 8)}`,
        laneId: lane.id,
        from: "root",
        text,
        createdAt: now(),
        delivery: { status: "pending", updatedAt: now(), reason: "not yet attempted" },
      };
      (workflow.laneMessages ??= []).push(message);
      workflow.evidence.push({ at: message.createdAt, kind: "lane-message", text: `${message.id} to ${lane.id}: ${clip(text, 200)}` });
      workflow.updatedAt = message.createdAt;
      await saveManifest(cwd, manifest);
    } finally {
      await release();
    }
    const delivery = await deliverToLane(paneId, laneMessageText(message), signal);
    await withManifestTransaction(cwd, (manifest) => {
      const stored = (
        manifest.workflows.find((item) => item.id === params.workflowId) as WorkflowWithRequests | undefined
      )?.laneMessages?.find((item) => item.id === message.id);
      if (stored) stored.delivery = delivery;
    });
    return { message: { ...message, delivery } };
  }

  /** Answer a new request from the acknowledged policy, or leave it open
   * with the reason in `note`. */
  async function answerFromPolicy(
    cwd: string,
    manifest: ManifestWithQueue,
    workflow: WorkflowWithRequests,
    request: LaneRequest,
  ): Promise<void> {
    if (request.kind === "approval") return;
    const leaveOpen = (why: string) => {
      request.note = `not answered by policy: ${why}`;
    };
    const grant = () => {
      request.status = "granted";
      request.answeredBy = "policy";
      request.answeredAt = now();
      delete request.delivery;
    };
    // A lane's frozen install, build, codegen, typecheck, lint or tests in
    // its own worktree, under the local-validation grant.
    const validationCommand =
      request.kind === "runtime-launch" && "command" in request.payload
        ? request.payload.command
        : request.kind === "permission" &&
            "toolName" in request.payload &&
            request.payload.toolName === "Bash" &&
            typeof request.payload.input.command === "string"
          ? request.payload.input.command
          : undefined;
    let validationReason: string | undefined;
    if (validationCommand !== undefined) {
      validationReason = laneLeaseRefusal(cwd, manifest.approvalPolicyAck, "local-validation");
      if (!validationReason) {
        const verdict = classifyLocalValidation(validationCommand, {
          cwd: workflow.worktree ?? workflow.cwd,
          leasedPorts: activeLeases(manifest.leases)
            .filter((lease) => lease.workflowId === workflow.id && lease.laneId === request.laneId)
            .flatMap((lease) => lease.ports ?? []),
        });
        if (verdict.matched) {
          request.note = `local-validation: ${verdict.classes.join(", ")}`;
          return grant();
        }
        validationReason = `not local validation (${verdict.reason})`;
      }
    }
    const refusal = laneLeaseRefusal(
      cwd,
      manifest.approvalPolicyAck,
      request.kind === "lease" ? "lease" : "runtime-launch",
    );
    if (refusal) return leaveOpen(validationReason ? `${validationReason}; ${refusal}` : refusal);
    if (request.kind === "lease" && "resource" in request.payload) {
      const config = runtimeConfigFor(cwd);
      if (!config) return leaveOpen("no runtime leases are configured");
      try {
        const { lease } = await allocateLease(
          (manifest.leases ??= []),
          config,
          {
            resource: request.payload.resource,
            label: request.payload.label,
            workflowId: workflow.id,
            laneId: request.laneId,
            grantedBy: "lane-policy",
          },
          { probe: probePort, now },
        );
        request.leaseId = lease.id;
        request.note = leaseLines([lease])[0];
      } catch (error) {
        return leaveOpen((error as Error).message);
      }
    } else {
      const command =
        "command" in request.payload
          ? request.payload.command
          : "toolName" in request.payload &&
              request.payload.toolName === "Bash" &&
              typeof request.payload.input.command === "string"
            ? request.payload.input.command
            : undefined;
      const matched =
        command === undefined
          ? undefined
          : matchRuntimeCommand(
              validateApprovalPolicy(loadTaskProfileConfig(cwd)?.approvalPolicy),
              command,
              {
                workflowId: workflow.id,
                laneId: request.laneId,
                leases: activeLeases(manifest.leases).filter(
                  (lease) => lease.workflowId === workflow.id && lease.laneId === request.laneId,
                ),
              },
            );
      if (!matched)
        return leaveOpen(
          `${validationReason ? `${validationReason}; ` : ""}the command matches no runtime template for this lane's leases`,
        );
      request.template = `${matched.template.name}:${matched.phase}`;
      request.note = `matches runtime template ${matched.template.name} (${matched.phase})`;
    }
    grant();
  }

  type RequestParams = {
    action: "open" | "status" | "list" | "answer";
    kind?: LaneRequestKind;
    resource?: string;
    label?: string;
    command?: string;
    text?: string;
    toolName?: string;
    input?: Record<string, unknown>;
    requestId?: string;
    decision?: "grant" | "deny";
    note?: string;
    includeAnswered?: boolean;
    /** Bridge-only: a permission prompt that no policy matches stays with the
     * existing permission broker instead of opening a second record. */
    policyOnly?: boolean;
  };

  async function requestTool(
    ctx: ExtensionContext,
    params: RequestParams,
    signal?: AbortSignal,
  ): Promise<
    | { kind: "list"; requests: LaneRequest[] }
    | { kind: "request"; request: LaneRequest; created?: boolean }
    | { kind: "unmatched"; reason: string }
  > {
    if (params.action === "open" || params.action === "status") {
      if (!isRegisteredChildLane())
        throw new Error(`herdr_request action=${params.action} is for a registered child lane.`);
      const child = currentChildAssignment();
      const cwd = child.cwd;
      const workflowId = child.workflow.workflow_id;
      const laneId = child.lane.lane_id;
      const release = await acquireManifestLock(cwd, 10_000);
      try {
        const manifest = await loadManifest(cwd);
        const workflow = workflowFor(manifest, workflowId) as WorkflowWithRequests;
        if (!workflow.lanes.some((lane) => lane.id === laneId))
          throw new Error("Child assignment differs from the authoritative manifest.");
        const requests = (workflow.laneRequests ??= []);
        if (params.action === "status") {
          const request = requests.find((item) => item.id === params.requestId);
          if (!request || request.laneId !== laneId)
            throw new Error(`Unknown request ${params.requestId} for this lane.`);
          return { kind: "request", request };
        }
        if (!params.kind) throw new Error("kind is required to open a request.");
        const payload = requestPayload(params.kind, params);
        const key = requestKey(params.kind, payload);
        const duplicate = requests.find(
          (item) =>
            item.laneId === laneId &&
            item.status === "open" &&
            requestKey(item.kind, item.payload) === key,
        );
        if (duplicate) return { kind: "request", request: duplicate, created: false };
        const stamp = now();
        const request: LaneRequest = {
          id: `request-${randomUUID().slice(0, 8)}`,
          workflowId,
          laneId,
          kind: params.kind,
          payload,
          summary: requestSummary(params.kind, payload),
          status: "open",
          requestedAt: stamp,
          delivery: { status: "pending", updatedAt: stamp },
        };
        await answerFromPolicy(cwd, manifest, workflow, request);
        if (params.policyOnly && request.status === "open")
          return { kind: "unmatched", reason: request.note ?? "not answered by policy" };
        requests.push(request);
        workflow.evidence.push({
          at: stamp,
          kind: request.status === "open" ? "lane-request-opened" : "lane-request-granted",
          text: `${request.id} ${laneId}: ${request.summary}${request.note ? ` (${request.note})` : ""}`,
        });
        workflow.updatedAt = stamp;
        await saveManifest(cwd, manifest);
        return { kind: "request", request, created: true };
      } finally {
        await release();
      }
    }
    requireRootManifestExecutor(ctx.cwd);
    const cwd = ctx.cwd;
    if (params.action === "list") {
      const manifest = await loadManifest(cwd);
      const all = manifest.workflows.flatMap(
        (workflow) => (workflow as WorkflowWithRequests).laneRequests ?? [],
      );
      return {
        kind: "list",
        requests: params.includeAnswered
          ? all.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
          : openRequests(all),
      };
    }
    if (!params.requestId || !params.decision)
      throw new Error("requestId and decision are required to answer a request.");
    let answered: LaneRequest;
    let paneId: string | undefined;
    const release = await acquireManifestLock(cwd, 10_000);
    try {
      const manifest = await loadManifest(cwd);
      const workflow = manifest.workflows.find((item) =>
        (item as WorkflowWithRequests).laneRequests?.some((request) => request.id === params.requestId),
      ) as WorkflowWithRequests | undefined;
      const request = workflow?.laneRequests?.find((item) => item.id === params.requestId);
      if (!workflow || !request) throw new Error(`Unknown lane request ${params.requestId}.`);
      if (request.status !== "open") return { kind: "request", request };
      let note = params.note?.trim() ?? "";
      if (params.decision === "grant" && request.kind === "lease" && "resource" in request.payload) {
        const config = runtimeConfigFor(cwd);
        if (!config) throw new Error("No runtime leases are configured in .baa-ton/config.json.");
        const { lease } = await allocateLease(
          (manifest.leases ??= []),
          config,
          {
            resource: request.payload.resource,
            label: request.payload.label,
            workflowId: workflow.id,
            laneId: request.laneId,
            grantedBy: "root",
          },
          { probe: probePort, now },
        );
        request.leaseId = lease.id;
        note = [note, leaseLines([lease])[0]].filter(Boolean).join("; ");
      }
      request.status = params.decision === "grant" ? "granted" : "denied";
      request.answeredBy = "root";
      request.answeredAt = now();
      if (note) request.note = note;
      else delete request.note;
      workflow.evidence.push({
        at: now(),
        kind: `lane-request-${request.status}`,
        text: `${request.id} ${request.laneId}: ${request.summary}${request.note ? ` (${request.note})` : ""}`,
      });
      workflow.updatedAt = now();
      paneId = workflow.lanes.find((lane) => lane.id === request.laneId)?.paneId;
      await saveManifest(cwd, manifest);
      answered = { ...request };
    } finally {
      await release();
    }
    // Non-waiting delivery after the durable answer, only into an idle lane:
    // a busy lane keeps it pending for the supervisor; never retyped on failure.
    const delivery = await deliverToLane(
      paneId,
      `[Baa-ton request answer] ${answered.id}: ${answered.status}. ${answered.summary}${answered.note ? `. ${answered.note}` : ""}`,
      signal,
    );
    await withManifestTransaction(cwd, (manifest) => {
      const stored = (
        manifest.workflows.find((item) => item.id === answered.workflowId) as
          | WorkflowWithRequests
          | undefined
      )?.laneRequests?.find((item) => item.id === answered.id);
      if (stored) stored.answerDelivery = delivery;
    });
    return { kind: "request", request: { ...answered, answerDelivery: delivery } };
  }

  type RetireCandidate = {
    workflowId: string;
    laneId: string;
    paneId?: string;
    tabId?: string;
    cwd: string;
    stops: string[][];
    services?: LaneService[];
  };

  function acknowledgedPolicy(cwd: string, ack: ApprovalPolicyAck | undefined) {
    try {
      const policy = validateApprovalPolicy(loadTaskProfileConfig(cwd)?.approvalPolicy);
      return ack?.hash === approvalPolicyHash(policy) ? policy : undefined;
    } catch {
      return undefined;
    }
  }

  /** Finished lanes that may be retired. `auto` requires a completion receipt
   * the root has received; an explicit root call also accepts terminal lanes. */
  function retireCandidates(
    cwd: string,
    manifest: ManifestWithQueue,
    options: { auto: boolean; workflowId?: string; laneId?: string; rootPaneId?: string },
  ): RetireCandidate[] {
    const policy = acknowledgedPolicy(cwd, manifest.approvalPolicyAck);
    const candidates: RetireCandidate[] = [];
    for (const workflow of manifest.workflows as WorkflowWithRequests[]) {
      if (options.workflowId && workflow.id !== options.workflowId) continue;
      if (options.rootPaneId && workflow.taskBinding?.rootPaneId !== options.rootPaneId) continue;
      if (workflow.ownership?.createdBy !== OWNER) continue;
      for (const lane of workflow.lanes) {
        if (options.laneId && lane.id !== options.laneId) continue;
        if (lane.retirement && lane.retirement.status !== "partial") continue;
        const finished = options.auto
          ? lane.completionReceipt?.delivery === "delivered"
          : Boolean(lane.completionReceipt) || TERMINAL_LANE_STATUSES.has(lane.status);
        if (!finished) continue;
        candidates.push({
          workflowId: workflow.id,
          laneId: lane.id,
          paneId: lane.paneId,
          tabId: lane.tabId,
          cwd: workflow.worktree ?? workflow.cwd ?? cwd,
          stops: retireStopCommands(policy, workflow.laneRequests, {
            workflowId: workflow.id,
            laneId: lane.id,
            leases: activeLeases(manifest.leases).filter(
              (lease) => lease.workflowId === workflow.id && lease.laneId === lane.id,
            ),
          }),
          services: ((workflow as WorkflowWithRequests).laneServices ?? []).filter(
            (service) => service.laneId === lane.id && service.state === "active",
          ),
        });
      }
    }
    return candidates;
  }

  /** Retire one finished lane: stop its runtime services, close its tab (which
   * ends its agent session and child processes), release its leases once the
   * services are stopped. The session log records the session as retired;
   * like any completed lane it is not a herdr_resume candidate. */
  async function retireLane(
    cwd: string,
    candidate: RetireCandidate,
    reason: string,
    signal?: AbortSignal,
  ): Promise<NonNullable<Lane["retirement"]> | undefined> {
    const claimed = await withManifestTransaction(cwd, (manifest) => {
      const workflow = workflowFor(manifest, candidate.workflowId);
      const lane = workflow.lanes.find((item) => item.id === candidate.laneId);
      if (!lane || (lane.retirement && lane.retirement.status !== "partial")) return false;
      const sharing = workflow.lanes.some(
        (other) =>
          other.id !== lane.id &&
          candidate.tabId !== undefined &&
          other.tabId === candidate.tabId &&
          !other.retirement &&
          !other.completionReceipt &&
          !TERMINAL_LANE_STATUSES.has(other.status),
      );
      if (sharing) return false;
      lane.retirement = { status: "retiring", reason, startedAt: now() };
      return true;
    });
    if (!claimed) return undefined;
    const stops: NonNullable<NonNullable<Lane["retirement"]>["stops"]> = [];
    for (const tokens of candidate.stops) {
      try {
        const result = (await pi.exec(tokens[0], tokens.slice(1), {
          cwd: candidate.cwd,
          timeout: 120_000,
          signal,
        })) as ExecResult;
        const output = clip((result.stderr || result.stdout || "").trim(), 500);
        stops.push({ command: tokens.join(" "), code: result.code, ...(output ? { output } : {}) });
      } catch (error) {
        stops.push({ command: tokens.join(" "), code: null, output: clip((error as Error).message, 500) });
      }
    }
    const serviceStops: Array<{ id: string; ok: boolean; note: string }> = [];
    for (const service of candidate.services ?? []) {
      const result = await stopLaneService(service, signal);
      serviceStops.push({ id: service.id, ...result });
      stops.push({ command: `service ${service.name} (${service.id}): ${result.note}`, code: result.ok ? 0 : 1 });
    }
    let tabClosed = false;
    let error: string | undefined;
    if (candidate.tabId)
      try {
        await runHerdr(["tab", "close", candidate.tabId], signal);
        tabClosed = true;
      } catch (closeError) {
        const message = (closeError as Error).message;
        if (/not[ _-]?found|no such tab|unknown tab/i.test(message)) tabClosed = true;
        else error = `tab close failed: ${clip(message, 500)}`;
      }
    else error = "lane has no recorded tab";
    const stopsOk = stops.every((stop) => stop.code === 0);
    let record: NonNullable<Lane["retirement"]> | undefined;
    await withManifestTransaction(cwd, (manifest) => {
      const workflow = workflowFor(manifest, candidate.workflowId);
      const lane = workflow.lanes.find((item) => item.id === candidate.laneId);
      if (!lane) return;
      const released = stopsOk
        ? releaseLeases(
            manifest.leases,
            (lease) => lease.workflowId === workflow.id && lease.laneId === lane.id,
            "lane retired",
            now(),
          )
        : [];
      for (const stopped of serviceStops) {
        const service = (workflow as WorkflowWithRequests).laneServices?.find((item) => item.id === stopped.id);
        if (!service || service.state !== "active" || !stopped.ok) continue;
        service.state = "stopped";
        service.stoppedAt = now();
        service.stopNote = stopped.note;
      }
      record = {
        status: tabClosed && stopsOk ? "retired" : "partial",
        reason,
        startedAt: lane.retirement?.startedAt ?? now(),
        completedAt: now(),
        tabClosed,
        stops,
        releasedLeaseIds: released.map((lease) => lease.id),
        ...(error
          ? { error }
          : stopsOk
            ? {}
            : { error: "a stop command failed; leases are kept until the service is stopped" }),
      };
      lane.retirement = record;
      if (tabClosed && lane.sessionLog) lane.sessionLog = { ...lane.sessionLog, status: "retired" };
      workflow.evidence.push({
        at: now(),
        kind: record.status === "retired" ? "lane-retired" : "lane-retirement-partial",
        text: `${lane.id}: ${reason}; tab ${tabClosed ? "closed" : "kept"}; stops ${
          stops.length ? stops.map((stop) => `${stop.command} => ${stop.code}`).join(", ") : "none"
        }; leases released ${released.length}${record.error ? `; ${record.error}` : ""}`,
      });
      workflow.updatedAt = now();
    });
    return record;
  }

  type SpecDriverPorts = {
    /** Create (or reuse) the item's worktree on spec/<id> from the target tip. */
    worktree(input: { repo: string; path: string; branch: string; base: string }, signal?: AbortSignal): Promise<void>;
    plan(input: { objective: string; laneObjective: string; readOnly: boolean; taskProfile: string; worktree: string }): Promise<Workflow>;
    dispatch(workflowId: string): Promise<{ dispatched?: boolean; cancelled?: boolean; parentApprovalRequired?: boolean }>;
    now(): string;
  };

  let specDriverRunning = false;

  /**
   * The spec loop's driver (docs/SPEC-LOOP.md section 4). Runs on every
   * settled root turn and on herdr_spec action=advance: code decides what to
   * dispatch; the root is asked only for judgment. It acts only under an
   * acknowledged policy that grants dispatch and integrate, and it never
   * opens a dialog: anything outside policy stays waiting with its reason.
   */
  async function runSpecDriver(ctx: ExtensionContext, ports?: Partial<SpecDriverPorts>, signal?: AbortSignal) {
    if (specDriverRunning) return { skipped: "already running" };
    const spec = await loadSpec(ctx.cwd);
    if (!spec) return { skipped: `no ${SPEC_PATH}` };
    const manifest = await loadManifest(ctx.cwd);
    const refusal =
      laneLeaseRefusal(ctx.cwd, manifest.approvalPolicyAck, "dispatch") ??
      laneLeaseRefusal(ctx.cwd, manifest.approvalPolicyAck, "integrate");
    if (refusal) return { skipped: `the spec driver needs the dispatch and integrate grants (${refusal})` };
    specDriverRunning = true;
    try {
      const scope = requireRootManifestExecutor(ctx.cwd);
      const repo = targetRepo(spec, ctx.cwd);
      const headless = { ...ctx, hasUI: false, mode: "json" } as ExtensionContext;
      const use: SpecDriverPorts = {
        async worktree({ repo: repoPath, path, branch, base }, abort) {
          if ((await stat(path).catch(() => undefined))?.isDirectory()) return;
          const existing = await execFile("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { signal: abort }).then(
            () => true,
            () => false,
          );
          await mkdir(dirname(path), { recursive: true });
          await execFile("git", ["-C", repoPath, "worktree", "add", ...(existing ? [path, branch] : ["-b", branch, path, base])], { signal: abort, timeout: 120_000 });
        },
        plan: ({ objective, laneObjective, readOnly, taskProfile, worktree }) =>
          plan(ctx.cwd, objective, [{ objective: laneObjective, readOnly, taskProfile }], worktree, undefined, undefined, undefined, undefined, taskProfile, headless),
        dispatch: (workflowId) => dispatch(ctx.cwd, workflowId, true, headless, signal),
        now,
        ...ports,
      };
      const state = await loadSpecState(ctx.cwd);
      const laneView = (ref: { workflowId: string; laneId: string }) => {
        const workflow = manifest.workflows.find((item) => item.id === ref.workflowId);
        const lane = workflow?.lanes.find((item) => item.id === ref.laneId);
        if (!lane) return undefined;
        return {
          status: lane.status,
          ...(lane.completionReceipt ? { receipt: { summary: lane.completionReceipt.summary } } : {}),
        };
      };
      const supervision = manifest.rootSupervision?.find((item) => item.rootId === scope.rootId);
      const step = advanceSpec({
        spec,
        state,
        lane: laneView,
        capacityWaiting: supervision?.capacityGate?.status === "waiting",
        now: use.now(),
      });
      const next = step.state;
      const done: string[] = [];
      for (const action of step.actions) {
        const item = spec.items.find((candidate) => candidate.id === action.itemId)!;
        const record = next.items[item.id];
        const branch = `spec/${item.id}`;
        const worktree = record.worktree ?? join(homedir(), ".herdr", "worktrees", basename(repo), `spec-${item.id}`);
        try {
          let profile: string;
          let objective: string;
          if (action.kind === "build") {
            profile = spec.stages.build?.profile ?? "implementation";
            await use.worktree({ repo, path: worktree, branch, base: `refs/remotes/${spec.target.remote}/${spec.target.branch}` }, signal);
            objective = buildObjective(spec, item, { branch, findings: action.findings });
          } else {
            profile = spec.stages.review?.profile ?? "review";
            const against = spec.stages.review?.differentFrom;
            if (against) {
              const other = spec.stages[against]?.profile ?? (against === "build" ? "implementation" : against);
              const a = resolveTaskProfile(ctx.cwd, profile);
              const b = resolveTaskProfile(ctx.cwd, other);
              if (a.launchProfile.provider === b.launchProfile.provider && a.launchProfile.model === b.launchProfile.model) {
                Object.assign(record, { state: "blocked", blockedReason: "human-gate", note: `review profile ${profile} uses the same model as ${against} (${a.launchProfile.provider}/${a.launchProfile.model}); set a different one`, since: use.now() });
                step.rootAsks.push({ itemId: item.id, reason: `${item.id}: the review profile must differ from ${against}` });
                continue;
              }
            }
            objective = reviewObjective(spec, item, { branch, buildSummary: record.buildSummary });
          }
          const workflow = await use.plan({
            objective: `spec ${item.id} ${action.kind}${action.attempt > 1 ? ` (attempt ${action.attempt})` : ""}: ${item.title}`,
            laneObjective: objective,
            readOnly: action.kind === "review",
            taskProfile: profile,
            worktree,
          });
          record.worktree = worktree;
          record.branch = branch;
          record.lane = { workflowId: workflow.id, laneId: workflow.lanes[0].id };
          delete record.note;
          const result = await use.dispatch(workflow.id);
          if (!result.dispatched) record.note = `${action.kind} planned as ${workflow.id} but not dispatched${result.cancelled ? " (cancelled)" : ""}`;
          done.push(`${action.kind} ${item.id} -> ${workflow.id}`);
        } catch (error) {
          record.note = `${action.kind} failed: ${clip((error as Error).message, 300)}`;
          if (!record.lane?.workflowId || record.lane.workflowId === undefined) delete record.lane;
          done.push(`${action.kind} ${item.id} failed: ${clip((error as Error).message, 120)}`);
        }
      }
      for (const [id, reason] of Object.entries(step.waits)) if (next.items[id]) next.items[id].wait = reason;
      for (const item of spec.items) if (!step.waits[item.id] && next.items[item.id]) delete next.items[item.id].wait;
      validateSpecState(next);
      const release = await acquireManifestLock(ctx.cwd, 10_000);
      try {
        const path = join(ctx.cwd, SPEC_STATE_PATH);
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${jsonText(next)}\n`, { mode: 0o600 });
        await rename(temporary, path);
        if (step.rootAsks.length) {
          const current = await loadManifest(ctx.cwd);
          const entries = (current.rootSupervision ??= []);
          let entry = entries.find((item) => item.rootId === scope.rootId);
          if (!entry) {
            entry = { rootId: scope.rootId, alerts: [] };
            entries.push(entry);
          }
          const alerts = ((entry as { alerts?: unknown[] }).alerts ??= []);
          for (const ask of step.rootAsks)
            alerts.push({
              id: `alert-${randomUUID().slice(0, 8)}`,
              kind: "spec-needs-root",
              text: ask.reason,
              createdAt: use.now(),
              delivery: { status: "pending", attempts: 0, updatedAt: use.now() },
            });
          await saveManifest(ctx.cwd, current);
        }
      } finally {
        await release();
      }
      return { actions: done, rootAsks: step.rootAsks, waits: step.waits };
    } finally {
      specDriverRunning = false;
    }
  }

  /** Runs when the root's turn settles: retire lanes whose completion the
   * root has received, when the acknowledged policy grants retire and the lane
   * agent is no longer working. Never throws into the Pi lifecycle. */
  async function autoRetireFinishedLanes(ctx: ExtensionContext): Promise<void> {
    try {
      if (!isRootOrchestrator() || !isRootForManifest(ctx.cwd)) return;
      const manifest = await loadManifest(ctx.cwd);
      if (laneLeaseRefusal(ctx.cwd, manifest.approvalPolicyAck, "retire")) return;
      const candidates = retireCandidates(ctx.cwd, manifest, {
        auto: true,
        rootPaneId: process.env[HERDR_PANE_ID_ENV],
      });
      for (const candidate of candidates) {
        if (candidate.paneId) {
          try {
            const agent = responseRecord(
              await runHerdr(["agent", "get", candidate.paneId], ctx.signal),
              "retiring lane",
            ).agent;
            const status = isRecord(agent) ? agent.agent_status : undefined;
            if (status === "working" || status === "blocked") continue;
          } catch (error) {
            if (!/agent_not_found|not[ _-]?found/i.test(String(error))) continue;
          }
        }
        await retireLane(ctx.cwd, candidate, "completion accepted (auto-retire)", ctx.signal);
      }
    } catch {
      // Best effort: the next settled turn retries; herdr_retire is explicit.
    }
  }

  async function retireTool(
    ctx: ExtensionContext,
    params: { workflowId: string; laneId?: string; execute?: boolean; confirm?: boolean },
    signal?: AbortSignal,
  ) {
    requireRootManifestExecutor(ctx.cwd);
    const manifest = await loadManifest(ctx.cwd);
    workflowFor(manifest, params.workflowId);
    const candidates = retireCandidates(ctx.cwd, manifest, {
      auto: false,
      workflowId: params.workflowId,
      laneId: params.laneId,
    });
    if (!params.execute) return { dryRun: true, candidates };
    if (!candidates.length) return { candidates, results: [] };
    const granted = !laneLeaseRefusal(ctx.cwd, manifest.approvalPolicyAck, "retire");
    if (
      !granted &&
      !(await confirmExecution(
        ctx,
        `Retire ${candidates.length} finished lane(s) of ${params.workflowId} (stop services, close lane tabs, release leases)`,
        params.confirm ?? false,
        signal,
      ))
    )
      return { cancelled: true, candidates };
    const results = [];
    for (const candidate of candidates)
      results.push({
        laneId: candidate.laneId,
        retirement: await retireLane(
          ctx.cwd,
          candidate,
          granted ? "retired by root under approvalPolicy" : "retired by root",
          signal,
        ),
      });
    return { candidates, results };
  }

  /** Whether a workflow was planned by a root session other than the one the
   * manifest records as current for this root. */
  function plannedByEarlierRootSession(manifest: ManifestWithQueue, workflow: Workflow, rootId: string): boolean {
    const bound = workflow.taskBinding?.rootSessionPath;
    const current =
      manifest.rootSessionLogs?.find((entry) => entry.rootId === rootId) ?? manifest.sessionLog;
    if (!bound || !current?.sessionRef) return false;
    const ref = current.sessionRef;
    const known = [
      ref.sessionId,
      isRecord(ref.metadata) ? ref.metadata.sessionPath : undefined,
      isRecord(ref.nativeHandle) ? ref.nativeHandle.value : undefined,
    ].filter((value): value is string => typeof value === "string");
    return known.length > 0 && !known.includes(bound);
  }

  async function supersedeWorkflow(cwd: string, workflowId: string, reason: string) {
    const scope = requireRootManifestExecutor(cwd);
    const why = reason?.trim();
    if (!why) throw new Error("reason is required to supersede a workflow.");
    return withManifestTransaction(cwd, (manifest) => {
      const workflow = workflowFor(manifest, workflowId);
      if (!workflowOwnedByRoot(workflow, scope, cwd))
        throw new Error(`Workflow ${workflowId} is not owned by this root.`);
      const launched =
        Boolean(workflow.dispatchedAt) ||
        (workflow.ownership?.tabIds?.length ?? 0) > 0 ||
        (workflow.ownership?.paneIds?.length ?? 0) > 0 ||
        workflow.lanes.some((lane) => lane.paneId || lane.agentStartAttemptedAt || lane.promptAttemptedAt);
      if (!["planned", "dispatch-failed"].includes(workflow.status) || launched)
        throw new Error(
          `Workflow ${workflowId} is ${workflow.status}${launched ? " and has launched resources" : ""}; herdr_supersede only retires workflows that never started a lane. Use herdr_close instead.`,
        );
      const staleRootSession = plannedByEarlierRootSession(manifest, workflow, scope.rootId);
      const stamp = now();
      workflow.status = "superseded";
      (workflow as { outcome: string }).outcome = "superseded";
      for (const lane of workflow.lanes) lane.status = "superseded";
      const released = releaseWorkflowLeases(manifest, workflow, "workflow superseded");
      workflow.evidence.push({
        at: stamp,
        kind: "workflow-superseded",
        text: `${why}${staleRootSession ? " (planned by an earlier root session)" : ""}`,
      });
      workflow.updatedAt = stamp;
      return { workflow: { ...workflow }, staleRootSession, releasedLeases: released.length };
    });
  }

  async function leaseTool(
    ctx: ExtensionContext,
    params: {
      action: "list" | "request" | "release";
      resource?: string;
      label?: string;
      workflowId?: string;
      laneId?: string;
      leaseId?: string;
      includeReleased?: boolean;
    },
  ) {
    const child = isRegisteredChildLane() ? currentChildAssignment() : undefined;
    let cwd: string;
    let workflowId = params.workflowId;
    let laneId = params.laneId;
    if (child) {
      cwd = child.cwd;
      if (
        (workflowId && workflowId !== child.workflow.workflow_id) ||
        (laneId && laneId !== child.lane.lane_id)
      )
        throw new Error("A lane may act only on its own leases.");
      workflowId = child.workflow.workflow_id;
      laneId = child.lane.lane_id;
    } else {
      requireRootManifestExecutor(ctx.cwd);
      cwd = ctx.cwd;
    }
    if (params.action === "list") {
      const manifest = await loadManifest(cwd);
      const leases = (params.includeReleased ? manifest.leases ?? [] : activeLeases(manifest.leases))
        .filter((lease) => !workflowId || lease.workflowId === workflowId)
        .filter((lease) => !child || lease.laneId === laneId);
      return { kind: "list" as const, role: child ? "lane" : "root", leases, conflicts: ledgerConflicts(manifest.leases) };
    }
    if (params.action === "request") {
      if (!params.resource) throw new Error("resource is required to request a lease.");
      if (!workflowId || !laneId)
        throw new Error("workflowId and laneId are required when the root requests a lease.");
      const config = runtimeConfigFor(cwd);
      if (!config) throw new Error("No runtime leases are configured in .baa-ton/config.json.");
      const release = await acquireManifestLock(cwd, 10_000);
      try {
        const manifest = await loadManifest(cwd);
        const workflow = workflowFor(manifest, workflowId);
        if (!workflow.lanes.some((lane) => lane.id === laneId))
          throw new Error(`Workflow ${workflowId} has no lane ${laneId}.`);
        if (child) {
          const refusal = laneLeaseRefusal(cwd, manifest.approvalPolicyAck);
          const alreadyHeld = activeLeases(manifest.leases).find(
            (lease) =>
              lease.workflowId === workflowId &&
              lease.laneId === laneId &&
              lease.resource === params.resource &&
              lease.label === (params.label ?? "default"),
          );
          if (refusal && !alreadyHeld)
            return {
              kind: "refused" as const,
              granted: false,
              parentApprovalRequired: true,
              reason: `${refusal}; ask the root for this lease`,
            };
        }
        const { lease, created } = await allocateLease(
          (manifest.leases ??= []),
          config,
          {
            resource: params.resource,
            label: params.label,
            workflowId,
            laneId,
            grantedBy: child ? "lane-policy" : "root",
          },
          { probe: probePort, now },
        );
        if (created) {
          workflow.evidence.push({
            at: now(),
            kind: "lease-granted",
            text: `${child ? "Lane-policy" : "Root"} lease for ${laneId}: ${leaseLines([lease])[0]}`,
          });
          workflow.updatedAt = now();
          await saveManifest(cwd, manifest);
        }
        return { kind: "granted" as const, granted: true, created, lease };
      } finally {
        await release();
      }
    }
    if (!params.leaseId) throw new Error("leaseId is required to release a lease.");
    const release = await acquireManifestLock(cwd, 10_000);
    try {
      const manifest = await loadManifest(cwd);
      const lease = (manifest.leases ?? []).find((item) => item.id === params.leaseId);
      if (!lease) throw new Error(`Unknown lease ${params.leaseId}.`);
      if (child && (lease.workflowId !== workflowId || lease.laneId !== laneId))
        throw new Error("A lane may release only its own leases.");
      if (lease.state !== "active") return { kind: "release" as const, released: false, lease };
      releaseLeases(manifest.leases, (item) => item.id === lease.id, child ? "released by lane" : "released by root", now());
      const workflow = manifest.workflows.find((item) => item.id === lease.workflowId);
      if (workflow) {
        workflow.evidence.push({
          at: now(),
          kind: "lease-released",
          text: `${lease.releaseReason}: ${lease.id} ${lease.resource}=${leaseValue(lease)}`,
        });
        workflow.updatedAt = now();
      }
      await saveManifest(cwd, manifest);
      return { kind: "release" as const, released: true, lease };
    } finally {
      await release();
    }
  }

  function responseRecord(
    value: unknown,
    label: string,
  ): Record<string, unknown> {
    const candidate =
      isRecord(value) && isRecord(value.result) ? value.result : value;
    if (!isRecord(candidate))
      throw new Error(
        `Herdr ${label} response did not contain an object result.`,
      );
    return candidate;
  }

  function requiredString(
    value: Record<string, unknown>,
    key: string,
    label: string,
  ): string {
    if (typeof value[key] !== "string" || !value[key])
      throw new Error(`Herdr ${label} response is missing ${key}.`);
    return value[key] as string;
  }

  function controllerConfigDirectoryFrom(stdout: string): string {
    const text = stdout.trim();
    if (!text)
      throw new Error("Herdr returned an empty controller config directory.");
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "string") return parsed;
      const result = responseRecord(parsed, "plugin config-dir");
      return requiredString(result, "config_dir", "plugin config-dir");
    } catch (error) {
      if (text.startsWith("{") || text.startsWith("[")) throw error;
      return text;
    }
  }

  const GOAL_SIDEBAR_TOKEN_NAMES = [
    "herdr_goal_status",
    "herdr_goal_next_1",
    "herdr_goal_next_2",
    "herdr_goal_next_3",
    "herdr_queue",
  ] as const;

  function wrapSidebarText(text: string, width = 20): string[] {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > width && line) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) lines.push(line);
    return lines;
  }

  function parentGoalSidebarTokens(
    goal: ParentGoal,
    queue?: QueueStore,
  ): Record<string, string | undefined> {
    const status = goal.status.replaceAll("-", " ");
    const next = wrapSidebarText(goal.nextAction).slice(0, 3);
    const pending = queue?.items.filter((item) => item.state === "pending") ?? [];
    const head = pending[0];
    return {
      herdr_goal_status: `Goal: ${status}`,
      herdr_goal_next_1: next[0] ? `Next: ${next[0]}` : undefined,
      herdr_goal_next_2: next[1],
      herdr_goal_next_3: next[2],
      ...(queue
        ? {
            herdr_queue: `${pending.length} pending · head ${head ? laneSlug(head.objective) : "none"}`,
          }
        : {}),
    };
  }

  function parentGoalMobileLabel(goal: ParentGoal): string {
    return `Goal: ${goal.status.replaceAll("-for-event", "").replaceAll("-", " ")}`;
  }

  async function publishParentGoalSidebar(
    goal: ParentGoal,
    signal?: AbortSignal,
    queue?: QueueStore,
  ): Promise<void> {
    await refreshHerdrIdentity(signal);
    if (!isRootOrchestrator()) return;
    const paneId = process.env[HERDR_PANE_ID_ENV];
    if (!paneId) return;
    const args = ["pane", "report-metadata", paneId, "--source", OWNER];
    for (const name of GOAL_SIDEBAR_TOKEN_NAMES) {
      const value = parentGoalSidebarTokens(goal, queue)[name];
      if (value) args.push("--token", `${name}=${value}`);
      else args.push("--clear-token", name);
    }
    const mobileLabel = parentGoalMobileLabel(goal);
    // Herdr's compact/mobile switcher uses only state labels, not sidebar rows.
    // Cover idle-but-unseen panes, which the switcher renders as "done".
    args.push(
      "--state-label",
      `idle=${mobileLabel}`,
      "--state-label",
      `done=${mobileLabel}`,
    );
    args.push("--ttl-ms", "86400000");
    await runHerdrRaw(args, signal);
  }

  async function clearParentGoalSidebar(signal?: AbortSignal): Promise<void> {
    await refreshHerdrIdentity(signal);
    if (!isRootOrchestrator()) return;
    const paneId = process.env[HERDR_PANE_ID_ENV];
    if (!paneId) return;
    const args = ["pane", "report-metadata", paneId, "--source", OWNER];
    for (const name of GOAL_SIDEBAR_TOKEN_NAMES)
      args.push("--clear-token", name);
    args.push("--clear-state-labels");
    await runHerdrRaw(args, signal);
  }

  async function controllerConfigPath(signal?: AbortSignal): Promise<string> {
    const directory = await secureControllerConfigDirectory(
      controllerConfigDirectoryFrom(
        await runHerdrRaw(
          ["plugin", "config-dir", CONTROLLER_PLUGIN_ID],
          signal,
        ),
      ),
    );
    // Keep synchronous routing readers aligned with Herdr's live answer. The
    // inherited value may be a frozen project registration snapshot.
    process.env[HERDR_PLUGIN_CONFIG_DIR_ENV] = directory;
    return join(directory, CONTROLLER_CONFIG_NAME);
  }

  async function wakeParentForQuestion(
    cwd: string,
    request: ParentQuestionRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    const assignment = currentChildAssignment();
    cwd = assignment.cwd;
    if (
      request.workflowId !== assignment.workflow.workflow_id ||
      request.paneId !== assignment.lane.pane_id
    )
      throw new Error(
        "Question does not belong to the current child assignment.",
      );
    if (request.delivery?.status === "delivered") return;
    if (
      request.delivery?.status === "sending" ||
      request.delivery?.status === "uncertain"
    )
      throw new Error(
        `Question ${request.id} is durable; notification delivery is uncertain. Do not resubmit terminal input.`,
      );
    const root = assignment.record.root;
    const result = await runHerdr(["agent", "get", root.pane_id], signal);
    const live = liveAgentIdentity(result, "question parent get");
    if (
      live.paneId !== root.pane_id ||
      live.workspaceId !== root.workspace_id ||
      (root.agent_kind && live.kind !== root.agent_kind) ||
      (root.target_kind === "name" && live.name !== root.target)
    )
      throw new Error(
        `Question ${request.id} remains pending: parent identity mismatch.`,
      );
    if (!["idle", "done"].includes(deepState(result) ?? "unknown"))
      throw new Error(
        `Question ${request.id} remains pending: parent is not ready.`,
      );
    const updateDelivery = async (
      status: "sending" | "delivered" | "uncertain",
      reason?: string,
    ) => {
      const release = await acquireManifestLock(cwd, 10_000);
      try {
        const manifest = await loadManifest(cwd);
        const stored = workflowFor(
          manifest,
          request.workflowId!,
        ).questionRequests?.find((item) => item.id === request.id);
        if (!stored)
          throw new Error(`Durable question ${request.id} is missing.`);
        if (status === "sending" && stored.delivery?.status !== "pending")
          return false;
        stored.delivery = {
          status,
          updatedAt: now(),
          ...(reason ? { reason } : {}),
        };
        await saveManifest(cwd, manifest);
        return true;
      } finally {
        await release();
      }
    };
    // Claim before terminal I/O. A crash or lost reply cannot authorize retyping.
    if (!(await updateDelivery("sending"))) return;
    try {
      await runHerdr(
        [
          "agent",
          "prompt",
          root.pane_id,
          `A mapped Herdr child needs a parent answer. Ask Zach the durable question in request ${request.id}, then call herdr_question_answer with that request ID and Zach's answer.\n\n${request.question}`,
          "--wait",
        ],
        signal,
      );
    } catch (error) {
      await updateDelivery("uncertain", clip((error as Error).message, 1000));
      throw new Error(
        `Question ${request.id} is durable; notification delivery is uncertain. Do not resubmit terminal input.`,
      );
    }
    await updateDelivery("delivered");
  }

  async function answerChildQuestion(
    cwd: string,
    requestId: string,
    answer: string,
    signal?: AbortSignal,
  ): Promise<ParentQuestionRequest> {
    requireRootGoalExecutor();
    const release = await acquireManifestLock(cwd);
    try {
      const manifest = await loadManifest(cwd);
      const containers = [
        { requests: manifest.questionRequests, workflow: undefined },
        ...manifest.workflows.map((workflow) => ({
          requests: workflow.questionRequests,
          workflow,
        })),
      ];
      const container = containers.find((item) =>
        item.requests?.some((request) => request.id === requestId),
      );
      const request = container?.requests?.find(
        (item) => item.id === requestId,
      );
      if (!request)
        throw new Error(
          `No durable parent question exists with ID ${requestId}.`,
        );
      if (request.status === "answered") return request;
      if (!request.paneId)
        throw new Error(
          `Question ${requestId} has no child pane to receive an answer.`,
        );

      request.answer = answer;
      request.answeredAt = now();
      request.status = "answer-delivery-pending";
      if (container?.workflow) {
        container.workflow.evidence.push({
          at: now(),
          kind: "parent-question-answered",
          text: `Parent answer for ${requestId} is awaiting delivery to ${request.paneId}.`,
        });
      }
      await saveManifest(cwd, manifest);
      try {
        await runHerdr(
          [
            "agent",
            "prompt",
            request.paneId,
            `Herdr parent answer to your question (${requestId}):\n${answer}`,
            "--wait",
          ],
          signal,
        );
      } catch (error) {
        throw new Error(
          `The answer is durable but child delivery is pending: ${(error as Error).message}`,
        );
      }
      request.status = "answered";
      await saveManifest(cwd, manifest);
      return request;
    } finally {
      await release();
    }
  }

  type LiveAgentIdentity = {
    name?: string;
    kind: AgentKind;
    paneId: string;
    workspaceId: string;
  };

  function liveAgentIdentity(value: unknown, label: string): LiveAgentIdentity {
    const result = responseRecord(value, label);
    if (result.type !== "agent_info" || !isRecord(result.agent))
      throw new Error(`Herdr ${label} response is not an agent_info record.`);
    const agent = result.agent;
    const name = agent.name;
    if (
      name !== null &&
      name !== undefined &&
      (typeof name !== "string" || !name)
    )
      throw new Error(`Herdr ${label} response has an invalid agent name.`);
    return {
      ...(typeof name === "string" ? { name } : {}),
      kind: validateAgentKind(agent.agent, `Herdr ${label} agent kind`),
      paneId: requiredString(agent, "pane_id", label),
      workspaceId: requiredString(agent, "workspace_id", label),
    };
  }

  async function currentPaneRoot(
    signal?: AbortSignal,
  ): Promise<ControllerRootMapping> {
    const identity = await refreshHerdrIdentity(signal);
    const paneId = identity.paneId;
    if (!paneId)
      throw new Error(
        `${HERDR_PANE_ID_ENV} is required to discover the current pane identity.`,
      );
    const agent = liveAgentIdentity(
      await runHerdr(["agent", "get", paneId], signal),
      "current pane agent get",
    );
    if (agent.paneId !== paneId)
      throw new Error(
        "Herdr current pane identity does not match the requested pane target.",
      );
    return {
      target: paneId,
      target_kind: "pane_id",
      agent_kind: agent.kind,
      pane_id: agent.paneId,
      workspace_id: agent.workspaceId,
    };
  }

  async function reconcileRootIdentity(
    cwd: string,
    signal?: AbortSignal,
    sessionPath?: string,
  ): Promise<{ 
    reconciled: boolean;
    root: ControllerRootMapping;
    previousRoot: ControllerRootMapping;
    configPath: string;
    manifestPath: string;
    evidence: string[];
  }> {
    requireHerdr();
    const root = await currentPaneRoot(signal);
    const rootAgent = responseRecord(
      await runHerdr(["agent", "get", root.pane_id], signal),
      "root identity reconciliation",
    ).agent;
    const verifiedAgent = liveAgentIdentity(
      { result: { type: "agent_info", agent: rootAgent } },
      "root identity reconciliation",
    );
    if (isRecord(rootAgent) && sessionPath) piRootSessionPathHints.set(rootAgent, sessionPath);
    if (
      verifiedAgent.paneId !== root.pane_id ||
      verifiedAgent.workspaceId !== root.workspace_id ||
      verifiedAgent.kind !== root.agent_kind
    )
      throw new Error(
        "Herdr current pane identity changed during root reconciliation; retry from the verified pane.",
      );

    const configPath = await controllerConfigPath(signal);
    const resolvedCwd = resolve(cwd);
    const manifestFile = resolve(manifestPath(cwd));
    const findRoot = (config: ControllerConfig): ControllerOrchestrator => {
      const childMatches = config.orchestrators.flatMap((orchestrator) =>
        orchestrator.workflows.flatMap((workflow) =>
          workflow.lanes
            .filter(
              (lane) =>
                lane.pane_id === root.pane_id &&
                lane.workspace_id === root.workspace_id,
            )
            .map((lane) => `${orchestrator.id}/${workflow.workflow_id}/${lane.lane_id}`),
        ),
      );
      if (childMatches.length > 0)
        throw new Error(
          `Current pane ${root.pane_id} is registered as a child lane (${childMatches.join(", ")}) and cannot reconcile root authority.`,
        );

      const sameIdentity = config.orchestrators.filter(
        (candidate) =>
          candidate.root.pane_id === root.pane_id &&
          candidate.root.workspace_id === root.workspace_id,
      );
      if (sameIdentity.length > 1)
        throw new Error(
          `Current pane ${root.pane_id} has ambiguous root mappings for workspace ${root.workspace_id}; reconciliation is refused.`,
        );
      const samePane = config.orchestrators.filter(
        (candidate) => candidate.root.pane_id === root.pane_id,
      );
      if (samePane.some((candidate) => candidate.root.workspace_id !== root.workspace_id))
        throw new Error(
          `Current pane ${root.pane_id} has root mappings in multiple workspaces; reconciliation is refused.`,
        );
      const current = sameIdentity[0];
      if (!current)
        throw new Error(
          `Current verified pane ${root.pane_id} in workspace ${root.workspace_id} is not a registered root; bootstrap it before reconciling.`,
        );
      if (!rootOwnsManifest(current, cwd))
        throw new Error(
          `Current root ${current.id} is registered for a different project and cannot be reconciled from ${resolvedCwd}.`,
        );
      return current;
    };

    // Keep lock order identical to bootstrapRoot: manifest first, then the
    // controller config. This prevents a concurrent bootstrap/reconciliation
    // pair from waiting on each other indefinitely.
    const releaseManifest = await acquireManifestLock(cwd, 10_000);
    try {
      const releaseConfig = await acquireControllerConfigLock(configPath, 10_000);
      try {
        const latestConfig = await loadControllerConfig(configPath);
        if (!latestConfig)
          throw new Error("Herdr controller config disappeared during reconciliation.");
        const current = findRoot(latestConfig);
        const previousRoot = { ...current.root };
        const nextRoot: ControllerRootMapping = {
          ...current.root,
          agent_kind: root.agent_kind,
        };
        const identityChanged = !sameControllerRoot(current.root, nextRoot);
        const nextOrchestrator: ControllerOrchestrator = {
          ...current,
          root: nextRoot,
        };
        if (identityChanged)
          await saveControllerConfig(configPath, {
            ...latestConfig,
            orchestrators: latestConfig.orchestrators.map((candidate) =>
              candidate.id === current.id ? nextOrchestrator : candidate,
            ),
          });

        const manifest = await loadManifest(cwd);
        const scope: CurrentRootScope = {
          rootId: current.id,
          root: nextRoot,
          orchestrator: nextOrchestrator,
        };
        const currentSession =
          manifest.rootSessionLogs?.find((entry) => entry.rootId === current.id) ??
          (legacyRootIdForManifest(cwd) === current.id
            ? manifest.sessionLog
            : undefined);
        const expectedPersistence = rootSessionPersistence(nextRoot, rootAgent);
        const sessionNeedsRefresh =
          !currentSession ||
          currentSession.paneId !== nextRoot.pane_id ||
          currentSession.workspaceId !== nextRoot.workspace_id ||
          JSON.stringify(currentSession.sessionRef) !==
            JSON.stringify(expectedPersistence);
        let manifestChanged = false;
        if (sessionNeedsRefresh) {
          rootSessionEntryFor(
            manifest,
            cwd,
            scope,
            rootAgent,
            currentSession?.startedAt ?? manifest.sessionLog?.startedAt ?? now(),
            now(),
          );
          manifestChanged = true;
        }
        const refreshRootSnapshot = (value: unknown): void => {
          if (!isRecord(value) || !isRecord(value.root)) return;
          if (sameControllerRoot(value.root as ControllerRootMapping, nextRoot))
            return;
          value.root = { ...nextRoot };
          manifestChanged = true;
        };
        refreshRootSnapshot(manifest.parentGoals?.[current.id]);
        refreshRootSnapshot(
          manifest.rootSessionLogs?.find((entry) => entry.rootId === current.id),
        );
        refreshRootSnapshot(
          manifest.rootQueues?.roots.find((entry) => entry.rootId === current.id),
        );
        for (const history of manifest.goalHistoryByRoot?.[current.id] ?? [])
          refreshRootSnapshot(history);
        if (manifestChanged) await saveManifest(cwd, manifest);

        const changes: string[] = [];
        if (identityChanged)
          changes.push(
            `agent_kind ${previousRoot.agent_kind ?? "<unset>"} -> ${nextRoot.agent_kind}`,
          );
        if (sessionNeedsRefresh)
          changes.push("durable root session identity refreshed");
        if (manifestChanged && !sessionNeedsRefresh)
          changes.push("root-scoped manifest identity snapshots refreshed");
        return {
          reconciled: changes.length > 0,
          root: nextRoot,
          previousRoot,
          configPath,
          manifestPath: manifestFile,
          evidence: changes.length
            ? [`Reconciled current verified root ${current.id}: ${changes.join("; ")}.`]
            : [`Root ${current.id} identity is already current; no state changed.`],
        };
      } finally {
        await releaseConfig();
      }
    } finally {
      await releaseManifest();
    }
  }

  async function discoverControllerRoot(
    signal?: AbortSignal,
  ): Promise<ControllerRootMapping> {
    await refreshHerdrIdentity(signal);
    if (!isRootOrchestrator())
      throw new Error(
        "Only the verified controller-mapped root may register the event controller.",
      );
    return currentPaneRoot(signal);
  }

  async function recoverRoot(
    cwd: string,
    oldRootId: string,
    execute: boolean,
    expectedFingerprint: string | undefined,
    evidence: string | undefined,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) {
    requireHerdr();
    const root = await currentPaneRoot(signal);
    if (process.env.HERDR_WORKSPACE_ID !== root.workspace_id)
      throw new Error("Current environment workspace differs from native pane identity.");
    const rootAgent = responseRecord(await runHerdr(["agent", "get", root.pane_id], signal), "recovery root").agent;
    const live = liveAgentIdentity({ type: "agent_info", agent: rootAgent }, "recovery root");
    if (live.paneId !== root.pane_id || live.workspaceId !== root.workspace_id || live.kind !== root.agent_kind)
      throw new Error("Native root identity changed during discovery.");
    if (!isRecord(rootAgent) || !isRecord(rootAgent.agent_session) || rootAgent.agent_session.kind !== "path" ||
      rootAgent.agent_session.value !== ctx.sessionManager.getSessionFile())
      throw new Error("Recovery requires this exact live native session path.");
    const configPath = await controllerConfigPath(signal);
    const auditDir = join(dirname(manifestPath(cwd)), "root-recovery");
    const release = await acquireManifestLock(cwd);
    try {
      const configLock = `${configPath}.lock`;
      await mkdir(configLock, { mode: 0o700 });
      try {
        await assertNoPendingRecovery(auditDir);
        await loadControllerConfig(configPath); // Validate existing controller schema/security.
        const before = await readRecoveryFiles(configPath, manifestPath(cwd));
        const config = JSON.parse(before.config);
        const old = config.orchestrators?.find((item: ControllerOrchestrator) => item.id === oldRootId);
        if (!old) throw new Error("Selected old root does not exist.");
        // A missing agent alone is not proof a workspace has disappeared.
        const workspaces = responseRecord(await runHerdr(["workspace", "list"], signal), "recovery workspace list");
        if (!Array.isArray(workspaces.workspaces)) throw new Error("No authoritative workspace list.");
        const liveWorkspaceIds = workspaces.workspaces.map(item => {
          if (!isRecord(item)) throw new Error("Invalid workspace list entry.");
          return requiredString(item, "workspace_id", "recovery workspace list");
        });
        let missing = false;
        try { await runHerdr(["agent", "get", old.root.pane_id], signal); }
        catch (error) {
          const prefix = `herdr agent get ${old.root.pane_id} failed: `;
          const text = error instanceof Error ? error.message : String(error);
          let failure: unknown;
          try { if (text.startsWith(prefix)) failure = JSON.parse(text.slice(prefix.length)); } catch { /* fail closed */ }
          if (!isRecord(failure) || !isRecord(failure.error) || failure.error.code !== "agent_not_found") throw error;
          missing = true;
        }
        if (!missing) throw new Error("Old root is still live; migration refused.");
        const session = rootSessionEntry(root, rootAgent, undefined, now(), undefined);
        const plan = rootRecoveryPlan({ config, manifest: JSON.parse(before.manifest), cwd, oldRootId, root, session, liveWorkspaceIds });
        const fingerprint = recoveryHash(JSON.stringify({ before, oldRootId, root, sessionRef: session.sessionRef }));
        if (!execute) return { mode: "preview", fingerprint, oldRootId, newRootId: plan.newRootId, oldRoot: plan.oldRoot, root, workflowIds: plan.workflowIds,
          note: "No migration applied. Exact preimages will be audited on execution. Historical task bindings and receipts remain unchanged; this does not verify or resume old workflows." };
        if (expectedFingerprint !== fingerprint) throw new Error("Recovery preview is missing or stale; preview again.");
        if (!evidence?.trim()) throw new Error("Explicit migration authorization/evidence is required.");
        return { mode: "applied", ...await commitRootRecovery({ configPath, manifestPath: manifestPath(cwd), auditDir, before, plan, evidence: evidence.trim() }) };
      } finally { await rm(configLock, { recursive: true, force: true }); }
    } finally { await release(); }
  }

  async function bootstrapRoot(
    cwd: string,
    reset: boolean,
    add: boolean,
    confirm: boolean,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<{
    root: ControllerRootMapping;
    configPath: string;
    reset: boolean;
    add: boolean;
    manifestReset: boolean;
    alreadyRegistered: boolean;
    evidence: string[];
  }> {
    requireHerdr();
    if (add && reset)
      throw new Error(
        "herdr_bootstrap_root add=true cannot be combined with reset=true; add mode never resets existing mappings or manifest state.",
      );
    const root = await currentPaneRoot(signal);
    const rootAgent = responseRecord(
      await runHerdr(["agent", "get", root.pane_id], signal),
      "bootstrap root session",
    ).agent;
    const resolvedCwd = resolve(cwd);
    const configPath = await controllerConfigPath(signal);
    const config = await loadControllerConfig(configPath);
    const manifestHasState = (manifest: ManifestWithQueue): boolean =>
      manifest.workflows.length > 0 ||
      manifest.parentGoal !== undefined ||
      (manifest.parentGoals ? Object.keys(manifest.parentGoals).length : 0) > 0 ||
      (manifest.goalHistoryByRoot
        ? Object.keys(manifest.goalHistoryByRoot).length
        : 0) > 0 ||
      (manifest.questionRequests?.length ?? 0) > 0 ||
      (manifest.messageRequests?.length ?? 0) > 0 ||
      (manifest.queue?.items.length ?? 0) > 0 ||
      (manifest.rootQueues?.roots.length ?? 0) > 0 ||
      (manifest.rootSessionLogs?.length ?? 0) > 0;
    const existingManifest = await loadManifest(cwd);
    const manifestHasLegacyState = manifestHasState(existingManifest);
    if (
      config?.orchestrators.some((record) =>
        record.workflows.some((workflow) =>
          workflow.lanes.some((lane) => lane.pane_id === root.pane_id),
        ),
      )
    )
      throw new Error(
        "The current pane is already a registered child lane and cannot claim root authority.",
      );
    const rootForPaneAndCwd = (
      candidate: ControllerConfig | undefined,
    ): ControllerOrchestrator | undefined =>
      candidate?.orchestrators.find(
        (record) =>
          record.root.pane_id === root.pane_id &&
          record.root.workspace_id === root.workspace_id &&
          record.program.id === resolvedCwd,
      );
    const rootForPane = (
      candidate: ControllerConfig | undefined,
    ): ControllerOrchestrator | undefined =>
      candidate?.orchestrators.find(
        (record) =>
          record.root.pane_id === root.pane_id &&
          !(
            record.root.workspace_id === root.workspace_id &&
            record.program.id === resolvedCwd
          ),
      );
    const rootForWorkspace = (
      candidate: ControllerConfig | undefined,
    ): ControllerOrchestrator | undefined =>
      candidate?.orchestrators.find(
        (record) =>
          record.root.workspace_id === root.workspace_id &&
          !(
            record.root.pane_id === root.pane_id &&
            record.program.id === resolvedCwd
          ),
      );
    const current = rootForPaneAndCwd(config);
    const conflictingPaneRoot = rootForPane(config);
    const existingStateMessage = (
      candidate: ControllerConfig | undefined,
    ): string =>
      rootForWorkspace(candidate)
        ? "Controller config or parent manifest has existing state, including a root already registered in this pane's workspace. Review it, then call herdr_bootstrap_root with reset=true to retire it before claiming this manually started root."
        : "Controller config or parent manifest has existing state from a different pane/workspace. This pane's workspace has no existing root, so add=true registers a concurrent root without touching any existing root or manifest state; use reset=true only if you intend to retire every existing root and wipe the shared parent manifest for this cwd.";
    const labelEvidence: string[] = [];
    let rootTabId: string | undefined;
    // Best-effort sync read for display labels only; authoritative manifest
    // access stays on the transactional async path.
    const readManifestForLabel = (
      labelCwd: string,
    ): {
      parentGoal?: { objective?: string };
      parentGoals?: Record<string, { objective?: string; goal?: { objective?: string } }>;
    } | undefined => {
      try {
        return JSON.parse(
          readFileSync(manifestPath(labelCwd), "utf8"),
        ) as {
          parentGoal?: { objective?: string };
          parentGoals?: Record<string, { objective?: string; goal?: { objective?: string } }>;
        };
      } catch {
        return undefined;
      }
    };
    // Multi-root label: the root's tab carries its distinguishing handle
    // (harness kind + workspace) so concurrent roots stay distinguishable,
    // plus the current goal slug when one is registered.
    const rootTabLabel = (): string => {
      const kind = root.agent_kind ?? "root";
      const handle = `${kind}\u00b7${root.workspace_id}`;
      try {
        const manifest = readManifestForLabel(cwd);
        const rootGoal =
          manifest?.parentGoals?.[current?.id ?? controllerRecordId(root, cwd)];
        const objective = rootGoal?.goal?.objective ??
          rootGoal?.objective ??
          (current && manifest?.parentGoal?.objective
            ? manifest.parentGoal.objective
            : undefined);
        const slug = objective ? laneSlug(objective) : "";
        return slug ? `\ud83d\udc15 ${handle} \u00b7 ${slug}` : `\ud83d\udc15 ${handle}`;
      } catch {
        return `\ud83d\udc15 ${handle}`;
      }
    };
    const renameRootTab = async (): Promise<void> => {
      try {
        const paneResult = responseRecord(
          await runHerdr(["pane", "get", root.pane_id], signal),
          "root pane get for tab label",
        );
        if (!isRecord(paneResult.pane))
          throw new Error("Herdr root pane response has no pane record.");
        const tabId = requiredString(
          paneResult.pane,
          "tab_id",
          "root pane get for tab label",
        );
        rootTabId = tabId;
        const label = rootTabLabel();
        await runHerdr(["tab", "rename", tabId, label], signal);
        labelEvidence.push(`Root tab ${tabId} labeled ${label}.`);
      } catch (error) {
        // Labels are display-only. A native renderer/API mismatch must never
        // make a verified root bootstrap fail after its durable claim landed.
        labelEvidence.push(
          `Root tab label could not be applied: ${String(error)}`,
        );
      }
    };
    const persistRootTabId = async (): Promise<void> => {
      if (!rootTabId) return;
      await withManifestTransaction(cwd, (manifest) => {
        const rootId = current?.id ?? controllerRecordId(root, cwd);
        const entry = manifest.rootSessionLogs?.find(
          (candidate) => candidate.rootId === rootId,
        );
        if (entry) entry.tabId = rootTabId;
        if (
          manifest.sessionLog?.kind === "root" &&
          manifest.sessionLog.paneId === root.pane_id &&
          manifest.sessionLog.workspaceId === root.workspace_id
        )
          manifest.sessionLog = { ...manifest.sessionLog, tabId: rootTabId };
        return manifest;
      });
    };
    if (current && !reset) {
      await withManifestTransaction(cwd, (manifest) => {
        const stamp = now();
        const scope: CurrentRootScope = {
          rootId: current.id,
          root: current.root,
          orchestrator: current,
        };
        const goal = rootGoalFor(manifest, cwd, scope).goal;
        const priorActivity =
          goal?.supervisor?.rootTurn?.updatedAt ??
          goal?.supervisor?.rootActivity?.observedAt;
        rootSessionEntryFor(
          manifest,
          cwd,
          scope,
          rootAgent,
          manifest.rootSessionLogs?.find((entry) => entry.rootId === current.id)
            ?.startedAt ?? manifest.sessionLog?.startedAt ?? stamp,
          laterTimestamp(priorActivity, stamp),
        );
        return manifest;
      });
      await renameRootTab();
      await persistRootTabId();
      return {
        root,
        configPath,
        reset: false,
        add,
        manifestReset: false,
        alreadyRegistered: true,
        evidence: labelEvidence,
      };
    }
    if (conflictingPaneRoot && !reset)
      throw new Error(
        `Current pane ${root.pane_id} is already registered by orchestrator ${conflictingPaneRoot.id} for cwd ${conflictingPaneRoot.program.id}; claiming ${resolvedCwd} requires reset=true (add mode never replaces a different cwd).`,
      );
    if (add && rootForWorkspace(config)) {
      const conflictingWorkspaceRoot = rootForWorkspace(config)!;
      throw new Error(
        `Cannot add root in workspace ${root.workspace_id}: orchestrator ${conflictingWorkspaceRoot.id} already uses this workspace with root pane ${conflictingWorkspaceRoot.root.pane_id}. Add mode requires both a distinct pane and a distinct workspace; use reset=true only to replace existing mappings.`,
      );
    }
    if (
      !add &&
      ((config && config.orchestrators.length > 0) || manifestHasLegacyState)
    ) {
      if (!reset) throw new Error(existingStateMessage(config));
    }
    const label = add
      ? "Add this manually started Baa-ton root"
      : reset
        ? "Reset Baa-ton controller mappings and claim this root"
        : "Claim this manually started Baa-ton root";
    if (
      confirm &&
      !(await nativeConfirms.confirm(
        ctx.ui,
        "Herdr orchestrator",
        `${label}? ${reset ? "This retires the existing controller mapping and parent manifest state." : add ? "This appends a controller mapping for the distinct current pane/workspace and leaves all existing roots and manifests intact." : "This records the verified current pane/workspace and a clean parent manifest."} It does not create lanes or enable the controller.`,
      ))
    )
      throw new Error("Root bootstrap was cancelled.");
    const next: ControllerOrchestrator = {
      id: controllerRecordId(root, cwd),
      root,
      program: {
        id: resolvedCwd,
        workspace_id: root.workspace_id,
        parent_manifest_path: resolve(manifestPath(cwd)),
      },
      workflows: [],
    };
    let alreadyRegisteredAfterLock = false;
    const release = await acquireManifestLock(cwd);
    try {
      const configLockPath = `${configPath}.lock`;
      await mkdir(configLockPath, { mode: 0o700 });
      try {
        // Reconcile against the config and manifest observed after the user
        // confirmation. The config lock prevents a concurrent root bootstrap
        // from being lost by this append.
        const latestConfig = await loadControllerConfig(configPath);
        const latestManifest = await loadManifest(cwd);
        const latestCurrent = rootForPaneAndCwd(latestConfig);
        if (latestCurrent && !reset) {
          alreadyRegisteredAfterLock = true;
        } else {
          const latestPaneConflict = rootForPane(latestConfig);
          if (latestPaneConflict && !reset)
            throw new Error(
              `Current pane ${root.pane_id} is already registered by orchestrator ${latestPaneConflict.id} for cwd ${latestPaneConflict.program.id}; claiming ${resolvedCwd} requires reset=true (add mode never replaces a different cwd).`,
            );
          const latestWorkspaceConflict = rootForWorkspace(latestConfig);
          if (add && latestWorkspaceConflict)
            throw new Error(
              `Cannot add root in workspace ${root.workspace_id}: orchestrator ${latestWorkspaceConflict.id} already uses this workspace with root pane ${latestWorkspaceConflict.root.pane_id}. Add mode requires both a distinct pane and a distinct workspace; use reset=true only to replace existing mappings.`,
            );
          if (
            !add &&
            ((latestConfig && latestConfig.orchestrators.length > 0) ||
              manifestHasState(latestManifest)) &&
            !reset
          )
            throw new Error(existingStateMessage(latestConfig));
          const bootstrapStamp = now();
          const rootScope: CurrentRootScope = {
            rootId: next.id,
            root,
            orchestrator: next,
          };
          const goal = rootGoalFor(latestManifest, cwd, rootScope).goal;
          const priorActivity =
            goal?.supervisor?.rootTurn?.updatedAt ??
            goal?.supervisor?.rootActivity?.observedAt;
          const sameCwdRootCount =
            latestConfig?.orchestrators.filter((candidate) =>
              rootOwnsManifest(candidate, cwd),
            ).length ?? 0;
          const useScopedSession =
            add &&
            (manifestHasState(latestManifest) || sameCwdRootCount > 0);
          let refreshedRootSession: SessionLogEntry;
          if (reset)
            refreshedRootSession = rootSessionEntry(
              root,
              rootAgent,
              latestManifest.sessionLog,
              latestManifest.sessionLog?.startedAt ?? bootstrapStamp,
              laterTimestamp(priorActivity, bootstrapStamp),
            );
          else {
            const scoped = rootSessionEntryFor(
              latestManifest,
              cwd,
              rootScope,
              rootAgent,
              latestManifest.rootSessionLogs?.find(
                (entry) => entry.rootId === next.id,
              )?.startedAt ?? latestManifest.sessionLog?.startedAt ?? bootstrapStamp,
              laterTimestamp(priorActivity, bootstrapStamp),
              useScopedSession,
            );
            const { rootId: _rootId, root: _root, ...legacySession } = scoped;
            refreshedRootSession = legacySession;
          }
          // Preserve compatibility with a destructive reset of a legacy
          // manifest that never had a root session trace. A reset with an
          // existing trace, or a genuinely fresh reset, records the root;
          // there is otherwise no prior root identity to preserve.
          const persistResetSession =
            !reset || Boolean(latestManifest.sessionLog) || !manifestHasState(latestManifest);
          if (reset) {
            await saveManifest(cwd, {
              version: 2,
              workflows: [],
              ...(persistResetSession ? { sessionLog: refreshedRootSession } : {}),
            });
            // A destructive root reset retires the standing-policy
            // acknowledgement too; the next routine operation asks again.
            await rm(approvalAckPath(cwd), { force: true });
            writtenApprovalAcks.delete(approvalAckPath(cwd));
          }
          else if (add && useScopedSession)
            // A co-root gets a durable root-owned trace while every existing
            // workflow, goal, queue, and legacy projection remains intact.
            await saveManifest(cwd, latestManifest);
          else if (add && !manifestHasState(latestManifest))
            // A new root owns a private manifest even before its first goal or
            // workflow is created; never rewrite a manifest containing state.
            await saveManifest(cwd, {
              ...latestManifest,
              sessionLog: refreshedRootSession,
            });
          else if (!latestManifest.sessionLog)
            await saveManifest(cwd, {
              ...latestManifest,
              sessionLog: refreshedRootSession,
            });
          else if (current && !reset)
            await saveManifest(cwd, latestManifest);
          await saveControllerConfig(
            configPath,
            reset || !latestConfig
              ? { version: 2, owner: OWNER, orchestrators: [next] }
              : {
                  ...latestConfig,
                  orchestrators: [...latestConfig.orchestrators, next],
                },
          );
        }
      } finally {
        await rm(configLockPath, { recursive: true, force: true });
      }
    } finally {
      await release();
    }
    if (alreadyRegisteredAfterLock) {
      await withManifestTransaction(cwd, (manifest) => {
        const stamp = now();
        const scope: CurrentRootScope = {
          rootId: controllerRecordId(root, cwd),
          root,
          orchestrator: {
            id: controllerRecordId(root, cwd),
            root,
            program: {
              id: resolvedCwd,
              workspace_id: root.workspace_id,
              parent_manifest_path: resolve(manifestPath(cwd)),
            },
            workflows: [],
          },
        };
        const goal = rootGoalFor(manifest, cwd, scope).goal;
        const priorActivity =
          goal?.supervisor?.rootTurn?.updatedAt ??
          goal?.supervisor?.rootActivity?.observedAt;
        rootSessionEntryFor(
          manifest,
          cwd,
          scope,
          rootAgent,
          manifest.rootSessionLogs?.find((entry) => entry.rootId === scope.rootId)
            ?.startedAt ?? manifest.sessionLog?.startedAt ?? stamp,
          laterTimestamp(priorActivity, stamp),
        );
        return manifest;
      });
      await renameRootTab();
      await persistRootTabId();
      return {
        root,
        configPath,
        reset: false,
        add,
        manifestReset: false,
        alreadyRegistered: true,
        evidence: labelEvidence,
      };
    }
    await renameRootTab();
    await persistRootTabId();
    return {
      root,
      configPath,
      reset,
      add,
      manifestReset: reset,
      alreadyRegistered: false,
      evidence: labelEvidence,
    };
  }

  async function controllerWorkflowMapping(
    cwd: string,
    workflow: Workflow,
    signal?: AbortSignal,
  ): Promise<ControllerWorkflowMapping> {
    const workspaceId = workflow.ownership.workspaceId;
    if (!workspaceId)
      throw new Error(
        "Workflow has no recorded Herdr workspace for controller registration.",
      );
    const lanes: ControllerLaneMapping[] = [];
    for (const lane of workflow.lanes) {
      if (!lane.agentName || !lane.paneId)
        throw new Error(
          `Lane ${lane.id} has no recorded agent or pane for controller registration.`,
        );
      const agent = liveAgentIdentity(
        await runHerdr(["agent", "get", lane.agentName], signal),
        `lane ${lane.id} agent get`,
      );
      if (
        agent.name !== lane.agentName ||
        agent.kind !== laneAgentKind(workflow, lane) ||
        agent.paneId !== lane.paneId ||
        agent.workspaceId !== workspaceId
      )
        throw new Error(
          `Lane ${lane.id} Herdr identity does not match its recorded agent, kind, pane, and workspace.`,
        );
      lanes.push({
        lane_id: lane.id,
        target: agent.name,
        target_kind: "name",
        pane_id: agent.paneId,
        workspace_id: agent.workspaceId,
        ...(lane.relationshipId
          ? { relationship_id: lane.relationshipId }
          : {}),
      });
    }
    return {
      workflow_id: workflow.id,
      manifest_path: resolve(manifestPath(cwd)),
      // This controller integration is agent-neutral; Pi-only output probing
      // remains opt-in and is never enabled by automatic registration.
      pi_goal_pause_detection: false,
      lanes,
    };
  }

  function recordControllerRegistration(
    workflow: Workflow,
    registration: EventControllerRegistration,
  ): void {
    const previous = workflow.eventControllerRegistration;
    workflow.eventControllerRegistration = registration;
    if (
      previous?.status === registration.status &&
      previous.reason === registration.reason &&
      previous.configPath === registration.configPath
    )
      return;
    workflow.evidence.push({
      at: now(),
      kind:
        registration.status === "registered"
          ? "event-controller-registered"
          : registration.status === "removed"
            ? "event-controller-removed"
            : "event-controller-registration-pending",
      text: registration.reason ?? registration.status,
    });
  }

  async function registerEventController(
    cwd: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<EventControllerRegistration> {
    // Read-only snapshot for external identity checks only; the eventual
    // registration write reconciles against a freshly reloaded manifest so
    // it can never clobber a concurrent mutation made while these
    // network/config calls were in flight.
    const workflow = workflowFor(await loadManifest(cwd), id);
    try {
      const [configPath, root] = await Promise.all([
        controllerConfigPath(signal),
        discoverControllerRoot(signal),
      ]);
      const mapping = await controllerWorkflowMapping(cwd, workflow, signal);
      const config = await loadControllerConfig(configPath);
      // A sole v1-derived record is promoted in place on the first matching
      // registration. This avoids leaving a legacy global record beside its
      // v2 replacement and therefore avoids duplicate wakes.
      const legacy =
        config?.orchestrators.length === 1 &&
        config.orchestrators[0].id.startsWith("legacy:") &&
        sameControllerRoot(config.orchestrators[0].root, root)
          ? config.orchestrators[0]
          : undefined;
      const record = config
        ? (findControllerRecord(config, root, cwd) ?? legacy)
        : undefined;
      if (record) {
        const sameId = record.workflows.filter(
          (candidate) => candidate.workflow_id === mapping.workflow_id,
        );
        if (sameId.length > 0 && !sameControllerWorkflow(sameId[0], mapping))
          throw new Error(
            "Linked controller config has a stale or mismatched workflow mapping; refusing to replace it.",
          );
        const promoted = record.id.startsWith("legacy:")
          ? {
              ...record,
              id: controllerRecordId(root, cwd),
              program: {
                id: resolve(cwd),
                workspace_id: root.workspace_id,
                parent_manifest_path: resolve(manifestPath(cwd)),
              },
            }
          : record;
        if (sameId.length === 0 || promoted !== record)
          await saveControllerConfig(configPath, {
            ...config!,
            orchestrators: config!.orchestrators.map((candidate) =>
              candidate.id === record.id
                ? {
                    ...promoted,
                    workflows:
                      sameId.length === 0
                        ? [...promoted.workflows, mapping]
                        : promoted.workflows,
                  }
                : candidate,
            ),
          });
      } else {
        const next: ControllerOrchestrator = {
          id: controllerRecordId(root, cwd),
          root,
          program: {
            id: resolve(cwd),
            workspace_id: root.workspace_id,
            parent_manifest_path: resolve(manifestPath(cwd)),
          },
          workflows: [mapping],
        };
        await saveControllerConfig(
          configPath,
          config
            ? { ...config, orchestrators: [...config.orchestrators, next] }
            : { version: 2, owner: OWNER, orchestrators: [next] },
        );
      }
      const registration: EventControllerRegistration = {
        version: 1,
        status: "registered",
        updatedAt: now(),
        configPath,
        root,
        workflow: mapping,
      };
      return await withManifestTransaction(cwd, (current) => {
        const stored = workflowFor(current, id);
        recordControllerRegistration(stored, registration);
        stored.updatedAt = now();
        return registration;
      });
    } catch (error) {
      const registration: EventControllerRegistration = {
        version: 1,
        status: "pending",
        updatedAt: now(),
        reason: clip((error as Error).message, 1200),
      };
      return await withManifestTransaction(cwd, (current) => {
        const stored = workflowFor(current, id);
        recordControllerRegistration(stored, registration);
        stored.updatedAt = now();
        return registration;
      });
    }
  }

  function registeredControllerRegistration(
    cwd: string,
    workflow: Workflow,
  ): EventControllerRegistration {
    const registration = workflow.eventControllerRegistration;
    if (
      !registration ||
      registration.version !== 1 ||
      registration.status !== "registered" ||
      !registration.configPath ||
      !registration.root ||
      !registration.workflow
    )
      throw new Error(
        "Workflow has no complete registered controller mapping.",
      );
    const root = validateControllerRoot(registration.root);
    const mapping = validateControllerWorkflow(
      registration.workflow,
      "workflow.eventControllerRegistration.workflow",
    );
    if (
      mapping.workflow_id !== workflow.id ||
      !samePath(mapping.manifest_path, manifestPath(cwd)) ||
      mapping.lanes.length !== workflow.lanes.length ||
      mapping.lanes.some((lane) => {
        const current = workflow.lanes.find((item) => item.id === lane.lane_id);
        return (
          !current ||
          current.agentName !== lane.target ||
          current.relationshipId !== lane.relationship_id ||
          current.paneId !== lane.pane_id ||
          workflow.ownership.workspaceId !== lane.workspace_id
        );
      })
    )
      throw new Error("Controller registration record is stale or mismatched.");
    return {
      ...registration,
      configPath: resolve(registration.configPath),
      root,
      workflow: mapping,
    };
  }

  async function linkedControllerConfig(
    registration: EventControllerRegistration,
    signal?: AbortSignal,
  ): Promise<ControllerConfig> {
    const configPath = await controllerConfigPath(signal);
    if (
      !registration.configPath ||
      !samePath(configPath, registration.configPath)
    )
      throw new Error(
        "Linked controller config directory changed since registration.",
      );
    const config = await loadControllerConfig(configPath);
    if (!config) throw new Error("Linked controller config is missing.");
    const record = recordForRegistration(config, registration);
    if (!record)
      throw new Error(
        "Linked controller config root, program, or workflow mapping is stale or mismatched.",
      );
    return config;
  }

  async function unregisterEventController(
    cwd: string,
    workflow: Workflow,
    signal?: AbortSignal,
  ): Promise<void> {
    const registration = registeredControllerRegistration(cwd, workflow);
    const config = await linkedControllerConfig(registration, signal);
    const record = recordForRegistration(config, registration);
    if (!record)
      throw new Error(
        "Linked controller config no longer contains this workflow mapping.",
      );
    const remaining = record.workflows.filter(
      (candidate) =>
        candidate.workflow_id !== registration.workflow!.workflow_id,
    );
    if (remaining.length === record.workflows.length)
      throw new Error(
        "Linked controller config no longer contains this workflow mapping.",
      );
    const orchestrators =
      remaining.length === 0
        ? config.orchestrators
            .map((candidate) =>
              candidate.id === record.id &&
              candidate.program.parent_manifest_path
                ? { ...candidate, workflows: [] }
                : candidate,
            )
            .filter(
              (candidate) =>
                candidate.id !== record.id ||
                candidate.program.parent_manifest_path,
            )
        : config.orchestrators.map((candidate) =>
            candidate.id === record.id
              ? { ...candidate, workflows: remaining }
              : candidate,
          );
    if (orchestrators.length === 0)
      await removeControllerConfig(registration.configPath!);
    else
      await saveControllerConfig(registration.configPath!, {
        ...config,
        orchestrators,
      });
    recordControllerRegistration(workflow, {
      ...registration,
      status: "removed",
      updatedAt: now(),
      reason: "Removed this workflow mapping after successful Herdr close.",
    });
  }

  async function inspectWorktreeForWorkspace(
    cwd: string,
    expectedWorkspaceId?: string,
    signal?: AbortSignal,
  ): Promise<WorktreeBinding> {
    const checkoutPath = await assertCleanLocalWorktree(cwd, signal);
    const worktreeList = responseRecord(
      await runHerdr(["worktree", "list", "--cwd", checkoutPath], signal),
      "worktree list",
    );
    const source = worktreeList.source;
    const worktrees = worktreeList.worktrees;
    if (!isRecord(source) || !Array.isArray(worktrees))
      throw new Error(
        "Herdr worktree list returned no registered repository source.",
      );
    const sourceWorkspaceId = requiredString(
      source,
      "source_workspace_id",
      "worktree list",
    );
    const parentCheckoutPath = requiredString(
      source,
      "source_checkout_path",
      "worktree list",
    );
    const repoKey = requiredString(source, "repo_key", "worktree list");
    const repoRoot = requiredString(source, "repo_root", "worktree list");
    const targetMatches = worktrees.filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) &&
        typeof item.path === "string" &&
        samePath(item.path, checkoutPath),
    );
    if (targetMatches.length !== 1)
      throw new Error(
        `Herdr must register ${checkoutPath} exactly once as a Git worktree; found ${targetMatches.length}.`,
      );
    const targetWorkspaceId = targetMatches[0].open_workspace_id;
    if (expectedWorkspaceId) {
      if (targetWorkspaceId !== expectedWorkspaceId)
        throw new Error(
          `Git worktree ${checkoutPath} is not open in recorded workspace ${expectedWorkspaceId}.`,
        );
    } else if (typeof targetWorkspaceId === "string" && targetWorkspaceId) {
      throw new Error(
        `Git worktree ${checkoutPath} is already open in workspace ${targetWorkspaceId}; this workflow must not reuse it.`,
      );
    }
    if (samePath(parentCheckoutPath, checkoutPath))
      throw new Error(
        "worktreeCwd resolves to the registered parent checkout and would reuse its workspace.",
      );

    const workspaceList = responseRecord(
      await runHerdr(["workspace", "list"], signal),
      "workspace list",
    );
    if (!Array.isArray(workspaceList.workspaces))
      throw new Error(
        "Herdr workspace list returned no registered parent workspaces.",
      );
    const parentCandidates = workspaceList.workspaces.filter(
      (item): item is Record<string, unknown> => {
        if (!isRecord(item) || item.workspace_id !== sourceWorkspaceId)
          return false;
        // A generic parent has no workspace.worktree metadata. When present,
        // validate it against the worktree-list source rather than requiring it.
        if (!isRecord(item.worktree)) return true;
        const worktree = item.worktree;
        return (
          worktree.repo_key === repoKey &&
          typeof worktree.checkout_path === "string" &&
          samePath(worktree.checkout_path, parentCheckoutPath)
        );
      },
    );
    if (parentCandidates.length === 0)
      throw new Error(
        `Herdr has no registered parent workspace for ${parentCheckoutPath}.`,
      );
    if (parentCandidates.length !== 1)
      throw new Error(
        `Herdr found ${parentCandidates.length} registered parent workspaces for ${parentCheckoutPath}; refusing ambiguous worktree dispatch.`,
      );
    const parent = parentCandidates[0];
    const parentWorkspaceId = requiredString(
      parent,
      "workspace_id",
      "workspace list",
    );
    if (parentWorkspaceId !== sourceWorkspaceId)
      throw new Error(
        `Herdr worktree source ${sourceWorkspaceId} does not match its sole registered parent ${parentWorkspaceId}.`,
      );
    return {
      checkoutPath,
      repoParent: {
        workspaceId: parentWorkspaceId,
        checkoutPath: resolve(parentCheckoutPath),
        repoKey,
        repoRoot: resolve(repoRoot),
      },
    };
  }

  type QueueAction = "enqueue" | "dequeue" | "list" | "update";

  async function queueOperation(
    cwd: string,
    action: QueueAction,
    input: {
      objective?: string;
      files?: string[];
      after?: string[];
      notes?: string;
      queueItemId?: string;
      state?: QueueItemState;
      evidence?: string;
      reason?: string;
    },
  ): Promise<unknown> {
    const rootScope = requireRootManifestExecutor(cwd);
    if (action === "enqueue") {
      const objective = input.objective?.trim();
      if (!objective) throw new Error("objective is required to enqueue a queue item.");
      const files = [...new Set(
        (input.files ?? []).map((file) => file.trim()).filter(Boolean),
      )];
      if (input.files?.some((file) => typeof file !== "string" || !file.trim()))
        throw new Error("files must contain only non-empty strings.");
      const after = [...new Set((input.after ?? []).map((item) => item.trim()))];
      if (after.some((item) => !item))
        throw new Error("after must contain only queue item IDs.");
      const notes = input.notes?.trim();
      const release = await acquireManifestLock(cwd, 10_000);
      try {
        const manifest = await loadManifest(cwd);
        const queue = queueForManifest(manifest, true)!;
        const useRootQueues =
          Boolean(manifest.rootQueues) || manifestRootCandidates(cwd).length > 1;
        const owned = useRootQueues
          ? ensureRootQueueRecord(manifest, cwd, rootScope)
          : undefined;
        const visibleIds = owned
          ? new Set(owned.itemIds)
          : new Set(queue.items.map((item) => item.id));
        const timestamp = now();
        const objectiveHash = createHash("sha256").update(objective).digest("hex");
        const duplicate = queue.items.find(
          (item) =>
            visibleIds.has(item.id) &&
            createHash("sha256").update(item.objective).digest("hex") === objectiveHash &&
            Date.parse(timestamp) - Date.parse(item.createdAt) <= QUEUE_DEDUPE_WINDOW_MS &&
            Date.parse(timestamp) >= Date.parse(item.createdAt),
        );
        if (duplicate) {
          if (owned) await saveManifest(cwd, manifest);
          return { queueItem: duplicate, deduplicated: true, queue };
        }
        for (const dependency of after)
          if (!visibleIds.has(dependency))
            throw new Error(`Queue item after dependency is unknown: ${dependency}.`);
        const item: QueueItem = {
          version: QUEUE_SCHEMA_VERSION,
          id: `queue-${randomUUID().slice(0, 8)}`,
          objective,
          ...(notes ? { notes } : {}),
          files,
          after,
          state: "pending",
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        queue.items.push(item);
        if (owned) owned.itemIds.push(item.id);
        await saveManifest(cwd, manifest);
        return { queueItem: item, deduplicated: false, queue };
      } finally {
        await release();
      }
    }
    if (action === "update") {
      const id = input.queueItemId?.trim();
      if (!id) throw new Error("queueItemId is required to update a queue item.");
      if (!input.state || !QUEUE_ITEM_STATES.includes(input.state))
        throw new Error("state must be verified, landed, or dropped.");
      if (!["verified", "landed", "dropped"].includes(input.state))
        throw new Error("state must be verified, landed, or dropped.");
      const evidence = (input.evidence ?? input.reason)?.trim();
      if (!evidence) throw new Error("evidence is required for a queue update.");
      const release = await acquireManifestLock(cwd, 10_000);
      try {
        const manifest = await loadManifest(cwd);
        const queue = queueForManifest(manifest);
        if (!queue) throw new Error("No queue is registered.");
        const useRootQueues =
          Boolean(manifest.rootQueues) || manifestRootCandidates(cwd).length > 1;
        const owned = useRootQueues
          ? ensureRootQueueRecord(manifest, cwd, rootScope)
          : undefined;
        const visibleIds = owned
          ? new Set(owned.itemIds)
          : new Set(queue.items.map((item) => item.id));
        const item = queue.items.find(
          (candidate) => candidate.id === id && visibleIds.has(candidate.id),
        );
        if (!item) throw new Error(`Unknown queue item: ${id}.`);
        const allowed: Record<QueueItemState, QueueItemState[]> = {
          pending: ["verified", "dropped"],
          dispatched: ["verified", "dropped"],
          verified: ["landed", "dropped"],
          landed: ["landed"],
          dropped: ["dropped"],
        };
        if (!allowed[item.state].includes(input.state))
          throw new Error(`Queue item ${id} cannot move from ${item.state} to ${input.state}.`);
        const changed = item.state !== input.state || item.evidence !== evidence;
        if (changed) {
          item.state = input.state;
          item.evidence = evidence;
          item.updatedAt = now();
          await saveManifest(cwd, manifest);
        }
        return { queueItem: item, changed, queue };
      } finally {
        await release();
      }
    }
    const manifest = await loadManifest(cwd);
    const queue = queueForManifest(manifest) ?? {
      version: QUEUE_SCHEMA_VERSION,
      items: [],
    };
    const visibleIds = queueItemIdsForRoot(manifest, cwd, rootScope);
    const visibleItems = queue.items.filter((item) => visibleIds.has(item.id));
    const readiness = queueHead(manifest, cwd, visibleIds);
    const blockersByItem = Object.fromEntries(
      visibleItems
        .filter((item) => item.state === "pending")
        .map((item) => [
          item.id,
          queueReadiness(manifest, item, cwd, visibleIds).blockers,
        ]),
    );
    if (action === "dequeue")
      return {
        item: readiness.blockers.dependencies.length || readiness.blockers.files.length
          ? undefined
          : readiness.item,
        head: readiness.item,
        blockers: readiness.blockers,
        blockersByItem,
        queue,
      };
    return {
      items: visibleItems,
      queue,
      head: readiness.item,
      blockers: readiness.blockers,
      blockersByItem,
    };
  }

  async function plan(
    cwd: string,
    objectiveInput: string | undefined,
    laneObjectives: LaneInput[],
    worktreeCwd?: string,
    authorizationPolicyInput?: unknown,
    agentKindInput?: unknown,
    launchProfileInput?: unknown,
    queueItemId?: string,
    taskProfileInput?: unknown,
    ctx?: ExtensionContext,
  ): Promise<Workflow> {
    let objective = objectiveInput?.trim() ?? "";
    let linkedQueueItem: QueueItem | undefined;
    let rootScope: CurrentRootScope | undefined;
    if (queueItemId) {
      rootScope = requireRootManifestExecutor(cwd);
      const manifest = await loadManifest(cwd);
      const queue = queueForManifest(manifest);
      if (!queue) throw new Error("No queue is registered.");
      const visibleIds = queueItemIdsForRoot(manifest, cwd, rootScope);
      linkedQueueItem = queue.items.find(
        (item) => item.id === queueItemId && visibleIds.has(item.id),
      );
      if (!linkedQueueItem) throw new Error(`Unknown queue item: ${queueItemId}.`);
      if (linkedQueueItem.state !== "pending")
        throw new Error(`Queue item ${queueItemId} is ${linkedQueueItem.state}, not pending.`);
      const readiness = queueReadiness(
        manifest,
        linkedQueueItem,
        cwd,
        visibleIds,
      );
      if (readiness.blockers.dependencies.length || readiness.blockers.files.length)
        throw new Error(
          `Queue item ${queueItemId} is blocked: ${queueBlockerText(readiness.blockers)}.`,
        );
      objective = linkedQueueItem.objective;
    }
    if (!objective) throw new Error("objective is required to plan a workflow.");
    const target = await plannedCwd(cwd, worktreeCwd);
    const taskProfile =
      taskProfileInput === undefined
        ? undefined
        : typeof taskProfileInput === "string" && taskProfileInput.trim()
          ? taskProfileInput.trim()
          : (() => {
              throw new Error("taskProfile must be a non-empty profile name.");
            })();
    const configuredProfile = taskProfile
      ? resolveTaskProfile(cwd, taskProfile)
      : undefined;
    if (taskProfile && launchProfileInput !== undefined)
      throw new Error("taskProfile and launchProfile cannot both be supplied.");
    if (
      configuredProfile?.agentKind &&
      agentKindInput !== undefined &&
      configuredProfile.agentKind !== agentKindInput
    )
      throw new Error(`Task profile ${taskProfile} requires agentKind ${configuredProfile.agentKind}.`);
    const agentKind = validateAgentKind(
      agentKindInput ?? configuredProfile?.agentKind ?? "pi",
    );
    const authorizationPolicy =
      authorizationPolicyInput === undefined
        ? undefined
        : validateAuthorizationPolicy(authorizationPolicyInput);
    if (
      authorizationPolicy &&
      !new RegExp(`\\b${BB029_AUTHORIZATION_SCOPE}\\b`, "i").test(objective)
    )
      throw new Error(
        `authorizationPolicy.scope.workflow requires an objective containing ${BB029_AUTHORIZATION_SCOPE}.`,
      );
    const id = `herdr-${randomUUID().slice(0, 8)}`;
    const rootGoalId = `goal-${id}`;
    const lanes = normalizedLanes(
      objective,
      laneObjectives,
      agentKind,
      id,
      rootGoalId,
      configuredProfile?.readOnly === true,
      (name) => resolveTaskProfile(cwd, name),
    );
    if (
      target.worktree &&
      lanes.length > 1 &&
      lanes.some((lane) => !lane.readOnly)
    )
      throw new Error(
        "A worktree workflow may use multiple lanes only when every lane declares readOnly: true.",
      );
    const worktreeBinding = target.worktree
      ? await inspectWorktreeForWorkspace(target.worktree)
      : undefined;
    requireRootGoalExecutor();
    const root = await currentPaneRoot();
    rootScope ??= currentRootScope(cwd);
    if (!rootScope)
      throw new Error("The verified controller-mapped root does not own this workflow manifest.");
    const rootAgent = responseRecord(
      await runHerdr(["agent", "get", root.pane_id]),
      "task root",
    ).agent;
    if (
      !isRecord(rootAgent) ||
      !isRecord(rootAgent.agent_session) ||
      (rootAgent.agent_session.kind !== "path" &&
        rootAgent.agent_session.kind !== "id") ||
      typeof rootAgent.agent_session.value !== "string"
    )
      throw new Error(
        "Task planning requires a verified native root session path or id.",
      );
    if (rootAgent.agent === "pi" && !ctx) throw new Error("Native Pi context is required for planning.");
    const rootSessionPath = rootAgent.agent === "pi"
      ? (await inspectPiRootIdentity(ctx!)).sessionPath
      : rootAgent.agent_session.value;
    const launchProfile =
      configuredProfile?.launchProfile ??
      (launchProfileInput === undefined
        ? undefined
        : validateLaunchProfile(launchProfileInput));
    const stamp = now();
    const goals = createWorkflowGoals(id, objective, lanes);
    const workflow: Workflow = {
      id,
      objective,
      outcome: "planned",
      status: "planned",
      lanes,
      herdr: {},
      agent: {},
      agentKind,
      cwd: target.cwd,
      worktree: target.worktree,
      worktreeBinding,
      taskBinding: {
        workspaceId: root.workspace_id,
        rootPaneId: root.pane_id,
        rootSessionPath,
      },
      ...(taskProfile ? { taskProfile } : {}),
      launchProfile,
      ...(launchProfile
        ? { launchProfileVersion: LAUNCH_PROFILE_SCHEMA_VERSION }
        : {}),
      goalSchemaVersion: SCOPED_GOALS_SCHEMA_VERSION,
      rootGoalId: goals.rootGoalId,
      goals: goals.goals,
      evidence: [],
      ownership: { createdBy: OWNER, tabIds: [], paneIds: [] },
      authorizationPolicy,
      approvalRequests: [],
      questionRequests: [],
      createdAt: stamp,
      updatedAt: stamp,
    };
    if (linkedQueueItem) {
      const linked = workflow as Workflow & { queueItemId?: string; notes?: string };
      linked.queueItemId = linkedQueueItem.id;
      if (linkedQueueItem.notes) linked.notes = linkedQueueItem.notes;
      workflow.evidence.push({
        at: now(),
        kind: "queue-item-linked",
        text: `Planned from queue item ${linkedQueueItem.id}.`,
      });
    }
    if (authorizationPolicy)
      workflow.evidence.push({
        at: now(),
        kind: "authorization-policy-installed",
        text: `Validated ${authorizationPolicy.scope.workflow} local-only policy: ${authorizationPolicy.capabilities.join(",")}`,
      });
    if (worktreeBinding)
      workflow.evidence.push({
        at: now(),
        kind: "worktree-parent-resolved",
        text: jsonText(worktreeBinding),
      });
    const release = await acquireManifestLock(cwd, 10_000);
    try {
      const manifest = await loadManifest(cwd);
      if (linkedQueueItem) {
        const queue = queueForManifest(manifest);
        const visibleIds = queue
          ? queueItemIdsForRoot(manifest, cwd, rootScope!)
          : new Set<string>();
        const item = queue?.items.find(
          (candidate) =>
            candidate.id === linkedQueueItem!.id && visibleIds.has(candidate.id),
        );
        if (!item) throw new Error(`Queue item ${linkedQueueItem.id} disappeared before planning.`);
        if (item.state !== "pending")
          throw new Error(`Queue item ${item.id} is ${item.state}, not pending.`);
        const readiness = queueReadiness(manifest, item, cwd, visibleIds);
        if (readiness.blockers.dependencies.length || readiness.blockers.files.length)
          throw new Error(
            `Queue item ${item.id} became blocked: ${queueBlockerText(readiness.blockers)}.`,
          );
        item.state = "dispatched";
        item.workflowId = workflow.id;
        item.updatedAt = now();
      }
      manifest.workflows.push(workflow);
      await saveManifest(cwd, manifest);
    } finally {
      await release();
    }
    return workflow;
  }

  async function dispatch(
    cwd: string,
    id: string,
    execute: boolean,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    restart = false,
    confirm = false,
  ): Promise<{
    workflow: Workflow;
    dryRun?: boolean;
    cancelled?: boolean;
    dispatched?: boolean;
    parentApprovalRequired?: boolean;
    approvalRequest?: ApprovalRequest;
    commands?: string[];
  }> {
    const manifest = await loadManifest(cwd);
    const workflow = workflowFor(manifest, id);
    if (execute && !isRootOrchestrator()) {
      const release = await acquireManifestLock(cwd, 10_000);
      try {
        const current = await loadManifest(cwd);
        const stored = workflowFor(current, id);
        const approvalRequest = requestParentApproval(stored, "dispatch");
        await saveManifest(cwd, current);
        return {
          parentApprovalRequired: true,
          approvalRequest,
          workflow: stored,
        };
      } finally {
        await release();
      }
    }
    const adapters = new HarnessAdapterRegistry();
    adapters.register(
      piLaunchAdapter(
        ctx,
        join(homedir(), ".pi/agent/extensions/herdr-agent-state.ts"),
      ),
    );
    adapters.register(
      claudeLaunchAdapter({
        bridge: fileURLToPath(new URL("./mcp-server.mjs", import.meta.url)),
        attestHelper: fileURLToPath(
          new URL("./claude-startup-attest.mjs", import.meta.url),
        ),
        scratchDirectory: dirname(manifestPath(cwd)),
      }),
    );
    adapters.register(
      codexLaunchAdapter({
        bridge: fileURLToPath(new URL("./mcp-server.mjs", import.meta.url)),
        attestHelper: fileURLToPath(
          new URL("./codex-startup-attest.mjs", import.meta.url),
        ),
        sessionRoot: join(homedir(), ".codex", "sessions"),
      }),
    );
    adapters.register(
      opencodeLaunchAdapter({
        scratchDirectory: dirname(manifestPath(cwd)),
      }),
    );
    const briefLeases = new Map<string, Lease[]>();
    return dispatchTask(
      workflow,
      execute,
      {
        directory: dirname(manifestPath(cwd)),
        source: fileURLToPath(import.meta.url),
        adapter: (kind) => adapters.resolve(kind),
        run: runHerdr,
        contract: (w, lane) =>
          contractWithLeases(w, lane, briefLeases.get(lane.id)),
        async update(workflowId, mutate) {
          const release = await acquireManifestLock(cwd, 10_000);
          try {
            const current = await loadManifest(cwd);
            const stored = workflowFor(current, workflowId);
            mutate(stored);
            stored.updatedAt = now();
            await saveManifest(cwd, current);
            return stored;
          } finally {
            await release();
          }
        },
        async verifyRoot(w) {
          requireRootGoalExecutor();
          const root = await currentPaneRoot(signal);
          if (
            root.pane_id !== w.taskBinding?.rootPaneId ||
            root.workspace_id !== w.taskBinding.workspaceId
          )
            throw new Error(
              "Current root does not match the designated task workspace; no topology fallback allowed.",
            );
          const native = responseRecord(
            await runHerdr(["agent", "get", root.pane_id], signal),
            "task root",
          ).agent;
          if (!(await rootSessionMatches(native, w.taskBinding.rootSessionPath, ctx, signal)))
            throw new Error(
              "Root incarnation changed; authorized task recovery is required before dispatch.",
            );
        },
        async authorize(w) {
          const operation = w.retry ? "retry" : "dispatch";
          if (authorizationDecision(w, operation).allowed) return true;
          const standing = await standingAuthorization(
            cwd,
            w,
            operation,
            ctx,
            `dispatch ${w.id}`,
            signal,
          );
          await persistStanding(cwd, w.id, standing);
          const approved =
            standing.granted ||
            (await confirmExecution(
              ctx,
              `Dispatch ${w.id} in task workspace ${w.taskBinding?.workspaceId}`,
              confirm,
              signal,
            ));
          if (approved)
            for (const [laneId, leases] of await allocateDispatchLeases(cwd, w))
              briefLeases.set(laneId, leases);
          return approved;
        },
        async register(w, options) {
          const configPath = await controllerConfigPath(signal);
          const lockPath = `${configPath}.lock`;
          await mkdir(lockPath, { mode: 0o700 });
          try {
            const config = await loadControllerConfig(configPath);
            const root = await currentPaneRoot(signal);
            const record = config && findControllerRecord(config, root, cwd);
            if (!record)
              throw new Error(
                "Task root routing must be registered before launch.",
              );
            const mapping: ControllerWorkflowMapping = {
              workflow_id: w.id,
              manifest_path: resolve(manifestPath(cwd)),
              pi_goal_pause_detection: false,
              lanes: w.lanes.map((lane) => ({
                lane_id: lane.id,
                target: lane.paneId!,
                target_kind: "pane_id",
                pane_id: lane.paneId!,
                workspace_id: w.taskBinding!.workspaceId,
                relationship_id: lane.relationshipId,
              })),
            };
            const previous = record.workflows.find(
              (item) => item.workflow_id === w.id,
            );
            if (previous && !sameControllerWorkflow(previous, mapping)) {
              if (!options?.allowLaneRebind)
                throw new Error(
                  "Recorded lane route differs; authorized recovery is required.",
                );
              record.workflows = record.workflows.map((item) =>
                item.workflow_id === w.id ? mapping : item,
              );
            }
            if (!previous) record.workflows.push(mapping);
            await saveControllerConfig(configPath, config!);
          } finally {
            await rm(lockPath, { recursive: true, force: true });
          }
        },
      },
      signal,
      { restart },
    );
  }

  async function observe(cwd: string, id: string, signal?: AbortSignal) {
    // This snapshot drives which lanes to poll and their native identity; it
    // is never itself written back. Every field this function persists is
    // reconciled against a freshly reloaded manifest in the single
    // transaction below, so a concurrent writer (a pause, a completion
    // receipt, an approval) can never be silently overwritten by observation
    // results gathered while these unlocked terminal/network calls ran.
    const snapshot = workflowFor(await loadManifest(cwd), id);
    // Retired/gone lanes remain observable through their durable session log;
    // there may be no live Herdr agent left to query.
    requireHerdr();

    const observations: Array<{
      lane: string;
      state: string;
      agent: unknown;
      output: string;
      pausedGoalIds: string[];
    }> = [];
    const laneUpdates: Array<{
      id: string;
      fields: Partial<Lane>;
      nativeState: string;
      newEvidence?: { at: string; kind: "goal-paused"; text: string };
    }> = [];
    let primaryLaneUpdate:
      | {
          agent: { sessionPath?: string; sessionId?: string };
          pi?: { sessionPath?: string; sessionId?: string };
        }
      | undefined;
    for (const [index, lane] of snapshot.lanes.entries()) {
      if (!lane.agentName) continue;
      let agent: unknown = null;
      let output = "";
      let state = "unknown";
      try {
        agent = await runHerdr(["agent", "get", lane.agentName], signal);
        output = clip(
          await runHerdrRaw(
            [
              "agent",
              "read",
              lane.agentName,
              "--source",
              "recent-unwrapped",
              "--lines",
              String(RECENT_AGENT_OUTPUT_LINES),
            ],
            signal,
          ),
          GOAL_PAUSE_OUTPUT_LIMIT,
        );
        state = deepState(agent) ?? "unknown";
      } catch (error) {
        if (!goneAgentError(error)) throw error;
        // A retired tab/worktree is expected to be unavailable. Its durable
        // session identity is still reported and is marked gone unless the
        // lane was already explicitly retired.
        state = "gone";
      }
      const agentKind = laneAgentKind(snapshot, lane);
      const agentSessionPath = deepString(agent, [
        "agent_session_path",
        "session_path",
        "value",
      ]);
      const agentSessionId = deepString(agent, [
        "agent_session_id",
        "session_id",
      ]);
      // /goal-resume is a Pi protocol, not a generic agent command.
      const detectedGoalIds = agentKind === "pi" ? pausedGoalIds(output) : [];
      const previousPause = lane.goalPaused;
      const unchangedPause =
        previousPause &&
        JSON.stringify(previousPause.goalIds) ===
          JSON.stringify(detectedGoalIds) &&
        previousPause.output === output;
      const goalPaused = detectedGoalIds.length
        ? unchangedPause
          ? previousPause
          : {
              status: "goal-paused" as const,
              goalIds: detectedGoalIds,
              detectedAt: now(),
              source: "herdr agent read recent-unwrapped" as const,
              output,
            }
        : undefined;
      const fields: Partial<Lane> = {
        agentKind,
        status: goalPaused ? "goal-paused" : state,
        herdrState: state,
        agentSessionPath,
        agentSessionId,
        ...(agentKind === "pi"
          ? { piSessionPath: agentSessionPath, piSessionId: agentSessionId }
          : {}),
        ...(goalPaused ? { goalPaused } : {}),
      };
      laneUpdates.push({
        id: lane.id,
        fields,
        nativeState: state,
        ...(goalPaused && !unchangedPause
          ? {
              newEvidence: {
                at: now(),
                kind: "goal-paused",
                text: `Lane ${lane.id} (${lane.agentName}) paused ${goalPaused.goalIds.join(", ")} from bounded recent agent output:\n${output}`,
              },
            }
          : {}),
      });
      if (index === 0 && agent) {
        primaryLaneUpdate = {
          agent: { sessionPath: agentSessionPath, sessionId: agentSessionId },
          ...(agentKind === "pi"
            ? {
                pi: {
                  sessionPath: agentSessionPath,
                  sessionId: agentSessionId,
                },
              }
            : {}),
        };
      }
      observations.push({
        lane: lane.id,
        state,
        agent,
        output,
        pausedGoalIds: detectedGoalIds,
      });
    }

    const states = observations.map((item) => item.state);
    const hasPausedGoal = observations.some(
      (item) => item.pausedGoalIds.length > 0,
    );
    const allNativeAgentsSettled =
      states.length > 0 && states.every((state) => state === "done");
    const observedStatus = hasPausedGoal
      ? "goal-paused"
      : states.includes("blocked")
        ? "blocked"
        : states.includes("working")
          ? "running"
          : allNativeAgentsSettled
            ? "awaiting-explicit-outcome"
            : "unknown";
    const observationEvidenceText = clip(jsonText(observations), 6000);

    const observedWorkflow = await withManifestTransaction(cwd, (current) => {
      const stored = workflowFor(current, id);
      for (const update of laneUpdates) {
        const index = stored.lanes.findIndex((lane) => lane.id === update.id);
        // A lane removed by a concurrent writer has nothing left to update.
        if (index === -1) continue;
        stored.lanes[index] = { ...stored.lanes[index], ...update.fields };
        syncLaneSessionLog(stored, stored.lanes[index], update.nativeState);
        if (update.newEvidence) stored.evidence.push(update.newEvidence);
      }
      // Controller events may have landed after the unlocked native reads;
      // derive activity from the freshly reloaded ledger for every lane.
      for (const lane of stored.lanes) syncLaneSessionLog(stored, lane);
      if (primaryLaneUpdate) {
        stored.agent = primaryLaneUpdate.agent;
        if (primaryLaneUpdate.pi) stored.pi = primaryLaneUpdate.pi;
      }
      const explicitlyCompleted = workflowHasExplicitSuccess(stored);
      if (observations.length > 0) {
        const retryableDispatchFailure =
          !explicitlyCompleted &&
          stored.retry?.state === "retryable" &&
          (stored.status === "dispatch-failed" || stored.status === "unknown") &&
          observedStatus === "unknown";
        // Herdr's idle/unknown snapshot is telemetry, not a replacement for a
        // durable dispatch failure. Preserve the retryable state so the
        // manifest's own retryCommand remains executable after observe().
        stored.status = explicitlyCompleted
          ? "completed"
          : retryableDispatchFailure
            ? "dispatch-failed"
            : observedStatus;
        stored.outcome = explicitlyCompleted ? "completed" : "unknown";
      }
      stored.observedAt = now();
      stored.updatedAt = now();
      stored.evidence.push({
        at: now(),
        kind: "agent-observation",
        text: observationEvidenceText,
      });
      return stored;
    });
    // Explicit root observation is the bounded recovery path for a completed
    // dispatch whose controller registration was deferred before the plugin
    // config became available. It never dispatches or enables a plugin.
    if (
      isRootOrchestrator() &&
      observedWorkflow.eventControllerRegistration?.status === "pending"
    )
      await registerEventController(cwd, id, signal);
    const currentManifest = await loadManifest(cwd);
    const workflow = workflowFor(currentManifest, id);
    const nowMs = Date.now();
    const messages = (workflow.messageRequests ?? []).filter((message) => {
      const at = Date.parse(message.requestedAt);
      return (
        message.delivery.status !== "delivered" ||
        (Number.isFinite(at) && nowMs - at <= RECENT_MESSAGE_WINDOW_MS)
      );
    });
    return {
      workflow,
      state: workflow.status,
      observations,
      messages,
      // This is scoped to the manifest owned by the current root. It includes
      // the root trace plus every workflow lane, including retired lanes.
      sessionLog: sessionLogEntries(
        currentManifest,
        currentRootScope(cwd)?.rootId,
      ),
    };
  }

  async function resumeNativeSessions(
    cwd: string,
    id: string,
    execute: boolean,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) {
    const manifest = await loadManifest(cwd);
    const workflow = workflowFor(manifest, id);
    if (execute) requireHerdr();
    if (execute && !isRootOrchestrator()) {
      const release = await acquireManifestLock(cwd, 10_000);
      try {
        const current = await loadManifest(cwd);
        const stored = workflowFor(current, id);
        const approvalRequest = requestParentApproval(stored, "resume");
        await saveManifest(cwd, current);
        return {
          parentApprovalRequired: true,
          approvalRequest,
          workflow: stored,
        };
      } finally {
        await release();
      }
    }
    if (execute && !isRootForManifest(cwd))
      throw new Error(
        "The verified controller-mapped root does not own this workflow manifest; native resume is refused.",
      );
    const adapters = new HarnessAdapterRegistry();
    adapters.register(
      piLaunchAdapter(
        ctx,
        join(homedir(), ".pi/agent/extensions/herdr-agent-state.ts"),
      ),
    );
    adapters.register(
      claudeLaunchAdapter({
        bridge: fileURLToPath(new URL("./mcp-server.mjs", import.meta.url)),
        attestHelper: fileURLToPath(
          new URL("./claude-startup-attest.mjs", import.meta.url),
        ),
        scratchDirectory: dirname(manifestPath(cwd)),
      }),
    );
    adapters.register(
      codexLaunchAdapter({
        bridge: fileURLToPath(new URL("./mcp-server.mjs", import.meta.url)),
        attestHelper: fileURLToPath(
          new URL("./codex-startup-attest.mjs", import.meta.url),
        ),
        sessionRoot: join(homedir(), ".codex", "sessions"),
      }),
    );
    adapters.register(
      opencodeLaunchAdapter({
        scratchDirectory: dirname(manifestPath(cwd)),
      }),
    );
    return resumeTask(
      workflow,
      execute,
      {
        directory: dirname(manifestPath(cwd)),
        source: fileURLToPath(import.meta.url),
        adapter: (kind) => adapters.resolve(kind),
        run: runHerdr,
        async update(workflowId, mutate) {
          const release = await acquireManifestLock(cwd, 10_000);
          try {
            const current = await loadManifest(cwd);
            const stored = workflowFor(current, workflowId);
            mutate(stored);
            stored.updatedAt = now();
            await saveManifest(cwd, current);
            return stored;
          } finally {
            await release();
          }
        },
        async verifyRoot(w) {
          requireRootGoalExecutor();
          const root = await currentPaneRoot(signal);
          if (
            root.pane_id !== w.taskBinding?.rootPaneId ||
            root.workspace_id !== w.taskBinding.workspaceId
          )
            throw new Error(
              "Current root does not match the designated task workspace; native resume cannot use a topology fallback.",
            );
          const native = responseRecord(
            await runHerdr(["agent", "get", root.pane_id], signal),
            "task root",
          ).agent;
          if (!(await rootSessionMatches(native, w.taskBinding.rootSessionPath, ctx, signal)))
            throw new Error(
              "Root incarnation changed; authorized task recovery is required before native resume.",
            );
        },
        async authorize(w) {
          const decision = authorizationDecision(w, "resume");
          if (decision.allowed) {
            if (w.worktree) await assertCleanLocalWorktree(w.worktree, signal);
            auditAuthorization(w, decision);
            return true;
          }
          auditAuthorization(w, decision);
          const standing = await standingAuthorization(
            cwd,
            w,
            "resume",
            ctx,
            `resume native sessions for ${w.id}`,
            signal,
          );
          await persistStanding(cwd, w.id, standing);
          if (standing.granted) return true;
          return confirmExecution(
            ctx,
            `Resume native sessions for ${w.id}`,
            false,
            signal,
          );
        },
        async register(w, options) {
          const configPath = await controllerConfigPath(signal);
          const lockPath = `${configPath}.lock`;
          await mkdir(lockPath, { mode: 0o700 });
          try {
            const config = await loadControllerConfig(configPath);
            const root = await currentPaneRoot(signal);
            const record = config && findControllerRecord(config, root, cwd);
            if (!record)
              throw new Error(
                "Task root routing must be registered before native resume.",
              );
            const mapping: ControllerWorkflowMapping = {
              workflow_id: w.id,
              manifest_path: resolve(manifestPath(cwd)),
              pi_goal_pause_detection: false,
              lanes: w.lanes.map((lane) => ({
                lane_id: lane.id,
                target: lane.paneId!,
                target_kind: "pane_id",
                pane_id: lane.paneId!,
                workspace_id: w.taskBinding!.workspaceId,
                relationship_id: lane.relationshipId,
              })),
            };
            const previous = record.workflows.find(
              (item) => item.workflow_id === w.id,
            );
            if (previous && !sameControllerWorkflow(previous, mapping)) {
              if (!options?.allowLaneRebind)
                throw new Error(
                  "Recorded lane route differs; authorized native recovery is required.",
                );
              record.workflows = record.workflows.map((item) =>
                item.workflow_id === w.id ? mapping : item,
              );
            }
            if (!previous) record.workflows.push(mapping);
            await saveControllerConfig(configPath, config!);
          } finally {
            await rm(lockPath, { recursive: true, force: true });
          }
        },
      },
      signal,
    );
  }

  async function resume(
    cwd: string,
    id: string,
    execute: boolean,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) {
    const manifest = await loadManifest(cwd);
    const workflow = workflowFor(manifest, id);
    const pausedLanes = workflow.lanes
      .map((lane, index) => ({ lane, index }))
      .filter(
        ({ lane }) =>
          laneAgentKind(workflow, lane) === "pi" &&
          lane.status === "goal-paused" &&
          Boolean(lane.agentName),
      );
    // `/goal-resume` remains the Pi goal protocol. Every other recovery uses
    // the durable session log and the selected adapter's native invocation.
    if (pausedLanes.length === 0)
      return resumeNativeSessions(cwd, id, execute, ctx, signal);
    if (!execute)
      return {
        dryRun: true,
        workflow,
        pausedLanes: pausedLanes.map(({ lane }) => ({
          laneId: lane.id,
          agentName: lane.agentName,
          goalIds: lane.goalPaused?.goalIds ?? [],
        })),
        commands: pausedLanes.map(
          ({ lane }) => `herdr agent prompt ${lane.agentName} /goal-resume`,
        ),
      };
    requireHerdr();
    if (!isRootOrchestrator()) {
      const approvalRequest = requestParentApproval(workflow, "resume");
      workflow.updatedAt = now();
      await saveManifest(cwd, manifest);
      return { parentApprovalRequired: true, approvalRequest, workflow };
    }
    if (pausedLanes.length === 0)
      throw new Error(
        `Workflow ${id} has no currently observed paused goals; run herdr_observe before herdr_resume.`,
      );
    const decision = authorizationDecision(workflow, "resume");
    if (decision.allowed) {
      try {
        if (workflow.worktree)
          await assertCleanLocalWorktree(workflow.worktree, signal);
      } catch (error) {
        const denied: AuthorizationDecision = {
          ...decision,
          allowed: false,
          reason: `preauthorization denied: ${(error as Error).message}`,
        };
        auditAuthorization(workflow, denied);
        workflow.updatedAt = now();
        await saveManifest(cwd, manifest);
        throw error;
      }
      auditAuthorization(workflow, decision);
      resolveParentApproval(workflow, "resume", "approved");
      workflow.updatedAt = now();
      await saveManifest(cwd, manifest);
    } else {
      auditAuthorization(workflow, decision);
      const standing = await standingAuthorization(
        cwd,
        workflow,
        "resume",
        ctx,
        `resume paused Pi goals for ${id}`,
        signal,
      );
      applyStanding(manifest, workflow, standing);
      workflow.updatedAt = now();
      await saveManifest(cwd, manifest);
      const approved =
        standing.granted ||
        (await confirmExecution(
          ctx,
          `Resume paused Pi goals for ${id}`,
          false,
          signal,
        ));
      resolveParentApproval(
        workflow,
        "resume",
        approved ? "approved" : "cancelled",
      );
      workflow.updatedAt = now();
      await saveManifest(cwd, manifest);
      if (!approved) return { cancelled: true, workflow };
    }

    const receipts: Array<{
      laneId: string;
      agentName: string;
      receipt: string;
    }> = [];
    try {
      for (const { lane, index } of pausedLanes) {
        const agentName = lane.agentName;
        if (!agentName) continue;
        const receipt = clip(
          jsonText(
            await runHerdr(
              ["agent", "prompt", agentName, "/goal-resume"],
              signal,
            ),
          ),
          6000,
        );
        const record: GoalResumeReceipt = {
          command: "/goal-resume",
          requestedAt: now(),
          receipt,
        };
        workflow.lanes[index] = {
          ...lane,
          status: "goal-resume-requested",
          goalResumeReceipts: [...(lane.goalResumeReceipts ?? []), record],
        };
        workflow.status = "goal-resume-requested";
        workflow.outcome = "unknown";
        workflow.updatedAt = now();
        workflow.evidence.push({
          at: now(),
          kind: "goal-resume-receipt",
          text: `Lane ${lane.id} (${agentName}) accepted /goal-resume:\n${receipt}`,
        });
        await saveManifest(cwd, manifest);
        receipts.push({ laneId: lane.id, agentName, receipt });
      }
    } catch (error) {
      const message = (error as Error).message;
      workflow.status = "goal-resume-failed";
      workflow.outcome = "unknown";
      workflow.updatedAt = now();
      workflow.evidence.push({
        at: now(),
        kind: "goal-resume-error",
        text: message,
      });
      await saveManifest(cwd, manifest);
      throw error;
    }
    return { resumed: true, receipts, workflow };
  }

  async function complete(
    cwd: string,
    id: string,
    summary: string,
    signal?: AbortSignal,
  ) {
    requireHerdr();
    const assignment = currentChildAssignment();
    if (assignment.workflow.workflow_id !== id)
      throw new Error("Completion is outside this participant's assignment.");
    cwd = assignment.cwd;
    const initial = workflowFor(await loadManifest(cwd), id);
    const lane = initial.lanes.find(
      (item) => item.id === assignment.lane.lane_id,
    )!;
    const raw = await runHerdr(
      ["agent", "get", assignment.lane.pane_id],
      signal,
    );
    const child = liveAgentIdentity(raw, "completion child identity");
    const nativeAgent = responseRecord(raw, "completion child").agent;
    const liveSession = nativeSessionFromAgent(nativeAgent);
    if (
      !lane?.relationshipId ||
      child.paneId !== lane.paneId ||
      child.workspaceId !== assignment.lane.workspace_id ||
      child.kind !== laneAgentKind(initial, lane) ||
      (lane.nativeSession
        ? !liveSession ||
          liveSession.kind !== lane.nativeSession.kind ||
          liveSession.value !== lane.nativeSession.value
        : lane.agentSessionPath
          ? liveSession?.value !== lane.agentSessionPath
          : child.name !== lane.agentName)
    )
      throw new Error(
        "Live child incarnation differs from its recorded completion authority.",
      );
    const transaction = async (
      mutate: (stored: Workflow, current: Lane) => void,
    ) => {
      const release = await acquireManifestLock(cwd, 10_000);
      try {
        const manifest = await loadManifest(cwd);
        const stored = workflowFor(manifest, id);
        const current = stored.lanes.find((item) => item.id === lane.id)!;
        if (
          !current ||
          (lane.nativeSession
            ? !current.nativeSession ||
              current.nativeSession.kind !== lane.nativeSession.kind ||
              current.nativeSession.value !== lane.nativeSession.value
            : current.agentSessionPath !== lane.agentSessionPath) ||
          current.relationshipId !== lane.relationshipId
        )
          throw new Error(
            "Completion writer was fenced by a changed incarnation.",
          );
        mutate(stored, current);
        await saveManifest(cwd, manifest);
        return stored;
      } finally {
        await release();
      }
    };
    let workflow = await transaction((stored, current) => {
      if (current.completionReceipt) {
        if (current.completionReceipt.summary !== summary)
          throw new Error(
            "Completion operation already exists with a different summary.",
          );
        return;
      }
      current.completionReceipt = {
        id: current.incarnationId ?? current.relationshipId!,
        summary,
        delivery: "pending",
      };
      current.status = "completion-reported";
      syncLaneSessionLog(stored, current);
      updateLaneGoal(stored, current, "completed", "success");
      stored.status = workflowHasExplicitSuccess(stored)
        ? "completed"
        : "completion-reported";
      stored.outcome = workflowHasExplicitSuccess(stored)
        ? "completed"
        : "unknown";
      stored.evidence.push({
        at: now(),
        kind: "child-completion-receipt",
        text: `${current.relationshipId}: ${clip(summary, 2000)}`,
      });
    });
    let delivery = workflow.lanes.find((item) => item.id === lane.id)!
      .completionReceipt!.delivery;
    const result = () => ({
      stored: true,
      delivered: delivery === "delivered",
      delivery,
      workflow,
      relationshipId: lane.relationshipId,
      incarnationId: lane.incarnationId,
    });
    if (delivery !== "pending") return result();
    const rootBinding = assignment.record.root;
    let rootRaw;
    try {
      rootRaw = await runHerdr(["agent", "get", rootBinding.pane_id], signal);
    } catch {
      return result();
    }
    const root = liveAgentIdentity(rootRaw, "completion root identity");
    if (
      root.paneId !== rootBinding.pane_id ||
      root.workspaceId !== rootBinding.workspace_id ||
      !["idle", "done"].includes(deepState(rootRaw) ?? "unknown")
    )
      return result();
    let claimed = false;
    workflow = await transaction((_stored, current) => {
      if (current.completionReceipt!.delivery === "pending") {
        current.completionReceipt!.delivery = "sending";
        claimed = true;
      }
    });
    if (!claimed) {
      delivery = workflow.lanes.find((item) => item.id === lane.id)!
        .completionReceipt!.delivery;
      return result();
    }
    try {
      await runHerdr(
        [
          "agent",
          "prompt",
          rootBinding.pane_id,
          `[Herdr completion receipt] ${lane.relationshipId}: ${id}/${lane.id} reports complete. ${clip(summary, 2000)}`,
        ],
        signal,
      );
      delivery = "delivered";
    } catch {
      delivery = "uncertain";
    }
    workflow = await transaction((_stored, current) => {
      current.completionReceipt!.delivery = delivery;
    });
    return result();
  }

  async function operatorClose(
    cwd: string,
    id: string,
    laneId: string,
    who: string,
    why: string,
    evidence: string[],
  ) {
    requireRootOperator();
    const normalizedLaneId = laneId.trim();
    const normalizedWho = who.trim();
    const normalizedWhy = why.trim();
    const normalizedEvidence = evidence
      .map((item) => item.trim())
      .filter(Boolean);
    if (!normalizedLaneId)
      throw new Error("operator closure requires a laneId.");
    if (!normalizedWho)
      throw new Error("operator closure requires who.");
    if (!normalizedWhy)
      throw new Error("operator closure requires why.");
    if (normalizedEvidence.length === 0)
      throw new Error("operator closure requires at least one evidence item.");

    const workflow = await withManifestTransaction(cwd, (manifest) => {
      const stored = workflowFor(manifest, id);
      const requested = {
        laneId: normalizedLaneId,
        who: normalizedWho,
        why: normalizedWhy,
        evidence: normalizedEvidence,
      };
      if (stored.operatorClosure) {
        const existing = stored.operatorClosure;
        const sameLane = existing.laneId === requested.laneId;
        if (
          sameLane &&
          (existing.who !== requested.who ||
            existing.why !== requested.why ||
            JSON.stringify(existing.evidence) !== JSON.stringify(requested.evidence))
        )
          throw new Error(
            "Workflow already has an operator closure with different reconciliation evidence.",
          );
        if (sameLane) return stored;
        // A different lane is reconciled separately: the workflow-level record
        // holds the latest closure and per-lane evidence accumulates below.
      }
      const lane = stored.lanes.find((item) => item.id === normalizedLaneId);
      if (!lane) throw new Error(`Unknown lane in workflow: ${normalizedLaneId}.`);
      if (lane.completionReceipt)
        throw new Error(
          "Operator closure cannot replace or duplicate an existing lane completion receipt.",
        );
      if (stored.outcome === "completed" || stored.outcome === "closed")
        throw new Error(
          "Operator closure cannot reconcile a workflow that already has a normal completion or close state.",
        );
      const timestamp = now();
      stored.operatorClosure = {
        version: 1,
        id: `operator-closure-${randomUUID().slice(0, 12)}`,
        ...requested,
        recordedAt: timestamp,
      };
      // This state is deliberately separate from completionReceipt: it says
      // an authorized operator reconciled the outcome, not that the lane
      // successfully called herdr_complete.
      lane.status = "operator-closed";
      syncLaneSessionLog(stored, lane);
      // Stamp the workflow level only when every lane is terminal: the
      // controller treats workflow-wide status/outcome as a post-completion
      // signal, and one lane's reconciliation must never suppress a still-
      // running sibling's completion wake.
      if (
        stored.lanes.every(
          (candidate) =>
            candidate.completionReceipt ||
            TERMINAL_LANE_STATUSES.has(candidate.status),
        )
      ) {
        stored.status = "operator-closed";
        stored.outcome = "operator-closed";
      }
      stored.operatorClosedAt = timestamp;
      stored.evidence.push({
        at: timestamp,
        kind: "operator-closure",
        text: JSON.stringify({
          laneId: normalizedLaneId,
          who: normalizedWho,
          why: normalizedWhy,
          evidence: normalizedEvidence,
          receipt: "not recorded; lane completion receipt was unavailable",
        }),
      });
      stored.updatedAt = timestamp;
      return stored;
    });
    return {
      operatorClosed: true,
      workflow,
      operatorClosure: workflow.operatorClosure,
      laneCompletionReceiptRecorded: false,
    };
  }

  async function reparent(
    cwd: string,
    id: string,
    execute: boolean,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) {
    const manifest = await loadManifest(cwd);
    const workflow = workflowFor(manifest, id);
    const registration = registeredControllerRegistration(cwd, workflow);
    const config = await linkedControllerConfig(registration, signal);
    const record = recordForRegistration(config, registration);
    if (
      !record ||
      record.workflows.length !== 1 ||
      !sameControllerWorkflow(record.workflows[0], registration.workflow!)
    )
      throw new Error(
        "Controller root handoff requires an isolated one-workflow orchestrator record.",
      );
    const nextRoot = await discoverControllerRoot(signal);
    if (!execute)
      return {
        dryRun: true,
        workflow,
        previousRoot: registration.root,
        nextRoot,
      };
    requireHerdr();
    if (!isRootOrchestrator())
      throw new Error(
        "Only the designated root may reparent a controller workflow.",
      );
    if (sameControllerRoot(registration.root!, nextRoot))
      return { reparented: false, unchanged: true, workflow };
    if (!(await confirmExecution(ctx, `Reparent controller root for ${id}`, false, signal)))
      return { cancelled: true, workflow };
    await saveControllerConfig(registration.configPath!, {
      ...config,
      orchestrators: config.orchestrators.map((candidate) =>
        candidate.id === record.id
          ? {
              ...candidate,
              id: controllerRecordId(nextRoot, workflow.cwd),
              root: nextRoot,
              program: {
                ...candidate.program,
                workspace_id: nextRoot.workspace_id,
              },
            }
          : candidate,
      ),
    });
    recordControllerRegistration(workflow, {
      ...registration,
      status: "registered",
      updatedAt: now(),
      root: nextRoot,
      reason: `Controller root handed off from ${registration.root!.pane_id} to ${nextRoot.pane_id}.`,
    });
    workflow.evidence.push({
      at: now(),
      kind: "controller-root-reparented",
      text: `Verified live root handoff: ${registration.root!.pane_id} -> ${nextRoot.pane_id}.`,
    });
    workflow.updatedAt = now();
    await saveManifest(cwd, manifest);
    return {
      reparented: true,
      workflow,
      previousRoot: registration.root,
      nextRoot,
    };
  }

  // A dry-run/result payload previously embedded the entire workflow record
  // verbatim. Each lane's full objective text is duplicated across the lane
  // itself and its mirrored goal record, so a handful of lanes with a normal
  // multi-hundred-character objective routinely produced tens of thousands
  // of characters, well past what any caller reading this result needs.
  // Every other field (laneRetirement, evidence, ownership, status, ...)
  // stays exactly as-is; callers rely on those.
  function workflowRetirementSummary(workflow: Workflow): Record<string, unknown> {
    return {
      ...workflow,
      objective: clip(workflow.objective, 200),
      lanes: workflow.lanes.map((lane) => ({
        ...lane,
        objective: clip(lane.objective, 200),
      })),
      goals: (workflow.goals ?? []).map((goal) => ({
        ...goal,
        objective: clip(goal.objective, 200),
      })),
    };
  }

  async function retireTaskLaneTabs(
    cwd: string,
    id: string,
    workflow: Workflow,
    evidence: string[],
    execute: boolean,
    signal?: AbortSignal,
  ) {
    const taskBinding = workflow.taskBinding;
    if (!taskBinding)
      throw new Error("Lane retirement requires a task workspace binding.");
    const normalizedEvidence = (Array.isArray(evidence) ? evidence : [])
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    if (normalizedEvidence.length === 0)
      throw new Error("Lane retirement requires at least one evidence item.");

    requireHerdr();
    if (!isRootOrchestrator())
      throw new Error(
        "Lane retirement is root-only: only the verified controller-mapped root may retire lane tabs.",
      );
    const root = await currentPaneRoot(signal);
    if (
      root.pane_id !== taskBinding.rootPaneId ||
      root.workspace_id !== taskBinding.workspaceId
    )
      throw new Error(
        "Lane retirement requires the verified controller root in the workflow's recorded task workspace; no topology fallback is allowed.",
      );

    const nonTerminal = workflow.lanes.filter(
      (lane) =>
        !lane.completionReceipt && !TERMINAL_LANE_STATUSES.has(lane.status),
    );
    if (nonTerminal.length > 0)
      throw new Error(
        `Lane retirement requires every lane to be terminal; non-terminal lane(s): ${nonTerminal
          .map((lane) => lane.id)
          .join(", ")}.`,
      );

    if (workflow.ownership.workspaceId !== taskBinding.workspaceId)
      throw new Error(
        `Lane retirement refused: recorded lane ownership workspace does not match the root's task workspace ${taskBinding.workspaceId}.`,
      );
    const rawTabIds = workflow.ownership.tabIds;
    if (!Array.isArray(rawTabIds))
      throw new Error(
        "Lane retirement refused: no recorded lane tabs belong to the root's task workspace.",
      );
    const tabIds: string[] = [];
    for (const tabId of rawTabIds) {
      if (typeof tabId !== "string" || !tabId.trim())
        throw new Error("Lane retirement refused: a recorded lane tab ID is invalid.");
      if (!tabIds.includes(tabId)) tabIds.push(tabId);
    }

    const storedRetirement = (workflow as WorkflowWithLaneRetirement)
      .laneRetirement;
    if (storedRetirement?.status === "retired")
      return {
        laneRetired: true,
        retired: true,
        alreadyRetired: true,
        workflow: workflowRetirementSummary(workflow),
        tabIds: storedRetirement.tabIds,
        closedTabIds: storedRetirement.closedTabIds,
        failedTabIds: [],
        remainingTabIds: [],
        commands: [],
        partialFailure: false,
        workspaceRetained: true,
      };
    if (storedRetirement && storedRetirement.status !== "partial")
      throw new Error("Lane retirement record has an unsupported state.");
    if (
      storedRetirement &&
      (storedRetirement.workspaceId !== taskBinding.workspaceId ||
        JSON.stringify(storedRetirement.tabIds) !== JSON.stringify(tabIds))
    )
      throw new Error(
        "Lane retirement record no longer matches the root task workspace's recorded tabs.",
      );

    const closedBefore = new Set(storedRetirement?.closedTabIds ?? []);
    const pendingTabIds = tabIds.filter((tabId) => !closedBefore.has(tabId));
    const alreadyGoneTabIds: string[] = [];
    if (pendingTabIds.length > 0) {
      const listed = responseRecord(
        await runHerdr(["tab", "list", "--workspace", taskBinding.workspaceId], signal),
        "task workspace tab list",
      );
      if (!Array.isArray(listed.tabs))
        throw new Error(
          "Herdr task workspace tab list returned no registered tabs.",
        );
      for (const tabId of pendingTabIds) {
        const tab = listed.tabs.find(
          (item: unknown): item is Record<string, unknown> =>
            isRecord(item) && item.tab_id === tabId,
        );
        if (tab && tab.workspace_id === taskBinding.workspaceId) continue;
        // Not in this workspace's tab list. A tab can be manually closed
        // outside herdr_close (e.g. `herdr tab close` run directly with the
        // user's approval); that is not an error, it already accomplished
        // the goal. Distinguish that from an ID reused by a tab that now
        // lives in a different workspace, which is a real collision risk and
        // must still refuse.
        let existsElsewhere = false;
        try {
          const got = responseRecord(
            await runHerdr(["tab", "get", tabId], signal),
            "tab lookup",
          );
          existsElsewhere = got.workspace_id !== taskBinding.workspaceId;
        } catch {
          existsElsewhere = false; // herdr has no record of this tab anywhere.
        }
        if (existsElsewhere)
          throw new Error(
            `Lane tab ${tabId} is not in the root's task workspace ${taskBinding.workspaceId}; refusing cleanup.`,
          );
        alreadyGoneTabIds.push(tabId);
      }
    }

    const closeCommandTabIds = pendingTabIds.filter(
      (tabId) => !alreadyGoneTabIds.includes(tabId),
    );
    const commands = closeCommandTabIds.map((tabId) => `herdr tab close ${tabId}`);
    if (!execute)
      return {
        dryRun: true,
        laneRetirement: true,
        retired: false,
        workflow: workflowRetirementSummary(workflow),
        tabIds: pendingTabIds,
        commands,
        workspaceRetained: true,
      };

    let currentWorkflow = await withManifestTransaction(cwd, (manifest) => {
      const stored = workflowFor(manifest, id) as WorkflowWithLaneRetirement;
      const currentRetirement = stored.laneRetirement;
      if (currentRetirement?.status === "retired") return stored;
      const currentNonTerminal = stored.lanes.filter(
        (lane) =>
          !lane.completionReceipt &&
          !TERMINAL_LANE_STATUSES.has(lane.status),
      );
      if (currentNonTerminal.length > 0)
        throw new Error(
          `Lane retirement requires every lane to be terminal; non-terminal lane(s): ${currentNonTerminal
            .map((lane) => lane.id)
            .join(", ")}.`,
        );
      if (stored.ownership.workspaceId !== taskBinding.workspaceId)
        throw new Error(
          "Lane retirement refused: recorded lane ownership workspace changed before cleanup.",
        );
      if (
        currentRetirement &&
        (currentRetirement.workspaceId !== taskBinding.workspaceId ||
          JSON.stringify(currentRetirement.tabIds) !== JSON.stringify(tabIds))
      )
        throw new Error(
          "Lane retirement record no longer matches the root task workspace's recorded tabs.",
        );
      const timestamp = now();
      const record: LaneRetirementRecord = currentRetirement ?? {
        version: 1,
        status: pendingTabIds.length === 0 ? "retired" : "partial",
        workspaceId: taskBinding.workspaceId,
        tabIds,
        closedTabIds: [],
        failedTabIds: [],
        pendingTabIds,
        requestedAt: timestamp,
        evidence: [],
      };
      for (const tabId of alreadyGoneTabIds) {
        if (record.closedTabIds.includes(tabId)) continue;
        record.closedTabIds.push(tabId);
        stored.evidence.push({
          at: timestamp,
          kind: "lane-retirement-tab-already-closed",
          text: `Lane tab ${tabId} was already closed outside herdr_close (no matching Herdr tab); accepted as closed without attempting to close it again.`,
        });
      }
      record.pendingTabIds = record.tabIds.filter(
        (tabId) => !record.closedTabIds.includes(tabId),
      );
      record.status = record.pendingTabIds.length === 0 ? "retired" : "partial";
      record.evidence.push(...normalizedEvidence);
      stored.laneRetirement = record;
      stored.evidence.push({
        at: timestamp,
        kind: currentRetirement
          ? "lane-retirement-retry"
          : "lane-retirement",
        text: JSON.stringify({
          workspaceId: taskBinding.workspaceId,
          tabIds,
          evidence: normalizedEvidence,
        }),
      });
      if (pendingTabIds.length === 0) {
        record.status = "retired";
        record.pendingTabIds = [];
        record.completedAt = timestamp;
        for (const lane of stored.lanes)
          if (lane.sessionLog)
            lane.sessionLog = { ...lane.sessionLog, status: "retired" };
        releaseWorkflowLeases(manifest, stored, "lane tabs retired");
        stored.evidence.push({
          at: timestamp,
          kind: "lane-retirement-completed",
          text: JSON.stringify({
            workspaceId: taskBinding.workspaceId,
            closedTabIds: record.closedTabIds,
            failedTabIds: record.failedTabIds,
            evidence: normalizedEvidence,
          }),
        });
      }
      stored.updatedAt = timestamp;
      return stored;
    });

    const recordAfterStart = (currentWorkflow as WorkflowWithLaneRetirement)
      .laneRetirement!;
    const attemptedTabIds = recordAfterStart.pendingTabIds.slice();
    const closeErrors: Array<{ tabId: string; error: string }> = [];
    for (const tabId of attemptedTabIds) {
      try {
        await runHerdr(["tab", "close", tabId], signal);
        currentWorkflow = await withManifestTransaction(cwd, (manifest) => {
          const stored = workflowFor(manifest, id) as WorkflowWithLaneRetirement;
          const record = stored.laneRetirement;
          if (!record) throw new Error("Lane retirement record disappeared during cleanup.");
          if (!record.closedTabIds.includes(tabId))
            record.closedTabIds.push(tabId);
          record.failedTabIds = record.failedTabIds.filter(
            (failedTabId) => failedTabId !== tabId,
          );
          record.pendingTabIds = record.tabIds.filter(
            (recordedTabId) => !record.closedTabIds.includes(recordedTabId),
          );
          const timestamp = now();
          stored.evidence.push({
            at: timestamp,
            kind: "lane-retirement-tab-closed",
            text: `Closed recorded lane tab ${tabId} in task workspace ${record.workspaceId}.`,
          });
          if (record.pendingTabIds.length === 0) {
            record.status = "retired";
            record.completedAt = timestamp;
            for (const lane of stored.lanes)
              if (lane.sessionLog)
                lane.sessionLog = { ...lane.sessionLog, status: "retired" };
            releaseWorkflowLeases(manifest, stored, "lane tabs retired");
            stored.evidence.push({
              at: timestamp,
              kind: "lane-retirement-completed",
              text: JSON.stringify({
                workspaceId: record.workspaceId,
                closedTabIds: record.closedTabIds,
                failedTabIds: record.failedTabIds,
              }),
            });
          }
          stored.updatedAt = timestamp;
          return stored;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        closeErrors.push({ tabId, error: message });
        currentWorkflow = await withManifestTransaction(cwd, (manifest) => {
          const stored = workflowFor(manifest, id) as WorkflowWithLaneRetirement;
          const record = stored.laneRetirement;
          if (!record) throw new Error("Lane retirement record disappeared during cleanup.");
          if (!record.failedTabIds.includes(tabId))
            record.failedTabIds.push(tabId);
          record.pendingTabIds = record.tabIds.filter(
            (recordedTabId) => !record.closedTabIds.includes(recordedTabId),
          );
          const timestamp = now();
          stored.evidence.push({
            at: timestamp,
            kind: "lane-retirement-tab-failed",
            text: JSON.stringify({ tabId, workspaceId: record.workspaceId, error: message }),
          });
          stored.updatedAt = timestamp;
          return stored;
        });
      }
    }
    const finalRetirement = (currentWorkflow as WorkflowWithLaneRetirement)
      .laneRetirement!;
    const remainingTabIds = finalRetirement.pendingTabIds.slice();
    let routesRetired = false;
    if (finalRetirement.status === "retired") {
      // A fully retired lane workflow has no live panes to route events for;
      // drop its controller mapping so stale routes stop probing dead panes
      // (the manifest record stays as durable history).
      const configPath = await controllerConfigPath(signal);
      const lockPath = `${configPath}.lock`;
      await mkdir(lockPath, { mode: 0o700 });
      try {
        const config = await loadControllerConfig(configPath);
        if (config) {
          let removed = false;
          const retiredManifestPath = resolve(manifestPath(cwd));
          for (const orchestrator of config.orchestrators) {
            const before = orchestrator.workflows.length;
            // Workflow IDs are root-local. Retire only the route belonging to
            // this verified root and manifest; another root may legitimately
            // use the same ID in its own isolated store.
            orchestrator.workflows = orchestrator.workflows.filter(
              (workflow) =>
                workflow.workflow_id !== id ||
                resolve(workflow.manifest_path) !== retiredManifestPath ||
                orchestrator.program.id !== resolve(cwd) ||
                orchestrator.root.pane_id !== root.pane_id ||
                orchestrator.root.workspace_id !== root.workspace_id,
            );
            if (orchestrator.workflows.length !== before) removed = true;
          }
          if (removed) await saveControllerConfig(configPath, config);
          routesRetired = true;
        }
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
      currentWorkflow = await withManifestTransaction(cwd, (manifest) => {
        const stored = workflowFor(manifest, id) as WorkflowWithLaneRetirement;
        stored.evidence.push({
          at: now(),
          kind: "lane-retirement-routes-retired",
          text: `Removed controller routes for retired workflow ${id}; manifest record retained as history.`,
        });
        stored.updatedAt = now();
        return stored;
      });
    }
    return {
      laneRetired: finalRetirement.status === "retired",
      retired: finalRetirement.status === "retired",
      routesRetired,
      partialFailure: closeErrors.length > 0,
      workflow: workflowRetirementSummary(currentWorkflow),
      tabIds: finalRetirement.tabIds,
      closedTabIds: finalRetirement.closedTabIds,
      failedTabIds: finalRetirement.failedTabIds,
      remainingTabIds,
      commands: remainingTabIds.map((tabId) => `herdr tab close ${tabId}`),
      closeErrors,
      workspaceRetained: true,
    };
  }

  async function cleanupSweepInventory(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<{
    inventory: CleanupInventory;
    workflows: Map<string, Workflow>;
    retirementWorkflowIds: string[];
  }> {
    requireHerdr();
    if (!isRootOrchestrator())
      throw new Error(
        "Cleanup sweep is root-only: only the verified controller-mapped root may enumerate or retire resources.",
      );
    const root = await currentPaneRoot(signal);
    // Inventory must be genuinely read-only: controllerConfigPath() repairs
    // directory permissions and may create the directory, which is appropriate
    // for writers but not for a dry-run.
    const config = await loadControllerConfig(rootConfigPath());
    if (!config)
      throw new Error("Cleanup sweep requires a registered controller root.");
    const targetManifestPath = resolve(manifestPath(cwd));
    const records = config.orchestrators.filter(
      (record) =>
        sameControllerRoot(record.root, root) &&
        (record.program.id === "legacy-global" ||
          samePath(record.program.id, cwd) ||
          (record.program.parent_manifest_path !== undefined &&
            samePath(record.program.parent_manifest_path, targetManifestPath))),
    );
    if (records.length !== 1)
      throw new Error(
        records.length === 0
          ? "The verified controller-mapped root does not own this cleanup manifest."
          : "Cleanup sweep refused: the current root has an ambiguous controller mapping for this manifest.",
      );
    const orchestrator = records[0];
    const manifest = await loadManifest(cwd);
    const routedIds = new Set(
      orchestrator.workflows
        .filter((mapping) => samePath(mapping.manifest_path, targetManifestPath))
        .map((mapping) => mapping.workflow_id),
    );
    // A retired workflow has intentionally had its controller route removed.
    // Keep it in scope only when its task binding still proves ownership by
    // this root; never search manifests belonging to another orchestrator.
    const workflows = new Map<string, Workflow>();
    for (const workflow of manifest.workflows) {
      if (workflow.ownership?.createdBy !== OWNER) continue;
      const taskOwned =
        workflow.taskBinding?.rootPaneId === root.pane_id &&
        workflow.taskBinding.workspaceId === root.workspace_id;
      if (routedIds.has(workflow.id) || taskOwned)
        workflows.set(workflow.id, workflow);
    }

    const issues: CleanupInventory["issues"] = [];
    const retirementWorkflowIds: string[] = [];
    const laneTabs: CleanupTabCandidate[] = [];
    const pendingTabIdsByWorkflow = new Map<string, string[]>();
    const tabWorkspaceIds = new Set<string>();
    for (const workflow of workflows.values()) {
      const retirement = (workflow as WorkflowWithLaneRetirement).laneRetirement;
      const allTerminal =
        workflow.lanes.length > 0 &&
        workflow.lanes.every(
          (lane) =>
            Boolean(lane.completionReceipt) ||
            TERMINAL_LANE_STATUSES.has(lane.status),
        );
      if (!allTerminal || !workflow.taskBinding) continue;
      if (retirement?.status === "retired") continue;
      const recordedTabs = Array.isArray(workflow.ownership.tabIds)
        ? workflow.ownership.tabIds.filter(
            (tabId): tabId is string =>
              typeof tabId === "string" && Boolean(tabId.trim()),
          )
        : [];
      if (
        workflow.ownership.workspaceId &&
        workflow.ownership.workspaceId !== workflow.taskBinding.workspaceId
      ) {
        issues.push({
          workflowId: workflow.id,
          resource: "lane-tabs",
          error:
            "recorded ownership workspace differs from the task workspace; tabs were not made sweep candidates",
        });
        continue;
      }
      const closed = new Set(retirement?.closedTabIds ?? []);
      // Match retireTaskLaneTabs exactly: ownership.tabIds is authoritative,
      // while a partial record's pending list is only a derived breadcrumb.
      const pending = recordedTabs.filter(
        (tabId, index, list) =>
          !closed.has(tabId) && list.indexOf(tabId) === index,
      );
      retirementWorkflowIds.push(workflow.id);
      pendingTabIdsByWorkflow.set(workflow.id, pending);
      tabWorkspaceIds.add(workflow.taskBinding.workspaceId);
    }

    const labelsByWorkspace = new Map<string, Map<string, string>>();
    for (const workspaceId of tabWorkspaceIds) {
      const labels = new Map<string, string>();
      try {
        const listed = responseRecord(
          await runHerdr(["tab", "list", "--workspace", workspaceId], signal),
          "cleanup task workspace tab list",
        );
        if (!Array.isArray(listed.tabs))
          throw new Error("Herdr task workspace tab list returned no tabs.");
        for (const item of listed.tabs) {
          if (!isRecord(item) || typeof item.tab_id !== "string") continue;
          if (item.workspace_id !== undefined && item.workspace_id !== workspaceId)
            continue;
          const label = [item.label, item.name, item.title].find(
            (value): value is string => typeof value === "string" && Boolean(value),
          );
          labels.set(item.tab_id, label ?? "<unlabeled tab>");
        }
      } catch (error) {
        issues.push({
          resource: `tabs in ${workspaceId}`,
          error: `could not read tab labels: ${(error as Error).message}`,
        });
      }
      labelsByWorkspace.set(workspaceId, labels);
    }
    for (const workflow of workflows.values()) {
      const pending = pendingTabIdsByWorkflow.get(workflow.id);
      if (!pending || !workflow.taskBinding) continue;
      const labels = labelsByWorkspace.get(workflow.taskBinding.workspaceId)!;
      for (const tabId of pending)
        laneTabs.push({
          workflowId: workflow.id,
          tabId,
          label: labels.get(tabId) ?? "<tab label unavailable>",
          workspaceId: workflow.taskBinding.workspaceId,
        });
    }

    const worktrees: CleanupWorktreeCandidate[] = [];
    const worktreePaths = new Map<string, string>();
    for (const workflow of workflows.values()) {
      const allTerminal =
        workflow.lanes.length > 0 &&
        workflow.lanes.every(
          (lane) =>
            Boolean(lane.completionReceipt) ||
            TERMINAL_LANE_STATUSES.has(lane.status),
        );
      const retirement = (workflow as WorkflowWithLaneRetirement).laneRetirement;
      // Worktree removal is confirmed as a separate, already-fully-retired
      // resource. A tab retirement completed during this invocation is not
      // enough to authorize a worktree that was absent from the confirmation
      // list; the next sweep will enumerate it.
      if (!allTerminal || !workflow.worktree || retirement?.status !== "retired")
        continue;
      const path = resolve(workflow.worktree);
      if (worktreePaths.has(path)) {
        issues.push({
          workflowId: workflow.id,
          resource: "worktree",
          error: `recorded worktree duplicates workflow ${worktreePaths.get(path)}; neither duplicate was made a candidate`,
        });
        continue;
      }
      worktreePaths.set(path, workflow.id);
      let details: Awaited<ReturnType<typeof lstat>>;
      try {
        details = await lstat(path);
        if (!details.isDirectory() || details.isSymbolicLink())
          throw new Error("path is not a real directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        issues.push({
          workflowId: workflow.id,
          resource: "worktree",
          error: `recorded worktree is not a usable on-disk directory: ${(error as Error).message}`,
        });
        continue;
      }
      try {
        const listed = responseRecord(
          await runHerdr(["worktree", "list", "--cwd", path], signal),
          "cleanup worktree list",
        );
        if (!Array.isArray(listed.worktrees))
          throw new Error("Herdr worktree list returned no worktrees.");
        const matches = listed.worktrees.filter(
          (item: unknown): item is Record<string, unknown> =>
            isRecord(item) &&
            typeof item.path === "string" &&
            samePath(item.path, path),
        );
        if (matches.length !== 1)
          throw new Error(`expected one registered worktree, found ${matches.length}`);
        const openWorkspaceId = matches[0].open_workspace_id;
        if (typeof openWorkspaceId === "string" && openWorkspaceId) {
          issues.push({
            workflowId: workflow.id,
            resource: "worktree",
            error: `worktree is open in Herdr workspace ${openWorkspaceId}; it was not made a candidate`,
          });
          continue;
        }
        const git = await cleanupGitWorktreeDetails(
          path,
          workflow.worktreeBinding,
          signal,
          cwd,
        );
        worktrees.push({
          workflowId: workflow.id,
          path,
          branch: git.branch,
          ...(openWorkspaceId === null ? { openWorkspaceId: null } : {}),
        });
      } catch (error) {
        issues.push({
          workflowId: workflow.id,
          resource: "worktree",
          error: `worktree is not a cleanable unopened Git worktree: ${(error as Error).message}`,
        });
      }
    }
    // Leases held by finished or vanished workflows. A workflow owned by
    // another root is never in scope; one missing from the manifest entirely
    // has no owner left to keep its lease.
    const leases: CleanupLeaseCandidate[] = [];
    for (const lease of activeLeases(manifest.leases)) {
      const owner = manifest.workflows.find((item) => item.id === lease.workflowId);
      const scoped = workflows.get(lease.workflowId);
      const reason = !owner
        ? "workflow no longer in the manifest"
        : scoped &&
            (TERMINAL_WORKFLOW_STATUSES.has(scoped.status) ||
              (scoped.lanes.length > 0 &&
                scoped.lanes.every(
                  (lane) =>
                    Boolean(lane.completionReceipt) ||
                    TERMINAL_LANE_STATUSES.has(lane.status),
                )))
          ? `workflow ${scoped.status}`
          : undefined;
      if (reason)
        leases.push({
          leaseId: lease.id,
          workflowId: lease.workflowId,
          laneId: lease.laneId,
          resource: lease.resource,
          value: leaseValue(lease),
          reason,
        });
    }
    return {
      inventory: {
        root: {
          paneId: root.pane_id,
          workspaceId: root.workspace_id,
          orchestratorId: orchestrator.id,
        },
        laneTabs,
        worktrees,
        leases,
        issues,
      },
      workflows,
      retirementWorkflowIds,
    };
  }

  async function cleanupGitWorktreeDetails(
    path: string,
    binding: WorktreeBinding | undefined,
    signal?: AbortSignal,
    expectedRepositoryParent?: string,
  ): Promise<{ branch: string; parent: string }> {
    const canonicalPath = await realpath(path);
    const checkout = await runDirectGit(["-C", path, "rev-parse", "--show-toplevel"], signal);
    if (!samePath(await realpath(checkout), canonicalPath))
      throw new Error("recorded path is not the Git worktree root");
    const metadata = await gitMetadataDirectories(path);
    const common = resolve(metadata.commonDirectory);
    if (basename(common) !== ".git")
      throw new Error("Git common metadata does not identify a normal repository parent");
    const commonCanonical = await realpath(common);
    const recordedParent = binding?.repoParent?.checkoutPath
      ? await realpath(binding.repoParent.checkoutPath)
      : undefined;
    const expectedParent = expectedRepositoryParent
      ? await realpath(expectedRepositoryParent)
      : undefined;
    if (recordedParent) {
      const recordedMetadata = await gitMetadataDirectories(recordedParent);
      if (
        !samePath(
          await realpath(recordedMetadata.commonDirectory),
          commonCanonical,
        )
      )
        throw new Error("recorded repository parent differs from Git metadata");
    }
    // The current root may itself be a linked worktree. In that case Git's
    // common metadata parent is the main checkout, while either the recorded
    // parent or current root is still a valid command surface for removal.
    const parent = expectedParent ?? recordedParent ?? (await realpath(dirname(common)));
    if (samePath(parent, canonicalPath))
      throw new Error("refusing to remove the root checkout");
    const parentMetadata = await gitMetadataDirectories(parent);
    if (!samePath(await realpath(parentMetadata.commonDirectory), commonCanonical))
      throw new Error("worktree repository parent is outside the current root checkout");
    const parentRoot = await runDirectGit(
      ["-C", parent, "rev-parse", "--show-toplevel"],
      signal,
    );
    if (!samePath(await realpath(parentRoot), parent))
      throw new Error("repository parent is not a Git checkout root");
    const records = parseGitWorktreeRecords(
      await runDirectGit(["-C", parent, "worktree", "list", "--porcelain"], signal),
    );
    let record: { path: string; branch?: string } | undefined;
    for (const item of records) {
      try {
        if (samePath(await realpath(item.path), canonicalPath)) {
          record = item;
          break;
        }
      } catch {
        // A stale Git registration is not a removable worktree candidate.
      }
    }
    if (!record) throw new Error("Git does not register the recorded worktree");
    const branch = await runDirectGit(["-C", path, "branch", "--show-current"], signal);
    if (!branch) throw new Error("recorded worktree is detached and has no branch to remove");
    if (record.branch !== `refs/heads/${branch}`)
      throw new Error("Git worktree branch differs from the recorded branch");
    return { branch, parent };
  }

  function parseGitWorktreeRecords(
    output: string,
  ): Array<{ path: string; branch?: string }> {
    const records: Array<{ path: string; branch?: string }> = [];
    let current: { path: string; branch?: string } | undefined;
    for (const line of output.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        if (current) records.push(current);
        current = { path: line.slice("worktree ".length) };
      } else if (current && line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length);
      }
    }
    if (current) records.push(current);
    return records;
  }

  async function recordCleanupSweepEvidence(
    cwd: string,
    workflowId: string,
    kind: string,
    text: string,
  ): Promise<void> {
    await withManifestTransaction(cwd, (manifest) => {
      const workflow = workflowFor(manifest, workflowId);
      workflow.evidence.push({ at: now(), kind, text: clip(text, 4000) });
      workflow.updatedAt = now();
    });
  }

  async function cleanupWorktreeOpenWorkspace(
    path: string,
    signal?: AbortSignal,
  ): Promise<string | null | undefined> {
    const listed = responseRecord(
      await runHerdr(["worktree", "list", "--cwd", path], signal),
      "cleanup worktree list",
    );
    if (!Array.isArray(listed.worktrees))
      throw new Error("Herdr worktree list returned no worktrees.");
    const matches = listed.worktrees.filter(
      (item: unknown): item is Record<string, unknown> =>
        isRecord(item) &&
        typeof item.path === "string" &&
        samePath(item.path, path),
    );
    if (matches.length !== 1)
      throw new Error(`expected one registered worktree, found ${matches.length}`);
    const openWorkspaceId = matches[0].open_workspace_id;
    if (openWorkspaceId !== undefined && openWorkspaceId !== null && typeof openWorkspaceId !== "string")
      throw new Error("Herdr worktree list returned an invalid open workspace ID");
    return openWorkspaceId as string | null | undefined;
  }

  function cleanupSweepSummary(inventory: CleanupInventory): string {
    const lines = [
      `Cleanup sweep will retire ${inventory.laneTabs.length} lane tab(s), remove ${inventory.worktrees.length} unopened worktree(s) and release ${inventory.leases.length} lease(s).`,
      "Lane tabs:",
      ...(inventory.laneTabs.length
        ? inventory.laneTabs.map(
            (item) =>
              `- ${item.workflowId}: ${item.tabId} (${item.label}) [workspace ${item.workspaceId}]`,
          )
        : ["- none"]),
      "Worktrees:",
      ...(inventory.worktrees.length
        ? inventory.worktrees.map(
            (item) =>
              `- ${item.workflowId}: ${item.path} [branch ${item.branch}]`,
          )
        : ["- none"]),
      "Leases:",
      ...(inventory.leases.length
        ? inventory.leases.map(
            (item) =>
              `- ${item.workflowId}/${item.laneId}: ${item.resource}=${item.value} (${item.leaseId}; ${item.reason})`,
          )
        : ["- none"]),
    ];
    if (inventory.issues.length) {
      lines.push("Retained / not touched:");
      lines.push(
        ...inventory.issues.map(
          (issue) =>
            `- ${issue.workflowId ? `${issue.workflowId}: ` : ""}${
              issue.resource ? `${issue.resource}: ` : ""
            }${issue.error}`,
        ),
      );
    }
    return clip(lines.join("\n"), 9000);
  }

  async function cleanupSweep(
    cwd: string,
    execute: boolean,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    confirm = false,
  ) {
    const scoped = await cleanupSweepInventory(cwd, signal);
    const { inventory } = scoped;
    if (!execute)
      return { dryRun: true, ...inventory };
    let approved: boolean;
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      // A headless MCP/Codex caller has no native dialog to render, exactly
      // like herdr_dispatch. The calling harness is contractually required
      // to have shown the dry-run inventory and gotten explicit user
      // approval before setting confirm=true; BAA.md's dispatch guidance
      // already states this. Without it, fail closed exactly as before.
      if (!confirm)
        throw new Error(
          "Cleanup sweep execution requires either native TUI confirmation or confirm=true after the user has explicitly approved this exact dry-run inventory in this conversation.",
        );
      approved = true;
    } else {
      approved = await nativeConfirms.confirm(
        ctx.ui,
        "Herdr cleanup sweep",
        `${cleanupSweepSummary(inventory)}\n\nProceed?`,
        signal,
      );
    }
    if (!approved) return { cancelled: true, ...inventory };

    const errors: Array<{ workflowId?: string; resource: string; error: string }> = [];
    const retirementResults: Array<Record<string, unknown>> = [];
    const tabWorkflowIds = new Set(scoped.retirementWorkflowIds);
    for (const workflowId of tabWorkflowIds) {
      const workflow = scoped.workflows.get(workflowId);
      if (!workflow) continue;
      const tabIds = inventory.laneTabs
        .filter((item) => item.workflowId === workflowId)
        .map((item) => item.tabId);
      try {
        const result = await retireTaskLaneTabs(
          cwd,
          workflowId,
          workflow,
          [
            `Cleanup sweep approved; confirmed lane tabs: ${
              tabIds.length ? tabIds.join(", ") : "none"
            }.`,
          ],
          true,
          signal,
        );
        retirementResults.push({
          workflowId,
          laneRetired: result.laneRetired,
          closedTabIds: result.closedTabIds,
          failedTabIds: result.failedTabIds,
          partialFailure: result.partialFailure,
        });
        if (result.partialFailure)
          for (const failure of result.closeErrors ?? [])
            errors.push({
              workflowId,
              resource: "lane-tabs",
              error: `${failure.tabId}: ${failure.error}`,
            });
      } catch (error) {
        const message = (error as Error).message;
        errors.push({ workflowId, resource: "lane-tabs", error: message });
        try {
          await recordCleanupSweepEvidence(
            cwd,
            workflowId,
            "cleanup-sweep-lane-retirement-failed",
            message,
          );
        } catch (evidenceError) {
          errors.push({
            workflowId,
            resource: "manifest evidence",
            error: `could not persist lane failure evidence: ${(evidenceError as Error).message}`,
          });
        }
      }
    }

    const worktreeResults: Array<Record<string, unknown>> = [];
    for (const candidate of inventory.worktrees) {
      try {
        const workflow = workflowFor(await loadManifest(cwd), candidate.workflowId) as WorkflowWithLaneRetirement;
        const currentRetirement = workflow.laneRetirement;
        if (currentRetirement?.status !== "retired")
          throw new Error("lane tabs did not become fully retired; worktree remains");
        if (!workflow.worktree || !samePath(workflow.worktree, candidate.path))
          throw new Error("recorded worktree changed after confirmation");
        const openWorkspaceId = await cleanupWorktreeOpenWorkspace(candidate.path, signal);
        if (typeof openWorkspaceId === "string" && openWorkspaceId)
          throw new Error(`worktree became open in Herdr workspace ${openWorkspaceId}`);
        const git = await cleanupGitWorktreeDetails(
          candidate.path,
          workflow.worktreeBinding,
          signal,
          cwd,
        );
        if (git.branch !== candidate.branch)
          throw new Error("worktree branch changed after confirmation");
        const dirty = await runDirectGit(
          ["-C", candidate.path, "status", "--porcelain", "--untracked-files=all"],
          signal,
        );
        if (dirty)
          throw new Error("worktree is dirty; refusing removal without force");
        await runDirectGit(
          ["-C", git.parent, "worktree", "remove", candidate.path],
          signal,
        );
        let branchError: string | undefined;
        try {
          await runDirectGit(
            ["-C", git.parent, "branch", "-D", "--", candidate.branch],
            signal,
          );
        } catch (error) {
          branchError = (error as Error).message;
        }
        await withManifestTransaction(cwd, (manifest) => {
          const stored = workflowFor(manifest, candidate.workflowId);
          for (const lane of stored.lanes)
            if (
              lane.sessionLog &&
              (!lane.sessionLog.worktree ||
                samePath(lane.sessionLog.worktree, candidate.path))
            )
              lane.sessionLog = { ...lane.sessionLog, status: "gone" };
          const timestamp = now();
          stored.evidence.push({
            at: timestamp,
            kind: "cleanup-sweep-worktree-gone",
            text: JSON.stringify({
              path: candidate.path,
              branch: candidate.branch,
              branchRemoved: !branchError,
              ...(branchError ? { branchError } : {}),
            }),
          });
          stored.updatedAt = timestamp;
        });
        worktreeResults.push({
          workflowId: candidate.workflowId,
          path: candidate.path,
          branch: candidate.branch,
          removed: true,
          branchRemoved: !branchError,
          ...(branchError ? { branchError } : {}),
        });
        if (branchError)
          errors.push({
            workflowId: candidate.workflowId,
            resource: "branch",
            error: branchError,
          });
      } catch (error) {
        const message = (error as Error).message;
        errors.push({
          workflowId: candidate.workflowId,
          resource: "worktree",
          error: message,
        });
        try {
          await recordCleanupSweepEvidence(
            cwd,
            candidate.workflowId,
            "cleanup-sweep-worktree-retained",
            `${candidate.path}: ${message}`,
          );
        } catch (evidenceError) {
          errors.push({
            workflowId: candidate.workflowId,
            resource: "manifest evidence",
            error: `could not persist worktree failure evidence: ${(evidenceError as Error).message}`,
          });
        }
      }
    }
    let releasedLeaseIds: string[] = [];
    if (inventory.leases.length) {
      const wanted = new Set(inventory.leases.map((item) => item.leaseId));
      try {
        releasedLeaseIds = await withManifestTransaction(cwd, (manifest) => {
          const released = releaseLeases(
            manifest.leases,
            (lease) => wanted.has(lease.id),
            "cleanup sweep",
            now(),
          );
          for (const lease of released) {
            const owner = manifest.workflows.find((item) => item.id === lease.workflowId);
            owner?.evidence.push({
              at: now(),
              kind: "lease-released",
              text: `cleanup sweep: ${lease.id} ${lease.resource}=${leaseValue(lease)}`,
            });
          }
          return released.map((lease) => lease.id);
        });
      } catch (error) {
        errors.push({ resource: "leases", error: (error as Error).message });
      }
    }
    return {
      swept: true,
      partialFailure: errors.length > 0,
      ...inventory,
      retirementResults,
      worktreeResults,
      releasedLeaseIds,
      errors,
    };
  }

  async function close(
    cwd: string,
    id: string,
    evidence: string[],
    execute: boolean,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) {
    const manifest = await loadManifest(cwd);
    const workflow = workflowFor(manifest, id);
    const sharedWorkspace = Boolean(
      workflow.ownership.workspaceId &&
        manifest.workflows.some(
          (candidate) =>
            candidate.id !== workflow.id &&
            candidate.ownership.workspaceId ===
              workflow.ownership.workspaceId &&
            candidate.outcome !== "closed",
        ),
    );
    if (workflow.taskBinding)
      return retireTaskLaneTabs(
        cwd,
        id,
        workflow,
        evidence,
        execute,
        signal,
      );
    if (evidence.filter(Boolean).length === 0)
      throw new Error("Close requires at least one evidence item.");
    if (workflow.outcome !== "completed")
      throw new Error(
        "Close requires a completed Herdr observation; blocked, idle, failed, and unknown workflows stay open.",
      );
    if (!execute)
      return {
        dryRun: true,
        workflow: workflowRetirementSummary(workflow),
        commands:
          workflow.ownership.workspaceId && !sharedWorkspace
            ? [`herdr workspace close ${workflow.ownership.workspaceId}`]
            : [],
        workspaceRetained: sharedWorkspace,
      };
    requireHerdr();
    if (!isRootOrchestrator()) {
      const approvalRequest = requestParentApproval(workflow, "close");
      workflow.updatedAt = now();
      await saveManifest(cwd, manifest);
      return { parentApprovalRequired: true, approvalRequest, workflow };
    }
    const approved = await confirmExecution(ctx, `Close ${id}`, false, signal);
    resolveParentApproval(
      workflow,
      "close",
      approved ? "approved" : "cancelled",
    );
    workflow.updatedAt = now();
    await saveManifest(cwd, manifest);
    if (!approved) return { cancelled: true, workflow };
    if (
      workflow.ownership.createdBy !== OWNER ||
      !workflow.ownership.workspaceId
    )
      throw new Error(
        "Refusing to close: no extension-owned workspace is recorded.",
      );

    // Validate the recorded controller link before closing a workspace. A
    // stale record cannot redirect cleanup to another workflow or root.
    let registration: EventControllerRegistration | undefined;
    if (workflow.eventControllerRegistration?.status === "registered") {
      try {
        registration = registeredControllerRegistration(cwd, workflow);
        const root = await discoverControllerRoot(signal);
        if (!registration.root || !sameControllerRoot(registration.root, root))
          throw new Error(
            "Current root identity differs from the registered controller root.",
          );
        await linkedControllerConfig(registration, signal);
      } catch (error) {
        workflow.evidence.push({
          at: now(),
          kind: "event-controller-registration-pending",
          text: `Close refused before workspace mutation: ${clip((error as Error).message, 1200)}`,
        });
        workflow.updatedAt = now();
        await saveManifest(cwd, manifest);
        throw error;
      }
    }

    workflow.closeRequestedAt = now();
    workflow.evidence.push(
      ...evidence
        .filter(Boolean)
        .map((text) => ({ at: now(), kind: "closeout", text })),
    );
    // A durable workspace can carry multiple goal/lane tabs. Never close it
    // while another non-closed workflow still references it; this workflow
    // only owns its tabs/panes and close has no tab/pane mutation path.
    if (sharedWorkspace) {
      workflow.evidence.push({
        at: now(),
        kind: "workspace-retained-for-other-workflows",
        text: `Retained durable workspace ${workflow.ownership.workspaceId}; another open workflow still references it.`,
      });
    } else {
      await runHerdr(
        ["workspace", "close", workflow.ownership.workspaceId],
        signal,
      );
    }
    if (registration) {
      try {
        await unregisterEventController(cwd, workflow, signal);
      } catch (error) {
        recordControllerRegistration(workflow, {
          ...registration,
          status: "cleanup-pending",
          updatedAt: now(),
          reason: `Controller cleanup awaits recovery after workflow close: ${clip((error as Error).message, 1000)}`,
        });
        workflow.status = "close-cleanup-pending";
        workflow.outcome = "unknown";
        workflow.updatedAt = now();
        await saveManifest(cwd, manifest);
        throw new Error(
          `Workspace closed but controller cleanup is pending: ${(error as Error).message}`,
        );
      }
    }
    releaseWorkflowLeases(manifest, workflow, "workflow closed");
    workflow.status = "closed";
    workflow.outcome = "closed";
    workflow.closedAt = now();
    workflow.updatedAt = now();
    await saveManifest(cwd, manifest);
    return { closed: true, workflow };
  }

  type DoctorCheck = {
    id: string;
    status: "ok" | "warn" | "fail";
    detail: string;
  };

  /** Idempotent, read-only preflight. Never mutates the manifest, controller
   * config, or any live Herdr/plugin state; every check below is a read. */
  async function doctor(
    cwd: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
    const checks: DoctorCheck[] = [];
    const check = (id: string, run: () => Promise<Omit<DoctorCheck, "id">>) =>
      run().then(
        (partial) => checks.push({ id, ...partial }),
        (error: unknown) =>
          checks.push({
            id,
            status: "fail",
            detail: error instanceof Error ? error.message : String(error),
          }),
      );

    await check("extension-source", async () => ({
      status: "ok",
      detail: `Loaded from ${await realpath(fileURLToPath(import.meta.url))}.`,
    }));

    await check("state-location", async () => {
      const legacy = await legacyStateStatus(cwd);
      if (legacy.needsMigration)
        return {
          status: "fail",
          detail: `Orchestrator state is still at ${legacy.legacyDirectory}; rerun Baa-ton setup or state-migration.mjs to move it to ${legacy.currentDirectory}.`,
        };
      if (legacy.legacyWrittenAfterMigration)
        return {
          status: "warn",
          detail: `${legacy.legacyDirectory} changed after it was migrated; an older Baa-ton may still be running against it.`,
        };
      return {
        status: "ok",
        detail: legacy.migrated
          ? `State at ${legacy.currentDirectory}; ${legacy.legacyDirectory} kept as an archive.`
          : `State at ${legacy.currentDirectory}.`,
      };
    });

    let configPath: string | undefined;
    await check("native-herdr-connectivity", async () => {
      configPath = await controllerConfigPath(signal);
      return {
        status: "ok",
        detail: `herdr plugin config-dir resolved: ${dirname(configPath)}.`,
      };
    });

    let controllerConfig: ControllerConfig | undefined;
    await check("plugin-enablement-and-routing", async () => {
      if (!configPath)
        return {
          status: "fail",
          detail: "Cannot check without native Herdr connectivity.",
        };
      controllerConfig = await loadControllerConfig(configPath);
      if (!controllerConfig)
        return {
          status: "warn",
          detail:
            "No controller config registered yet; nothing has been dispatched through this controller.",
        };
      const workflowCount = controllerConfig.orchestrators.reduce(
        (sum, orchestrator) => sum + orchestrator.workflows.length,
        0,
      );
      return {
        status: "ok",
        detail: `${controllerConfig.orchestrators.length} registered orchestrator(s), ${workflowCount} routed workflow(s). This pane is${isRootOrchestrator() ? "" : " not"} a registered root ${currentResolvedIdentityDescription()}.`,
      };
    });

    await check("root-identity", async () => {
      if (!controllerConfig)
        return {
          status: "warn",
          detail: "No controller config is available; no registered root identity can be checked.",
        };
      const findings: string[] = [];
      const warnings: string[] = [];
      const currentPaneId = process.env.HERDR_PANE_ID;
      const currentWorkspaceId = process.env.HERDR_WORKSPACE_ID;
      const isCurrentRoot = (root: ControllerRootMapping) =>
        root.pane_id === currentPaneId && root.workspace_id === currentWorkspaceId;
      const recordFinding = (root: ControllerRootMapping, detail: string) => {
        (isCurrentRoot(root) ? findings : warnings).push(detail);
      };
      const seen = new Set<string>();
      for (const orchestrator of controllerConfig.orchestrators) {
        const root = orchestrator.root;
        const identityKey = `${root.workspace_id}:${root.pane_id}`;
        if (seen.has(identityKey)) {
          recordFinding(
            root,
            `${orchestrator.id} duplicates root identity ${identityKey}`,
          );
          continue;
        }
        seen.add(identityKey);
        try {
          const live = liveAgentIdentity(
            await runHerdr(["agent", "get", root.pane_id], signal),
            `registered root ${orchestrator.id}`,
          );
          const mismatches: string[] = [];
          if (live.paneId !== root.pane_id)
            mismatches.push(`pane_id stored=${root.pane_id} live=${live.paneId}`);
          if (live.workspaceId !== root.workspace_id)
            mismatches.push(
              `workspace_id stored=${root.workspace_id} live=${live.workspaceId}`,
            );
          if (!root.agent_kind)
            mismatches.push(`agent_kind stored=<unset> live=${live.kind}`);
          else if (live.kind !== root.agent_kind)
            mismatches.push(
              `agent_kind stored=${root.agent_kind} live=${live.kind}`,
            );
          if (root.target_kind === "name" && live.name !== root.target)
            mismatches.push(
              `target stored=${root.target} live=${live.name ?? "<unnamed>"}`,
            );
          if (mismatches.length > 0)
            recordFinding(root, `${orchestrator.id}: ${mismatches.join(", ")}`);
          else if (live.kind === "pi" && isCurrentRoot(root) && ctx.sessionManager?.getSessionId) {
            await inspectPiRootIdentity(ctx, signal);
          }
        } catch (error) {
          recordFinding(
            root,
            `${orchestrator.id} (${root.workspace_id}:${root.pane_id}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (findings.length > 0)
        return {
          status: "fail",
          detail: `Current root identity drift blocks safe root operations: ${findings.join("; ")} Inspect the named root and live metadata. Use herdr_reconcile_root only for proven registration drift; session proof failures require native identity repair, not a reset.${warnings.length ? ` Other roots need separate attention: ${warnings.join("; ")}` : ""}`,
        };
      if (warnings.length > 0)
        return {
          status: "warn",
          detail: `Current root identity matches. Other registered roots need separate attention: ${warnings.join("; ")}`,
        };
      return {
        status: "ok",
        detail: `Checked ${controllerConfig.orchestrators.length} registered root identity${controllerConfig.orchestrators.length === 1 ? "" : "ies"}; all live panes and harness identities match.`,
      };
    });

    await check("manifest-store", async () => {
      const manifest = await loadManifest(cwd);
      if (manifest.version !== 2)
        return {
          status: "warn",
          detail: `Unrecognized manifest version ${manifest.version} at ${manifestPath(cwd)}; expected 2.`,
        };
      const scope = currentRootScope(cwd);
      const goal = scope ? rootGoalFor(manifest, cwd, scope).goal : manifest.parentGoal;
      return {
        status: "ok",
        detail: `Version 2 manifest at ${manifestPath(cwd)}: ${manifest.workflows.length} workflow(s), parent goal ${goal ? "present" : "absent"}.`,
      };
    });

    await check("runtime-version-skew", async () => {
      const short = (commit?: string) => (commit ? commit.slice(0, 7) : "unknown commit");
      const installed = new Map<string, { fingerprint: string; commit?: string }>();
      const installedFor = (checkout: string) => {
        if (!installed.has(checkout))
          installed.set(checkout, { fingerprint: codeFingerprint(checkout), commit: gitCommit(checkout) });
        return installed.get(checkout)!;
      };
      const runtimeDir = configPath ? dirname(configPath) : dirname(rootConfigPath());
      const pieces: Array<Record<string, unknown>> = [
        {
          role: "extension",
          pid: process.pid,
          checkout: LOADED_CODE.checkout,
          fingerprint: LOADED_CODE.fingerprint,
          commit: LOADED_CODE.commit,
          paneId: process.env[HERDR_PANE_ID_ENV],
          self: true,
        },
        ...listRuntime(runtimeDir).filter((record) => record.pid !== process.pid),
      ];
      const lines: string[] = [];
      let stale = 0;
      const reload = (piece: Record<string, unknown>) =>
        piece.role === "supervisor"
          ? "it restarts itself within two ticks; if it does not, restart the Herdr server at a quiet point"
          : piece.role === "extension"
            ? `exit and restart this root in the same session${piece.sessionPath ? ` (pi --session ${piece.sessionPath})` : ""}`
            : "reconnect its MCP server in the same session (Claude: /mcp, reconnect herdr-orchestrator) or herdr_resume the lane";
      for (const piece of pieces) {
        const checkout = String(piece.checkout ?? LOADED_CODE.checkout);
        const disk = installedFor(checkout);
        const label = `${piece.role}${piece.self ? " (this process)" : ""} pid ${piece.pid}${piece.paneId ? ` pane ${piece.paneId}` : ""}`;
        if (piece.fingerprint === disk.fingerprint) lines.push(`${label}: current (${short(disk.commit)})`);
        else {
          stale += 1;
          lines.push(
            `${label}: loaded ${short(piece.commit as string | undefined)} (${piece.fingerprint}), installed ${short(disk.commit)} (${disk.fingerprint}) in ${checkout}; ${reload(piece)}`,
          );
        }
      }
      // Pieces started before version reporting existed leave no record.
      const recorded = new Set(pieces.map((piece) => piece.paneId).filter(Boolean));
      const manifest = await loadManifest(cwd).catch(() => undefined);
      const finished = new Set(
        (manifest?.workflows ?? []).flatMap((workflow) =>
          workflow.lanes
            .filter((lane) => lane.completionReceipt || lane.retirement || lane.sessionLog?.status === "retired")
            .map((lane) => lane.paneId),
        ),
      );
      let unknown = 0;
      for (const orchestrator of controllerConfig?.orchestrators ?? []) {
        if (!pieces.some((piece) => piece.role === "supervisor") && orchestrator === controllerConfig?.orchestrators[0]) {
          unknown += 1;
          lines.push("supervisor: no version record (started before version reporting); restart it once, then it restarts itself on later updates");
        }
        for (const workflow of orchestrator.workflows)
          for (const lane of workflow.lanes)
            if (!recorded.has(lane.pane_id) && !finished.has(lane.pane_id)) {
              unknown += 1;
              lines.push(`lane ${workflow.workflow_id}/${lane.lane_id} pane ${lane.pane_id}: no version record (started before version reporting or not running); reload it to be safe`);
            }
      }
      return {
        status: stale || unknown ? "warn" : "ok",
        detail: `${stale ? `${stale} running piece(s) on old code. ` : ""}${unknown ? `${unknown} piece(s) of unknown version. ` : ""}${lines.join("; ")}`,
      };
    });

    await check("controller-plugin-install", async () => {
      let raw: unknown;
      try {
        raw = await runHerdr(["plugin", "list", "--plugin", "herdr-orchestrator-controller", "--json"], signal);
      } catch (error) {
        return { status: "warn", detail: `Could not list Herdr plugins: ${clip((error as Error).message, 300)}` };
      }
      const found: string[] = [];
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (!isRecord(value)) return;
        if (value.id === "herdr-orchestrator-controller" || value.name === "herdr-orchestrator-controller")
          for (const key of ["manifest_path", "manifestPath", "root", "path"])
            if (typeof value[key] === "string") found.push(value[key] as string);
        Object.values(value).forEach(visit);
      };
      visit(raw);
      if (!found.length)
        return { status: "warn", detail: "The controller plugin is not listed (or its path is not reported); updates cannot be checked against it." };
      const pluginPath = found[0];
      const pluginRoot = /\.toml$/.test(pluginPath) ? dirname(pluginPath) : pluginPath;
      const expected = join(LOADED_CODE.checkout, "packages", "controller");
      const same = await Promise.all([realpath(pluginRoot).catch(() => resolve(pluginRoot)), realpath(expected).catch(() => expected)])
        .then(([a, b]) => a === b);
      return same
        ? { status: "ok", detail: `Controller plugin linked from this checkout (${pluginRoot}).` }
        : {
            status: "warn",
            detail: `Split install: the controller plugin runs from ${pluginRoot}, but this extension runs from ${LOADED_CODE.checkout}. Updating one checkout does not update the other. Relink the controller from ${expected} (herdr plugin unlink herdr-orchestrator-controller, then herdr plugin link ${expected}) at a quiet point, or update both checkouts.`,
          };
    });

    await check("parent-goal-supervisor", async () => {
      const manifest = await loadManifest(cwd);
      const scope = currentRootScope(cwd);
      const goal = scope ? rootGoalFor(manifest, cwd, scope).goal : manifest.parentGoal;
      if (!goal) return { status: "ok", detail: "No parent goal is registered." };
      const state = goal.supervisor?.state ?? "not configured";
      if (goal.status !== "completed" && goal.status !== "paused" && state === "stopped")
        return {
          status: "warn",
          detail: `Parent goal ${goal.id} is ${goal.status} but its supervisor is ${state}, so the root gets no nudges. Run herdr_goal action=start, or record the goal as completed or paused.`,
        };
      return {
        status: "ok",
        detail: `Parent goal ${goal.id} is ${goal.status}; supervisor ${state}${
          goal.supervisor?.nextNudgeAt ? `, next nudge ${goal.supervisor.nextNudgeAt}` : ""
        }.`,
      };
    });

    await check(
      "codex-sandbox-git-metadata-writability",
      () => inspectCodexSandboxGitMetadata(cwd),
    );

    await check("lane-bridge-liveness", async () => {
      if (!controllerConfig)
        return {
          status: "warn",
          detail:
            "No controller config is available; no mapped lane bridge can be checked.",
        };
      const lanes = controllerConfig.orchestrators.flatMap((orchestrator) =>
        orchestrator.workflows.flatMap((workflow) =>
          workflow.lanes.map((lane) => ({
            orchestrator,
            workflow,
            lane,
          })),
        ),
      );
      if (lanes.length === 0)
        return {
          status: "ok",
          detail: "No mapped lane bridges are currently registered.",
        };
      const results: string[] = [];
      const warnings: string[] = [];
      for (const { workflow, lane } of lanes) {
        // Load the stored manifest lane first: a gone pane is only tolerable
        // when the lane already holds a durable completion receipt.
        let attestation: unknown = null;
        let storedLane: Lane | undefined;
        try {
          const manifest = JSON.parse(
            await readFile(workflow.manifest_path, "utf8"),
          ) as Manifest;
          const stored = manifest.workflows.find(
            (candidate) => candidate.id === workflow.workflow_id,
          );
          storedLane = stored?.lanes.find(
            (candidate) => candidate.id === lane.lane_id,
          );
          if (storedLane?.startupIntentPath)
            attestation = JSON.parse(
              await readFile(`${storedLane.startupIntentPath}.ready`, "utf8"),
            );
        } catch {
          attestation = null;
        }
        let response: Record<string, unknown>;
        try {
          response = responseRecord(
            await runHerdr(["agent", "get", lane.pane_id], signal),
            `lane bridge ${lane.lane_id}`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // runHerdrRaw embeds the CLI error envelope in its exception. Match
          // its code, not text that an unrelated error could mention.
          const prefix = `herdr agent get ${lane.pane_id} failed: `;
          let failure: unknown;
          try {
            if (message.startsWith(prefix))
              failure = JSON.parse(message.slice(prefix.length));
          } catch {
            // Unstructured or truncated failures must remain failures.
          }
          if (
            !isRecord(failure) ||
            !isRecord(failure.error) ||
            failure.error.code !== "agent_not_found"
          ) throw error;
          // The pane is gone. Terminal status alone is insufficient: only a
          // durable completion receipt with an ID and summary proves the lane
          // finished before its pane disappeared.
          const receipt = storedLane?.completionReceipt;
          if (
            isRecord(receipt) &&
            typeof receipt.id === "string" &&
            receipt.id.trim().length > 0 &&
            typeof receipt.summary === "string" &&
            receipt.summary.trim().length > 0
          ) {
            warnings.push(
              `${lane.lane_id} (${lane.pane_id}) pane is gone; lane has durable completion receipt ${receipt.id}`,
            );
            continue;
          }
          throw new Error(
            `Lane ${lane.lane_id} pane ${lane.pane_id} is gone without a durable completion receipt.`,
          );
        }
        const agent = response.agent;
        if (!isRecord(agent))
          throw new Error(
            `Lane ${lane.lane_id} agent response did not contain native identity.`,
          );
        if (
          agent.pane_id !== lane.pane_id ||
          agent.workspace_id !== lane.workspace_id
        )
          throw new Error(
            `Lane ${lane.lane_id} native identity does not match its registered route.`,
          );
        if (agent.launch_pending || agent.interactive_ready === false) {
          warnings.push(
            `${lane.lane_id} (${lane.pane_id}) is not interactive-ready`,
          );
          continue;
        }
        // A startup attestation containing all protocol operations is the
        // strongest read-only evidence available for a stdio bridge: the
        // bridge has no independently addressable socket to ping. Missing or
        // incomplete evidence is surfaced as a warning rather than guessed
        // healthy from a pane status alone.
        const piIdentityMatches = agent.agent === "pi" &&
          isRecord(attestation) &&
          attestation.paneId === lane.pane_id &&
          attestation.workspaceId === lane.workspace_id &&
          typeof storedLane?.startupNonce === "string" &&
          attestation.nonce === storedLane.startupNonce &&
          isRecord(agent.agent_session) &&
          agent.agent_session.kind === "path" &&
          typeof attestation.sessionPath === "string" &&
          agent.agent_session.value === attestation.sessionPath;
        const operations = agent.agent === "pi"
          ? piIdentityMatches && isRecord(attestation)
            ? mapPiToolNamesToProtocolOperations(attestation.tools)
            : undefined
          : isRecord(attestation) ? attestation.operations : undefined;
        if (
          !Array.isArray(operations) ||
          !STARTUP_PROOF_REQUIRED_OPERATIONS.every((operation) =>
            operations.includes(operation),
          )
        ) {
          warnings.push(
            `${lane.lane_id} (${lane.pane_id}) has no complete startup bridge attestation`,
          );
          continue;
        }
        results.push(`${lane.lane_id} (${lane.pane_id}) native/bridge evidence present`);
      }
      return {
        status: warnings.length ? "warn" : "ok",
        detail: [
          results.length
            ? `Checked ${results.length}/${lanes.length} mapped lane bridge(s): ${results.join("; ")}.`
            : `Checked ${lanes.length} mapped lane bridge(s).`,
          ...(warnings.length ? [`Warnings: ${warnings.join("; ")}.`] : []),
        ].join(" "),
      };
    });

    await check("adapter-registry-capability-matrix", async () => {
      const adapters = new HarnessAdapterRegistry();
      adapters.register(
        piLaunchAdapter(
          ctx,
          join(homedir(), ".pi/agent/extensions/herdr-agent-state.ts"),
        ),
      );
      adapters.register(
        claudeLaunchAdapter({
          bridge: fileURLToPath(new URL("./mcp-server.mjs", import.meta.url)),
          attestHelper: fileURLToPath(
            new URL("./claude-startup-attest.mjs", import.meta.url),
          ),
          scratchDirectory: dirname(manifestPath(cwd)),
        }),
      );
      const matrix = adapters.capabilities();
      const unqualified = matrix.filter(
        (entry) =>
          !entry.startupAttestation || !entry.supportsSessionPersistence,
      );
      return {
        status: unqualified.length > 0 ? "warn" : "ok",
        detail: jsonText(matrix),
      };
    });

    return { ok: checks.every((entry) => entry.status !== "fail"), checks };
  }

  // A run spans every tool/LLM turn, retries, compaction and queued follow-ups.
  // No timer, tool completion, agent_end, or Herdr idle snapshot releases it.
  let rootRunId = randomUUID();
  function currentRootTurn(state: RootTurn["state"]): RootTurn {
    return {
      state,
      runId: rootRunId,
      paneId: process.env.HERDR_PANE_ID ?? "",
      workspaceId: process.env.HERDR_WORKSPACE_ID ?? "",
      updatedAt: now(),
    };
  }
  async function persistRootTurn(
    ctx: ExtensionContext,
    state: RootTurn["state"],
  ): Promise<void> {
    if (process.env.HERDR_ENV !== "1") return;
    await refreshHerdrIdentity(ctx.signal);
    if (!isRootOrchestrator()) return;
    const turn = currentRootTurn(state);
    const config = readControllerConfigForCurrentPane();
    const mappedRoot = config?.orchestrators.find(
      (record) =>
        record.root.pane_id === turn.paneId &&
        record.root.workspace_id === turn.workspaceId &&
        record.root.agent_kind === "pi" &&
        (record.program?.parent_manifest_path === manifestPath(ctx.cwd) ||
          record.workflows.some(
            (workflow) => workflow.manifest_path === manifestPath(ctx.cwd),
          )),
    );
    if (!mappedRoot) return;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireManifestLock(ctx.cwd, 10_000);
      // A queued settled handler must not release a newer run.
      if (turn.runId !== rootRunId || (state === "idle" && !ctx.isIdle()))
        return;
      const manifest = await loadManifest(ctx.cwd);
      const scope: CurrentRootScope = {
        rootId: mappedRoot.id,
        root: mappedRoot.root,
        orchestrator: mappedRoot,
      };
      const goal = rootGoalFor(manifest, ctx.cwd, scope).goal;
      const control = goal?.supervisor;
      if (
        state === "idle" &&
        control &&
        (control.rootTurn?.runId !== turn.runId ||
          control.rootTurn.state !== "active")
      )
        return;
      const sessionPath = ctx.sessionManager.getSessionFile();
      const sessionAgent = {
        agent_status:
          state === "active" ? "working" : state === "idle" ? "idle" : "unknown",
        ...(sessionPath
          ? { agent_session: { kind: "path" as const, value: sessionPath } }
          : {}),
      };
      rootSessionEntryFor(
        manifest,
        ctx.cwd,
        scope,
        sessionAgent,
        manifest.rootSessionLogs?.find((entry) => entry.rootId === scope.rootId)
          ?.startedAt ?? manifest.sessionLog?.startedAt ?? turn.updatedAt,
        turn.updatedAt,
      );
      if (!control) {
        await saveManifest(ctx.cwd, manifest);
        return;
      }
      control.rootTurn = turn;
      if (state === "active" && control.lastDelivery?.status === "delivered")
        control.lastDelivery.acknowledgedAt ??= turn.updatedAt;
      // Settling never clears the wake latch. Only a material goal transition does.
      control.updatedAt = turn.updatedAt;
      await saveManifest(ctx.cwd, manifest);
    } catch (error) {
      // Pi logs lifecycle errors and otherwise continues. Do not execute a run
      // with stale idle authority if its active write could not be persisted.
      if (state === "active") ctx.abort();
      throw error;
    } finally {
      await release?.();
    }
  }
  // acknowledgeActivation() is idempotent and cheap when nothing is pending
  // (a local file read that returns undefined), so it is safe to attempt on
  // every agent_start. session_start does not fire on /reload, so it alone
  // can never observe the reload it is meant to acknowledge; agent_start
  // fires on every subsequent turn, including the one that follows a
  // reload, and is the hook that actually closes this loop.
  async function attemptActivationAck(ctx: {
    sessionManager: { getSessionFile(): string | undefined };
    signal?: AbortSignal;
  }): Promise<void> {
    await refreshHerdrIdentity(ctx.signal);
    if (!isRootOrchestrator()) return;
    const activation = await acknowledgeActivation(
      dirname(rootConfigPath()),
      {
        paneId: process.env.HERDR_PANE_ID,
        workspaceId: process.env.HERDR_WORKSPACE_ID,
        sessionPath: ctx.sessionManager.getSessionFile(),
        source: await realpath(fileURLToPath(import.meta.url)),
      },
      async (paneId: string) =>
        responseRecord(
          await runHerdr(["agent", "get", paneId], ctx.signal),
          "activation root",
        ).agent,
    );
    if (activation)
      pi.sendMessage(
        {
          customType: "herdr-runtime-activated",
          display: true,
          content: `Authorized runtime activation ${activation.id} verified in ${activation.workspaceId}. Continue the existing task: verify the live subscription/profile, then plan and dispatch bounded Luna work in this workspace only. Do not ask for activation approval again.`,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
  }
  pi.on("agent_start", async (_event, ctx) => {
    rootRunId = randomUUID();
    await persistRootTurn(ctx, "active");
    await attemptActivationAck(ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await persistRootTurn(ctx, "idle");
    await autoRetireFinishedLanes(ctx);
    try {
      if (isRootOrchestrator() && isRootForManifest(ctx.cwd)) await runSpecDriver(ctx);
    } catch {
      // The driver records its own failures in spec-state; never throw into Pi.
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    removeRuntimeRecord?.();
    removeRuntimeRecord = undefined;
    rootRunId = randomUUID();
    await persistRootTurn(ctx, "unknown");
  });
  let removeRuntimeRecord: (() => void) | undefined;
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.HERDR_ENV === "1" && process.env.BAA_TON_NO_RUNTIME_RECORDS !== "1" && !removeRuntimeRecord)
      removeRuntimeRecord = recordRuntime(dirname(rootConfigPath()), {
        role: "extension",
        checkout: LOADED_CODE.checkout,
        fingerprint: LOADED_CODE.fingerprint,
        commit: LOADED_CODE.commit,
        paneId: process.env[HERDR_PANE_ID_ENV],
        workspaceId: process.env.HERDR_WORKSPACE_ID,
        sessionPath: ctx.sessionManager?.getSessionFile?.(),
        agentKind: "pi",
      });
    rootRunId = randomUUID();
    await refreshHerdrIdentity(ctx.signal);
    await persistRootTurn(ctx, "unknown");
    const startupPath = process.env.BAA_STARTUP_INTENT;
    if (startupPath) {
      const intent = parseJson(await readFile(startupPath, "utf8"));
      const profile = validateLaunchProfile(intent.profile);
      await verifyActualProfile(profile, ctx);
      if (
        intent.workspaceId !== process.env.HERDR_WORKSPACE_ID ||
        intent.paneId !== process.env.HERDR_PANE_ID ||
        intent.source !== fileURLToPath(import.meta.url)
      )
        throw new Error(
          "Startup binding differs from the native task workspace or adapter source.",
        );
      const sessionPath = ctx.sessionManager.getSessionFile();
      if (!sessionPath)
        throw new Error(
          "A durable native session is required for startup proof.",
        );
      const ready = {
        version: 1,
        nonce: intent.nonce,
        paneId: process.env.HERDR_PANE_ID,
        workspaceId: process.env.HERDR_WORKSPACE_ID,
        sessionPath,
        profile,
        source: fileURLToPath(import.meta.url),
        tools: pi.getActiveTools(),
      };
      const temporary = `${startupPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, jsonText(ready), { mode: 0o600 });
      await rename(temporary, `${startupPath}.ready`);
    }
    await attemptActivationAck(ctx);
    if (!ctx.hasUI) return;
    const manifest = await loadManifest(ctx.cwd);
    const scope = currentRootScope(ctx.cwd);
    const goal = scope ? rootGoalFor(manifest, ctx.cwd, scope).goal : manifest.parentGoal;
    if (goal)
      await publishParentGoalSidebar(
        goal,
        ctx.signal,
        queueViewForRoot(manifest, ctx.cwd, scope),
      );
    else await clearParentGoalSidebar(ctx.signal);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (process.env.HERDR_ENV === "1")
      await refreshHerdrIdentity(ctx.signal);
    // SAFETY: Pi's event union requires a runtime tool-name guard before bash input is available.
    const call = event as unknown as {
      toolName?: string;
      input?: { command?: unknown };
    };
    if (
      call.toolName === "ask_user_question" &&
      process.env.HERDR_ENV === "1" &&
      isRegisteredChildLane()
    ) {
      try {
        const persisted = await persistParentQuestion(
          ctx.cwd,
          call.input ?? {},
        );
        await wakeParentForQuestion(ctx.cwd, persisted.request, ctx.signal);
        return {
          block: true,
          terminate: true,
          reason: `Question ${persisted.request.id} is stored for the registered parent. Direct child UI remains disabled.`,
        };
      } catch (error) {
        // Routing/persistence failure is not successful delegation. Keep it visible.
        return {
          block: true,
          reason: `Parent question routing failed: ${(error as Error).message}. No user answer was recorded; do not treat this as approval.`,
        };
      }
    }
    const command = call.input?.command;
    if (call.toolName !== "bash" || typeof command !== "string") return;
    const gitPush = /(?:^|[;&|]\s*)git(?:\s+\S+)*\s+push\b/im;
    const nonAutonomousMutation =
      /(?:^|[;&|]\s*)(?:git(?:\s+\S+)*\s+(?:push|merge)\b|gh\s+pr\s+create\b|glab\s+mr\s+create\b|hub\s+pull-request\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:deploy|publish|release)\b|(?:wrangler|vercel|netlify|flyctl|kubectl)\s+(?:deploy|publish|apply)\b|herdr\s+(?:workspace|tab|pane)\s+close\b)/im;
    // 2026-09-16 ruling: the verified controller-mapped root is the parent
    // executor acting with the user present, so a plain `git push` is allowed
    // there, and it may retire its own lane tabs/panes (children remain
    // reachable through durable manifests). Every other mutation stays
    // blocked for every caller, workspace closure is never allowed from an
    // agent shell (it would close the root's own session), and a compound
    // command that also carries a non-push mutation keeps the block.
    const nonPushMutation =
      /(?:^|[;&|]\s*)(?:git(?:\s+\S+)*\s+merge\b|gh\s+pr\s+create\b|glab\s+mr\s+create\b|hub\s+pull-request\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:deploy|publish|release)\b|(?:wrangler|vercel|netlify|flyctl|kubectl)\s+(?:deploy|publish|apply)\b)/im;
    const herdrWorkspaceClose =
      /(?:^|[;&|]\s*)herdr\s+workspace\s+close\b/im;
    const herdrPaneClose =
      /(?:^|[;&|]\s*)herdr\s+(?:tab|pane)\s+close\b/im;
    if (
      process.env.HERDR_ENV === "1" &&
      (nonPushMutation.test(command) ||
        herdrWorkspaceClose.test(command) ||
        (gitPush.test(command) && !isRootOrchestrator()) ||
        (herdrPaneClose.test(command) && !isRootOrchestrator()))
    ) {
      return {
        block: true,
        reason:
          "Push, merge, PR creation, deploy/external mutation, and Herdr resource closure require explicit parent approval and are never authorized by the local policy.",
      };
    }
    if (blocksUnmanagedAgentCommand(command)) {
      return {
        block: true,
        reason:
          "Delegated Pi sessions and detached child jobs must be created only through Herdr dispatch.",
      };
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (process.env.HERDR_ENV !== "1") return {};
    await refreshHerdrIdentity(ctx.signal);
    await persistRootTurn(ctx, "active");
    return {
      systemPrompt: `${event.systemPrompt}\n\nHerdr controller active. Use available Herdr tools only as permitted by role; do not poll. Continue authorized safe local work until waiting, blocked, paused, or complete. Herdr delegation policy: delegate only via herdr_plan then herdr_dispatch. Every child must be a new Herdr-created session using its declared agentKind from the installed Herdr compatibility set. Never use Pi subagents, Pi background tasks, detached/background child jobs, or direct Pi child-session launches. Use herdr_observe for completion and herdr_close with evidence for extension-owned resources only.${await rootBootstrapPrompt(ctx.cwd)}`,
    };
  });

  pi.registerTool({
    name: "herdr_bootstrap_root",
    label: "Bootstrap Herdr Root",
    description:
      "Explicitly claim the verified current pane as the Baa-ton root before creating a parent goal; pass add=true to append a distinct concurrent root.",
    promptSnippet:
      "Bootstrap or add the manually started Baa-ton root; confirmation is opt-in.",
    promptGuidelines: [
      "Use herdr_bootstrap_root only when Zach explicitly asks to initialize a manually started Baa-ton parent. add=true appends the current pane/workspace without resetting existing roots; it requires a distinct pane and workspace and never replaces a different cwd. It never creates lanes or enables the controller; pass confirm=true only when Zach asks for a confirmation gate.",
    ],
    parameters: Type.Object(
      {
        reset: Type.Optional(Type.Boolean()),
        add: Type.Optional(Type.Boolean()),
        confirm: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      const result = await bootstrapRoot(
        ctx.cwd,
        params.reset ?? false,
        params.add ?? false,
        params.confirm ?? false,
        ctx,
        signal,
      );
      if (!result.alreadyRegistered && ctx.hasUI)
        await clearParentGoalSidebar(signal);
      return {
        content: [
          {
            type: "text",
            text: `${result.alreadyRegistered
              ? `Verified Baa-ton root ${result.root.pane_id} is already registered.`
              : `${result.add ? "Added" : "Registered"} Baa-ton root ${result.root.pane_id}${result.reset ? " after retiring prior mappings" : ""}.`}${result.evidence.length ? ` ${result.evidence.join(" ")}` : ""}`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_recover_root",
    label: "Recover stale project root",
    description: "Preview or explicitly apply an audited migration from a gone workspace/root to this verified native session. Preserves other roots, completed workflow receipts and historical task bindings. Requires quiescent workflows; never resets, dispatches or resumes work. Preview first, then execute only with user authorization and its exact fingerprint. Reconcile any failed external submission before changing the manifest.",
    parameters: Type.Object({
      oldRootId: Type.String({ minLength: 1 }),
      execute: Type.Optional(Type.Boolean()),
      expectedFingerprint: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await recoverRoot(ctx.cwd, params.oldRootId, params.execute ?? false, params.expectedFingerprint, params.evidence, ctx, signal);
      return { content: [{ type: "text", text: jsonText(result) }], details: result };
    },
  });
  pi.registerTool({
    name: "herdr_root_identity",
    label: "Inspect Native Pi Root Identity",
    description: "Read-only proof of the current registered Pi root: native pane/workspace, runtime session UUID, session header and canonical path. Does not register, reconcile, plan or dispatch.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, signal, _update, ctx) {
      const proof = await inspectPiRootIdentity(ctx, signal);
      return { content: [{ type: "text", text: jsonText(proof) }], details: proof };
    },
  });
  pi.registerTool({
    name: "herdr_reconcile_root",
    label: "Reconcile Herdr Root",
    description:
      "Safely reconcile the current verified root pane's live harness identity in place without resetting or replacing any controller state.",
    promptSnippet:
      "Repair a stale root harness identity from the affected live Herdr pane.",
    promptGuidelines: [
      "Use herdr_reconcile_root only from the affected live root pane after herdr_doctor reports root identity drift. It updates that exact pane/workspace mapping and durable root session snapshots only; it never resets a root, changes workflows, or repairs a different pane.",
    ],
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, signal, _update, ctx) {
      const result = await reconcileRootIdentity(
        ctx.cwd,
        signal,
        ctx.sessionManager?.getSessionFile?.(),
      );
      return {
        content: [
          {
            type: "text",
            text: result.evidence.join(" "),
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_goal",
    label: "Herdr Goal",
    description:
      "Create or update the controller-owned thin parent goal record; it never polls or resumes Pi goals.",
    promptSnippet:
      "Manage the durable Herdr parent goal from the designated root.",
    promptGuidelines: [
      "Use herdr_goal only from the verified controller-mapped root. Initialize only for an explicit user objective. A durable controller signal changes the goal to action-required; continue authorized safe local work and set waiting-for-event or another truthful state only at a real wait, blocker, pause, or completion boundary.",
    ],
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("initialize"),
          Type.Literal("set-state"),
          Type.Literal("status"),
          Type.Literal("start"),
          Type.Literal("stop"),
          Type.Literal("pause"),
          Type.Literal("reset"),
        ]),
        objective: Type.Optional(Type.String()),
        status: Type.Optional(Type.String()),
        nextAction: Type.Optional(Type.String()),
        nudgeIntervalSeconds: Type.Optional(
          Type.Integer({
            minimum: MIN_PARENT_GOAL_NUDGE_INTERVAL_SECONDS,
            maximum: MAX_PARENT_GOAL_NUDGE_INTERVAL_SECONDS,
          }),
        ),
        pauseReason: Type.Optional(Type.String()),
        force: Type.Optional(Type.Boolean()),
        reason: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      const result = await parentGoal(
        ctx.cwd,
        params.action,
        params.objective,
        params.status,
        params.nextAction,
        params.nudgeIntervalSeconds,
        params.pauseReason,
        params.force ?? false,
        params.reason,
        currentRootTurn("active"),
      );
      if ("reset" in result) {
        if (ctx.hasUI) await clearParentGoalSidebar(signal);
        return {
          content: [
            {
              type: "text",
              text: `Archived parent goal ${result.archivedGoalId}; reset complete (${result.historyLength} archived goal${result.historyLength === 1 ? "" : "s"}).`,
            },
          ],
          details: result,
        };
      }
      if (ctx.hasUI) {
        const manifest = await loadManifest(ctx.cwd);
        await publishParentGoalSidebar(
          result.goal,
          signal,
          queueViewForRoot(manifest, ctx.cwd, currentRootScope(ctx.cwd)),
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `Parent goal ${result.goal.id}: ${result.goal.status} (${result.goalHistoryCount} archived goal${result.goalHistoryCount === 1 ? "" : "s"})`,
          },
        ],
        details: { goal: result.goal, goalHistoryCount: result.goalHistoryCount },
      };
    },
  });
  pi.registerTool({
    name: "herdr_question_answer",
    label: "Herdr Question Answer",
    description:
      "Record a user-approved parent answer and deliver it to one mapped child lane.",
    promptSnippet:
      "Answer a durable mapped-child question from the verified controller root.",
    promptGuidelines: [
      "Use only after Zach has answered the exact durable child question. This records and delivers the answer; it never resumes a paused Pi goal.",
    ],
    parameters: Type.Object(
      {
        requestId: Type.String({ minLength: 1 }),
        answer: Type.String({ minLength: 1, maxLength: 6000 }),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      const question = await answerChildQuestion(
        ctx.cwd,
        params.requestId,
        params.answer,
        signal,
      );
      return {
        content: [
          { type: "text", text: `Delivered parent answer for ${question.id}.` },
        ],
        details: { question },
      };
    },
  });
  pi.registerTool({
    name: "herdr_message",
    label: "Herdr Message",
    description:
      "Send durable informational work context to the mapped parent root; it remains available even after this lane reports completion.",
    promptSnippet:
      "Send a durable informational message to the mapped Herdr parent.",
    promptGuidelines: [
      "Use herdr_message for information the root should review, herdr_question_answer flow for a decision needed from Zach, and herdr_complete for the lane's one completion receipt. A message is informational and never requests approval.",
      "A registered child may use this after herdr_complete when a late fact still needs to reach the parent; the root itself has no parent to message.",
    ],
    parameters: Type.Object(
      {
        workflowId: Type.String({ minLength: 1 }),
        summary: Type.String({
          minLength: 1,
          maxLength: MESSAGE_SUMMARY_MAX_LENGTH,
        }),
        details: Type.Optional(
          Type.String({ maxLength: MESSAGE_DETAILS_MAX_LENGTH }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      const result = await sendMessage(
        ctx.cwd,
        params.workflowId,
        params.summary,
        params.details,
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: `Stored child message ${result.request.id}; parent notification: ${result.delivery}.`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_complete",
    label: "Herdr Complete",
    description:
      "Deliver one verified child completion receipt to the registered controller root.",
    promptSnippet: "Report a completed mapped child lane to its Herdr parent.",
    parameters: Type.Object({
      workflowId: Type.String(),
      summary: Type.String(),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await complete(
        ctx.cwd,
        params.workflowId,
        params.summary,
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: `Stored completion receipt ${result.relationshipId}; parent notification: ${result.delivery}.`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_operator_close",
    label: "Herdr Operator Close",
    description:
      "Record a root-authorized operator reconciliation for a lane that could not store its own completion receipt; this never creates or impersonates herdr_complete.",
    promptSnippet:
      "Reconcile a verified receipt-blocked lane with explicit operator, reason, and evidence.",
    promptGuidelines: [
      "Use only from the verified controller-mapped root after independently verifying the lane's work and recording who, why, and concrete evidence.",
      "This operation sets an explicit operator-closed state and never writes a lane completionReceipt.",
    ],
    parameters: Type.Object({
      workflowId: Type.String({ minLength: 1 }),
      laneId: Type.String({ minLength: 1 }),
      who: Type.String({ minLength: 1 }),
      why: Type.String({ minLength: 1 }),
      evidence: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await operatorClose(
        ctx.cwd,
        params.workflowId,
        params.laneId,
        params.who,
        params.why,
        params.evidence,
      );
      return {
        content: [
          {
            type: "text",
            text: `Operator-closed ${params.workflowId}/${params.laneId}; lane completion receipt was not recorded.`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_reparent",
    label: "Herdr Reparent",
    description:
      "Preview or root-confirm a controller-root handoff for one isolated registered workflow.",
    promptSnippet:
      "Reparent an isolated Herdr controller workflow to the verified current root.",
    parameters: Type.Object({
      workflowId: Type.String(),
      execute: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await reparent(
        ctx.cwd,
        params.workflowId,
        params.execute ?? false,
        ctx,
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: result.dryRun
              ? `Dry-run reparent for ${params.workflowId}`
              : result.cancelled
                ? "Reparent cancelled"
                : result.unchanged
                  ? "Controller root is already current"
                  : `Reparented ${params.workflowId}`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_queue",
    label: "Herdr Queue",
    description:
      "Manage the verified root's durable ordered queue; queue intent never replaces root scoping judgment at dequeue time.",
    promptSnippet: "Manage the root-only durable Herdr work queue.",
    promptGuidelines: [
      "Use herdr_queue only from the verified controller-mapped root. Enqueue intent with declared files and after dependencies, dequeue only when the ordered head is clear, and record verified/landed/dropped transitions with evidence.",
    ],
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("enqueue"),
          Type.Literal("dequeue"),
          Type.Literal("list"),
          Type.Literal("update"),
        ]),
        objective: Type.Optional(Type.String({ minLength: 1 })),
        notes: Type.Optional(Type.String()),
        files: Type.Optional(Type.Array(Type.String())),
        after: Type.Optional(Type.Array(Type.String())),
        queueItemId: Type.Optional(Type.String({ minLength: 1 })),
        state: Type.Optional(
          Type.Union([
            Type.Literal("verified"),
            Type.Literal("landed"),
            Type.Literal("dropped"),
          ]),
        ),
        evidence: Type.Optional(Type.String({ minLength: 1 })),
        reason: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await queueOperation(ctx.cwd, params.action, params);
      if (ctx.hasUI) {
        const manifest = await loadManifest(ctx.cwd);
        const goal = currentRootScope(ctx.cwd)
          ? rootGoalFor(manifest, ctx.cwd, currentRootScope(ctx.cwd)!).goal
          : manifest.parentGoal;
        if (goal)
          await publishParentGoalSidebar(
            goal,
            _signal,
            queueViewForRoot(manifest, ctx.cwd, currentRootScope(ctx.cwd)),
          );
      }
      const details = result as {
        queueItem?: QueueItem;
        item?: QueueItem;
        head?: QueueItem;
        blockers?: QueueBlockers;
        deduplicated?: boolean;
      };
      const subject = details.queueItem ?? details.item ?? details.head;
      return {
        content: [
          {
            type: "text",
            text:
              params.action === "enqueue"
                ? `${details.deduplicated ? "Reused" : "Enqueued"} ${subject?.id ?? "queue item"}.`
                : params.action === "dequeue"
                  ? subject
                    ? `Queue head ${subject.id} is dispatchable.`
                    : `Queue head is blocked${details.blockers ? `: ${queueBlockerText(details.blockers)}` : "."}`
                  : params.action === "update"
                    ? `Queue item ${subject?.id ?? params.queueItemId} is now ${subject?.state}.`
                    : `Queue has ${((result as { items?: QueueItem[] }).items ?? []).length} item(s).`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_plan",
    label: "Herdr Plan",
    description:
      "Create a durable local plan manifest for Herdr-managed agent lanes, optionally using a named task profile or linking to a dispatchable queue item.",
    promptSnippet: "Plan a Herdr-only delegated agent workflow.",
    promptGuidelines: [
      "Use herdr_plan before herdr_dispatch; select a named taskProfile from .baa-ton/config.json when configured, or provide an exact launchProfile. Pass queueItemId to consume the clear queue head and copy its objective/notes. Supply authorizationPolicy only for the legacy BB-029 local-only scope; standing approval for routine work belongs in approvalPolicy in .baa-ton/config.json (see herdr_policy).",
    ],
    parameters: Type.Object(
      {
        objective: Type.Optional(Type.String()),
        queueItemId: Type.Optional(Type.String({ minLength: 1 })),
        lanes: Type.Optional(
          Type.Array(
            Type.Union([
              Type.String(),
              Type.Object(
                {
                  objective: Type.String(),
                  readOnly: Type.Optional(Type.Boolean()),
                  agentKind: Type.Optional(Type.String()),
                  taskProfile: Type.Optional(Type.String({ minLength: 1 })),
                  dependencies: Type.Optional(Type.Array(Type.String())),
                  dependsOn: Type.Optional(Type.Array(Type.String())),
                  mcpServers: Type.Optional(Type.Record(Type.String(), Type.Any())),
                  launchProfile: Type.Optional(
                    Type.Object(
                      {
                        provider: Type.String(),
                        model: Type.String(),
                        thinking: Type.String(),
                        auth: Type.Literal("subscription"),
                      },
                      { additionalProperties: false },
                    ),
                  ),
                },
                { additionalProperties: false },
              ),
            ]),
          ),
        ),
        worktreeCwd: Type.Optional(Type.String()),
        agentKind: Type.Optional(Type.String()),
        taskProfile: Type.Optional(Type.String({ minLength: 1 })),
        launchProfile: Type.Optional(
          Type.Object(
            {
              provider: Type.String(),
              model: Type.String(),
              thinking: Type.String(),
              auth: Type.Literal("subscription"),
            },
            { additionalProperties: false },
          ),
        ),
        authorizationPolicy: Type.Optional(
          Type.Object(
            {
              version: Type.Integer({ minimum: 1, maximum: 1 }),
              scope: Type.Object({
                workflow: Type.String(),
                localOnly: Type.Boolean(),
              }),
              capabilities: Type.Array(Type.String(), {
                minItems: 1,
                maxItems: AUTHORIZATION_CAPABILITIES.length,
              }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, _signal, _update, ctx) {
      const workflow = await plan(
        ctx.cwd,
        params.objective,
        (params.lanes ?? []).map((lane) =>
          typeof lane === "string"
            ? lane
            : {
                ...lane,
                agentKind:
                  lane.agentKind === undefined
                    ? undefined
                    : validateAgentKind(lane.agentKind),
              },
        ),
        params.worktreeCwd,
        params.authorizationPolicy,
        params.agentKind,
        params.launchProfile,
        params.queueItemId,
        params.taskProfile,
        ctx,
      );
      return {
        content: [
          {
            type: "text",
            text: `Planned ${workflow.id} in ${manifestPath(ctx.cwd)}`,
          },
        ],
        details: { workflow },
      };
    },
  });
  pi.registerTool({
    name: "herdr_dispatch",
    label: "Herdr Dispatch",
    description:
      "Dispatch verified lanes into the root-bound task workspace only. Explicit per-lane or workflow-fallback launch profiles and startup proof are mandatory; no workspace creation or model fallback.",
    promptSnippet:
      "Dispatch only a planned Herdr workflow; dry-run by default.",
    promptGuidelines: [
      "Use herdr_dispatch with execute=true only after explicit user intent. A root bypasses UI when the project's acknowledged approvalPolicy (herdr_policy) covers this dispatch or retry, or the workflow's legacy BB-029 authorizationPolicy grants it; children remain UI-free and return parentApprovalRequired. On a headless bridge with no native confirm UI, pass confirm=true only after the user has explicitly said to proceed in this exact conversation; never set it speculatively.",
    ],
    parameters: Type.Object({
      workflowId: Type.String(),
      execute: Type.Optional(Type.Boolean()),
      restart: Type.Optional(Type.Boolean()),
      confirm: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await dispatch(
        ctx.cwd,
        params.workflowId,
        params.execute ?? false,
        ctx,
        signal,
        params.restart ?? false,
        params.confirm ?? false,
      );
      return {
        content: [
          {
            type: "text",
            text: result.dryRun
              ? `Dry-run dispatch for ${params.workflowId}`
              : result.parentApprovalRequired
                ? `Parent approval required for ${params.workflowId}; observe the child through Herdr and approve from the designated root.`
                : result.cancelled
                  ? "Dispatch cancelled"
                  : `Dispatched ${params.workflowId}`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_policy",
    label: "Herdr Policy",
    description:
      "Show or acknowledge the project's standing approvalPolicy in .baa-ton/config.json. Once the root acknowledges its hash, routine local dispatch, retry and resume inside it run without a native dialog, and a local-validation grant answers lanes' frozen installs, builds, codegen, typecheck, lint and tests in their own worktrees. Push, merge, deploy, production, close and sweep always ask.",
    promptSnippet: "Show or acknowledge the standing approval policy.",
    promptGuidelines: [
      "Use herdr_policy action=show to inspect the standing approvalPolicy and whether its current hash is acknowledged. Use action=ack only from the root after showing the user the policy summary. On a headless bridge pass confirm=true only after the user has explicitly approved this exact policy in this conversation; never set it speculatively.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("show"), Type.Literal("ack")]),
      confirm: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const result =
        params.action === "ack"
          ? await acknowledgePolicy(ctx.cwd, ctx, params.confirm ?? false, signal)
          : await policyStatus(ctx.cwd);
      const text = !result.configured
        ? "No approvalPolicy is configured in .baa-ton/config.json."
        : !result.valid
          ? `approvalPolicy is invalid and treated as absent: ${result.error}`
          : `${approvalPolicySummary(result.policy, result.hash)}\n${
              "cancelled" in result && result.cancelled
                ? "Acknowledgement cancelled."
                : result.acknowledged
                  ? `Acknowledged${result.ack ? ` at ${result.ack.ackedAt}` : ""}.`
                  : "Not acknowledged: routine operations still ask until the root runs herdr_policy action=ack."
            }`;
      return { content: [{ type: "text", text }], details: result };
    },
  });
  pi.registerTool({
    name: "herdr_lease",
    label: "Herdr Lease",
    description:
      "List, request or release runtime leases (ports, port blocks and service names from runtime.leases in .baa-ton/config.json). Active leases never share a port or name. A lane acts only on its own leases and is granted a free lease immediately when the acknowledged approvalPolicy grants lease; the root may act for any lane it owns.",
    promptSnippet: "List, request or release runtime port and name leases.",
    promptGuidelines: [
      "Use herdr_lease action=list before starting local services, and use only the ports and names leased to your lane. Request more with action=request resource=<name> (label=<name> for a second lease of the same resource). Release leases you no longer need. Never pick ports or database names by hand or negotiate them in chat.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("request"), Type.Literal("release")]),
      resource: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
      workflowId: Type.Optional(Type.String()),
      laneId: Type.Optional(Type.String()),
      leaseId: Type.Optional(Type.String()),
      includeReleased: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await leaseTool(ctx, params);
      let text: string;
      if (result.kind === "list")
        text = result.leases.length
          ? [
              ...leaseLines(result.leases).map(
                (line, index) =>
                  `${result.leases[index].workflowId}/${result.leases[index].laneId}: ${line}${result.leases[index].state === "released" ? " [released]" : ""}`,
              ),
              ...result.conflicts.map((conflict) => `CONFLICT: ${conflict}`),
            ].join("\n")
          : "No leases.";
      else if (result.kind === "granted")
        text = `${result.created ? "Granted" : "Already held"}: ${leaseLines([result.lease])[0]}`;
      else if (result.kind === "refused") text = `Not granted: ${result.reason}`;
      else
        text = result.released
          ? `Released ${result.lease.id}.`
          : `${result.lease.id} was already released.`;
      return { content: [{ type: "text", text }], details: result };
    },
  });
  pi.registerTool({
    name: "herdr_request",
    label: "Herdr Request",
    description:
      "Formal lane requests. A lane opens lease, runtime-launch or approval requests (a Claude lane's permission hook opens permission requests); requests that match the acknowledged approvalPolicy are answered immediately, the rest reach the root digest and stay open until the root answers. The root lists open requests and answers them.",
    promptSnippet: "Open, check, list or answer formal lane requests.",
    promptGuidelines: [
      "A lane uses herdr_request action=open kind=lease|runtime-launch|approval instead of asking in chat; runtime-launch needs the exact command. Check an open request with action=status. The root uses action=list and action=answer decision=grant|deny for every open request it owes an answer.",
      "Under a local-validation grant the root does not ask the user about a lane's frozen install, build, codegen, typecheck, lint or tests in its own worktree; policy answers those. The user still decides package or lockfile edits, shared databases or services, push, merge, deploy and production.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("open"),
        Type.Literal("status"),
        Type.Literal("list"),
        Type.Literal("answer"),
      ]),
      kind: Type.Optional(
        Type.Union([
          Type.Literal("lease"),
          Type.Literal("runtime-launch"),
          Type.Literal("approval"),
          Type.Literal("permission"),
        ]),
      ),
      resource: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
      command: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      toolName: Type.Optional(Type.String()),
      input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      requestId: Type.Optional(Type.String()),
      decision: Type.Optional(Type.Union([Type.Literal("grant"), Type.Literal("deny")])),
      note: Type.Optional(Type.String()),
      includeAnswered: Type.Optional(Type.Boolean()),
      policyOnly: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await requestTool(ctx, params, signal);
      const describe = (request: LaneRequest) =>
        `${request.id} [${request.status}${request.answeredBy ? ` by ${request.answeredBy}` : ""}] ${request.workflowId}/${request.laneId}: ${request.summary}${request.note ? ` (${request.note})` : ""}`;
      const text =
        result.kind === "list"
          ? result.requests.length
            ? result.requests.map(describe).join("\n")
            : "No open lane requests."
          : result.kind === "unmatched"
            ? `No policy match: ${result.reason}`
            : describe(result.request) +
              (result.request.status === "open"
                ? "\nOpen: the root will answer; do not repeat the request in chat."
                : "");
      return { content: [{ type: "text", text }], details: result };
    },
  });
  pi.registerTool({
    name: "herdr_tell",
    label: "Herdr Tell",
    description:
      "Send a durable message from the root to one of its dispatched lanes: an answer, a decision, a correction or a go-ahead. It is typed into the lane now if the lane is idle; while the lane is working or blocked it is queued and the supervisor delivers it when the lane goes idle. Delivery state is recorded in the workflow's laneMessages.",
    promptSnippet: "Message one of your live lanes (answers, decisions, go-aheads).",
    promptGuidelines: [
      "Use herdr_tell to reach a lane you dispatched instead of refusing or asking the operator to type into its pane: answers to its questions, decisions, corrections and go-aheads. Do not use it to hand a lane new authority (push, merge, deploy, production); lane contracts still forbid those.",
      "Answers to herdr_request records reach the lane on their own; use herdr_tell only for anything else.",
    ],
    parameters: Type.Object(
      {
        workflowId: Type.String({ minLength: 1 }),
        laneId: Type.String({ minLength: 1 }),
        text: Type.String({ minLength: 1, maxLength: 4000 }),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      const result = await tellLane(ctx.cwd, params, signal);
      const delivery = result.message.delivery;
      return {
        content: [
          {
            type: "text",
            text: `${result.message.id} to ${params.workflowId}/${params.laneId}: ${
              delivery.status === "delivered"
                ? "delivered"
                : delivery.status === "pending"
                  ? `queued (${delivery.reason}); the supervisor delivers it when the lane is idle`
                  : `delivery uncertain (${delivery.reason}); it will not be retyped, check the lane before resending`
            }.`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_spec",
    label: "Herdr Spec",
    description:
      `Read the project's spec (${SPEC_PATH}) and report progress. status prints one line (spec N/M done plus counts per stage) and a table of item, stage, lane, age and blocker; verify runs the deterministic verifier and lists the first failing check per item. An item is done only when the verifier passes: its evidence report exists with enough images and a recorded hash, its integrated commit is on the target branch, its tests were recorded green at that commit, and its preview specs passed on a release containing it. Read-only.`,
    promptSnippet: "Show spec progress (N/M done) and each item's blocker.",
    promptGuidelines: [
      "Use herdr_spec action=status as the burn-down instead of counting items by hand; an item is done only when the verifier says so, never by judgment.",
    ],
    parameters: Type.Object(
      { action: Type.Union([Type.Literal("status"), Type.Literal("verify"), Type.Literal("advance")]) },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      if (params.action === "advance") {
        // Tests inject fake worktree/plan/dispatch ports through the context.
        const result = await runSpecDriver(ctx, (ctx as { specDriverPorts?: Partial<SpecDriverPorts> }).specDriverPorts, signal);
        const text =
          "skipped" in result
            ? `Spec driver skipped: ${result.skipped}.`
            : [
                result.actions.length ? `Started: ${result.actions.join("; ")}.` : "Nothing to start.",
                ...result.rootAsks.map((ask) => `Needs you: ${ask.reason}`),
                ...Object.entries(result.waits).map(([id, why]) => `${id} waits: ${why}`),
              ].join("\n");
        return { content: [{ type: "text", text }], details: result };
      }
      const spec = await loadSpec(ctx.cwd);
      if (!spec)
        return { content: [{ type: "text", text: `No ${SPEC_PATH} in ${ctx.cwd}.` }], details: { configured: false } };
      const state = await loadSpecState(ctx.cwd);
      const verification = await verifySpec(spec, state, { repo: targetRepo(spec, ctx.cwd) });
      const text =
        params.action === "status"
          ? specStatusTable(spec, state, verification)
          : [
              `${verification.done}/${verification.total} done`,
              ...verification.results
                .filter((result) => !result.done)
                .map((result) => `${result.id}: ${result.failing!.name}: ${result.failing!.detail}`),
            ].join("\n");
      return { content: [{ type: "text", text }], details: { configured: true, verification } };
    },
  });
  pi.registerTool({
    name: "herdr_service",
    label: "Herdr Service",
    description:
      "Register an existing Herdr pane or process as a lane's service so herdr_retire stops it and capacity reports name it while its lane is finished. Use it for stacks started outside a runtime-launch template (by hand in another pane, or in the background). A lane registers its own services; the root registers for lanes it owns. list shows registered services (and, for the root, services still held by finished lanes); release unregisters without stopping.",
    promptSnippet: "Register a lane's dev server, database or other stack so retire stops it.",
    promptGuidelines: [
      "When a lane starts a long-running service outside herdr_request runtime-launch (a dev server in another pane, a database container, a background watcher), register it with herdr_service action=register name=<short name> and paneId or pid, so retiring the lane stops it. Agents and Herdr/Baa-ton processes cannot be registered.",
    ],
    parameters: Type.Object(
      {
        action: Type.Union([Type.Literal("register"), Type.Literal("list"), Type.Literal("release")]),
        workflowId: Type.Optional(Type.String()),
        laneId: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
        paneId: Type.Optional(Type.String()),
        pid: Type.Optional(Type.Integer()),
        serviceId: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      const result = await serviceTool(ctx, params, signal);
      const describeService = (service: LaneService & { workflowId?: string }) =>
        `${service.id} ${service.name} [${service.state}] ${service.workflowId ? `${service.workflowId}/` : ""}${service.laneId}: ${
          service.kind === "pane" ? `pane ${service.paneId}` : `pid ${service.pid}${service.command ? ` (${clip(service.command, 80)})` : ""}`
        }`;
      const text =
        result.kind === "list"
          ? [
              result.services.length ? result.services.map(describeService).join("\n") : "No registered services.",
              describeIdleServices(result.idle),
            ].filter(Boolean).join("\n")
          : describeService(result.service);
      return { content: [{ type: "text", text }], details: result };
    },
  });
  pi.registerTool({
    name: "herdr_retire",
    label: "Herdr Retire",
    description:
      "Retire finished lanes: run the stop command of every runtime template the lane was granted, close the lane's tab (ending its agent session, MCP bridge, LSP and tsserver processes) and release its leases once its services are stopped. Only lanes with a completion receipt or a terminal status qualify, and the session log records the retired session. Dry-run by default. Under an acknowledged approvalPolicy that grants retire this needs no dialog, and it also runs automatically when the root's turn settles for lanes whose completion the root has received.",
    promptSnippet: "Retire finished lanes to free memory; dry-run by default.",
    promptGuidelines: [
      "Use herdr_retire after verifying a lane's completion so its session and services stop holding memory. It never removes a worktree or touches Git. Without a retire grant it asks for confirmation; on a headless bridge pass confirm=true only after the user approved this retirement.",
    ],
    parameters: Type.Object({
      workflowId: Type.String(),
      laneId: Type.Optional(Type.String()),
      execute: Type.Optional(Type.Boolean()),
      confirm: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await retireTool(ctx, params, signal);
      const lines =
        "dryRun" in result
          ? [
              result.candidates.length
                ? `Would retire ${result.candidates.length} lane(s):`
                : "No finished lanes to retire.",
              ...result.candidates.map(
                (candidate) =>
                  `- ${candidate.laneId}: tab ${candidate.tabId ?? "none"}; stop ${
                    candidate.stops.length ? candidate.stops.map((stop) => stop.join(" ")).join(", ") : "nothing"
                  }`,
              ),
            ]
          : "cancelled" in result
            ? ["Retirement cancelled."]
            : result.results.length
              ? result.results.map(
                  (item) =>
                    `- ${item.laneId}: ${item.retirement?.status ?? "skipped (already retiring or sharing a tab)"}${
                      item.retirement?.error ? ` (${item.retirement.error})` : ""
                    }`,
                )
              : ["No finished lanes to retire."];
      return { content: [{ type: "text", text: lines.join("\n") }], details: result };
    },
  });
  pi.registerTool({
    name: "herdr_directive",
    label: "Herdr Directive",
    description:
      "List or acknowledge directives sent to this root by Zach or a supervisor session. A directive stays open until acknowledged; the controller re-sends an unacknowledged one once and then notifies Zach.",
    promptSnippet: "List or acknowledge directives to this root.",
    promptGuidelines: [
      "When a digest carries a directive, acknowledge it with herdr_directive action=ack id=<id> as soon as you accept it (add a short note), then act on it. Use action=list to see directives still open.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("ack")]),
      id: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()),
      includeAcked: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const scope = requireRootManifestExecutor(ctx.cwd);
      const mine = (manifest: ManifestWithQueue) =>
        (manifest.directives ?? []).filter((directive) => directive.rootId === scope.rootId);
      const describe = (directive: RootDirective) =>
        `${directive.id} [${directive.status}${directive.escalatedAt ? ", escalated" : ""}] ${directive.from}: ${directive.text}${directive.ackNote ? ` (ack: ${directive.ackNote})` : ""}`;
      if (params.action === "list") {
        const directives = mine(await loadManifest(ctx.cwd)).filter(
          (directive) => params.includeAcked || directive.status === "open",
        );
        return {
          content: [{ type: "text", text: directives.length ? directives.map(describe).join("\n") : "No open directives." }],
          details: { directives },
        };
      }
      if (!params.id) throw new Error("id is required to acknowledge a directive.");
      const directive = await withManifestTransaction(ctx.cwd, (manifest) => {
        const found = mine(manifest).find((item) => item.id === params.id);
        if (!found) throw new Error(`Unknown directive ${params.id} for this root.`);
        if (found.status === "open") {
          found.status = "acked";
          found.ackedAt = now();
          const note = params.note?.trim();
          if (note) found.ackNote = clip(note, 1000);
        }
        return { ...found };
      });
      return { content: [{ type: "text", text: `Acknowledged ${describe(directive)}` }], details: { directive } };
    },
  });
  pi.registerTool({
    name: "herdr_capacity",
    label: "Herdr Capacity",
    description:
      "Record, inspect or cancel this root's capacity gate. Instead of parking on 'not enough RAM', record the thresholds you are waiting for: the controller samples memory, swap and load on each supervisor tick, puts 'capacity available' in your digest when the gate clears, and notifies Zach with the top memory users if it stays blocked.",
    promptSnippet: "Wait for memory/swap/load capacity without stalling silently.",
    promptGuidelines: [
      "When work must wait for machine capacity, call herdr_capacity action=wait with reason and at least one of minFreeMemoryGb, maxSwapUsedGb, maxLoadPerCpu, then end the turn; a digest tells you when it clears. Retire finished lanes (herdr_retire) first to free memory.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("wait"), Type.Literal("status"), Type.Literal("cancel")]),
      reason: Type.Optional(Type.String()),
      minFreeMemoryGb: Type.Optional(Type.Number({ minimum: 0 })),
      maxSwapUsedGb: Type.Optional(Type.Number({ minimum: 0 })),
      maxLoadPerCpu: Type.Optional(Type.Number({ minimum: 0 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const scope = requireRootManifestExecutor(ctx.cwd);
      const current = await sampleCapacity();
      const describe = (gate?: CapacityGate) =>
        gate
          ? `${gate.id} [${gate.status}] ${gate.reason}: ${[
              gate.minFreeMemoryGb !== undefined ? `free >= ${gate.minFreeMemoryGb} GB` : "",
              gate.maxSwapUsedGb !== undefined ? `swap <= ${gate.maxSwapUsedGb} GB` : "",
              gate.maxLoadPerCpu !== undefined ? `load <= ${gate.maxLoadPerCpu}/CPU` : "",
            ].filter(Boolean).join(", ")}`
          : "No capacity gate.";
      const now_ = `Now: ${JSON.stringify(current)}`;
      const idleLine = async () => {
        const idle = idleLaneServices((await loadManifest(ctx.cwd)).workflows);
        return idle.length ? `\n${describeIdleServices(idle)}` : "";
      };
      if (params.action === "status") {
        const gate = (await loadManifest(ctx.cwd)).rootSupervision?.find((item) => item.rootId === scope.rootId)?.capacityGate;
        return { content: [{ type: "text", text: `${describe(gate)}\n${now_}${await idleLine()}` }], details: { gate, sample: current } };
      }
      const gate = await withManifestTransaction(ctx.cwd, (manifest) => {
        const entries = (manifest.rootSupervision ??= []);
        let entry = entries.find((item) => item.rootId === scope.rootId);
        if (!entry) {
          entry = { rootId: scope.rootId, alerts: [] };
          entries.push(entry);
        }
        if (params.action === "cancel") {
          if (entry.capacityGate?.status === "waiting") {
            entry.capacityGate.status = "cancelled";
            entry.capacityGate.cancelledAt = now();
          }
          return entry.capacityGate;
        }
        if (!params.reason?.trim()) throw new Error("reason is required to wait for capacity.");
        if (
          params.minFreeMemoryGb === undefined &&
          params.maxSwapUsedGb === undefined &&
          params.maxLoadPerCpu === undefined
        )
          throw new Error("Give at least one of minFreeMemoryGb, maxSwapUsedGb or maxLoadPerCpu.");
        entry.capacityGate = {
          id: `capacity-${randomUUID().slice(0, 8)}`,
          status: "waiting",
          reason: clip(params.reason.trim(), 500),
          ...(params.minFreeMemoryGb !== undefined ? { minFreeMemoryGb: params.minFreeMemoryGb } : {}),
          ...(params.maxSwapUsedGb !== undefined ? { maxSwapUsedGb: params.maxSwapUsedGb } : {}),
          ...(params.maxLoadPerCpu !== undefined ? { maxLoadPerCpu: params.maxLoadPerCpu } : {}),
          createdAt: now(),
        };
        return entry.capacityGate;
      });
      return {
        content: [
          {
            type: "text",
            text: `${describe(gate)}\n${now_}${params.action === "wait" ? await idleLine() : ""}${
              params.action === "wait" ? "\nEnd the turn; a digest reports 'capacity available' when the gate clears." : ""
            }`,
          },
        ],
        details: { gate, sample: current },
      };
    },
  });
  pi.registerTool({
    name: "herdr_supersede",
    label: "Herdr Supersede",
    description:
      "Retire a planned workflow that was never dispatched, typically one planned by an earlier root session. It touches no Herdr resources (none were created), marks the workflow and its lanes superseded (terminal), releases any leases and records the reason. herdr_close cannot do this because the lanes never ran.",
    promptSnippet: "Retire an undispatched planned workflow (e.g. from an earlier root session).",
    promptGuidelines: [
      "Use herdr_supersede with a reason for planned workflows you will not dispatch, especially ones the supervisor flags as planned by an earlier root session; re-plan the work with herdr_plan if it is still needed.",
    ],
    parameters: Type.Object({
      workflowId: Type.String(),
      reason: Type.String({ minLength: 1 }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await supersedeWorkflow(ctx.cwd, params.workflowId, params.reason);
      return {
        content: [
          {
            type: "text",
            text: `Superseded ${result.workflow.id}${result.staleRootSession ? " (planned by an earlier root session)" : ""}: ${params.reason.trim()}${
              result.releasedLeases ? `; released ${result.releasedLeases} lease(s)` : ""
            }.`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_observe",
    label: "Herdr Observe",
    description:
      "Read a Herdr lane agent's live state and recent output, then update its manifest.",
    promptSnippet: "Observe a dispatched Herdr workflow.",
    parameters: Type.Object({ workflowId: Type.String() }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await observe(ctx.cwd, params.workflowId, signal);
      return {
        content: [
          {
            type: "text",
            text: `${params.workflowId}: ${result.state}${
              result.messages.length
                ? `; messages to review: ${result.messages
                    .map((message) => `${message.laneId}/${message.summary}`)
                    .join("; ")}`
                : ""
            }`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_resume",
    label: "Herdr Resume",
    description:
      "Preview or explicitly resume a recorded paused Pi goal, or reattach a done/gone lane to its exact native persisted session.",
    promptSnippet:
      "Resume paused Pi goals or natively reattach terminal/gone Herdr lane sessions; dry-run by default.",
    promptGuidelines: [
      "Use herdr_resume after herdr_observe. Pi goal-paused lanes receive /goal-resume; done/gone lanes use only their durable session log and harness-native resume invocation. A root bypasses UI when the project's acknowledged approvalPolicy (herdr_policy) grants resume, or the workflow's legacy BB-029 authorizationPolicy does; children remain UI-free and return parentApprovalRequired.",
    ],
    parameters: Type.Object({
      workflowId: Type.String(),
      execute: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const result: any = await resume(
        ctx.cwd,
        params.workflowId,
        params.execute ?? false,
        ctx,
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: result.dryRun
              ? `Dry-run resume for ${params.workflowId}`
              : result.parentApprovalRequired
                ? `Parent approval required for ${params.workflowId}; the designated root must resume the observed goal through Herdr.`
                : result.cancelled
                  ? "Resume cancelled"
                  : result.resumed
                    ? `Resumed ${result.resumedLanes?.length ?? 0} lane session(s) for ${params.workflowId}`
                    : `Sent /goal-resume to ${result.receipts?.length ?? 0} lane agent(s) for ${params.workflowId}`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_close",
    label: "Herdr Close",
    description:
      "Preview or explicitly close a recorded extension-owned workspace, or root-only retire recorded lane tabs in a task workspace; evidence is mandatory.",
    promptSnippet:
      "Close a Herdr workflow or retire its lane tabs only with evidence; dry-run by default.",
    promptGuidelines: [
      "Use herdr_close only after recording concrete evidence and explicit user intent. Task-workspace lane retirement requires execute=true, a verified root, and every lane terminal; it never closes the workspace.",
      "Ordinary workspace close remains root-confirmed. Child sessions receive a parent-approval-required result only for ordinary close; lane retirement is root-only.",
    ],
    parameters: Type.Object({
      workflowId: Type.String(),
      evidence: Type.Array(Type.String(), { minItems: 1 }),
      execute: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await close(
        ctx.cwd,
        params.workflowId,
        params.evidence,
        params.execute ?? false,
        ctx,
        signal,
      );
      const laneRetirementResult = result as any;
      return {
        content: [
          {
            type: "text",
            text: laneRetirementResult.dryRun
              ? `Dry-run close for ${params.workflowId}`
              : laneRetirementResult.laneRetirement
                ? laneRetirementResult.partialFailure
                  ? `Lane retirement partially completed for ${params.workflowId}; retry the remaining tabs.`
                  : laneRetirementResult.alreadyRetired
                    ? `Lane tabs for ${params.workflowId} are already retired.`
                    : `Retired lane tabs for ${params.workflowId}`
                : laneRetirementResult.parentApprovalRequired
                  ? `Parent approval required for ${params.workflowId}; observe the child through Herdr and approve from the designated root.`
                  : laneRetirementResult.cancelled
                    ? "Close cancelled"
                    : `Closed ${params.workflowId}`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_sweep",
    label: "Herdr Cleanup Sweep",
    description:
      "Root-only cleanup sweep for recorded terminal lane tabs and unopened orphaned Git worktrees; dry-run by default. execute=true confirms via native TUI when available, or via confirm=true after explicit chat approval on a headless root.",
    promptSnippet:
      "Enumerate and, after confirmation, clean terminal lane tabs and unopened worktrees for this root.",
    promptGuidelines: [
      "Use herdr_sweep from the verified controller-mapped root. It is dry-run by default; execute=true presents ctx.ui.confirm with the concrete bounded list on a TUI-capable root, regardless of authorizationPolicy. Never use it to clean another root's resources.",
      "A headless MCP/Codex caller cannot render the native dialog. Pass confirm=true only after showing the exact dry-run inventory in the parent response and getting the user's explicit approval in this exact conversation; never set it speculatively or reuse an earlier approval for a different inventory.",
    ],
    parameters: Type.Object(
      {
        execute: Type.Optional(Type.Boolean()),
        confirm: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      const result = await cleanupSweep(
        ctx.cwd,
        params.execute ?? false,
        ctx,
        signal,
        params.confirm ?? false,
      );
      const details = result as {
        dryRun?: boolean;
        cancelled?: boolean;
        swept?: boolean;
        laneTabs?: CleanupTabCandidate[];
        worktrees?: CleanupWorktreeCandidate[];
        partialFailure?: boolean;
      };
      const tabCount = details.laneTabs?.length ?? 0;
      const worktreeCount = details.worktrees?.length ?? 0;
      return {
        content: [
          {
            type: "text",
            text: details.dryRun
              ? `Dry-run cleanup sweep: ${tabCount} lane tab(s), ${worktreeCount} worktree(s).`
              : details.cancelled
                ? "Cleanup sweep cancelled; no resources were touched."
                : details.partialFailure
                  ? `Cleanup sweep partially completed: ${tabCount} lane tab(s), ${worktreeCount} worktree(s) considered; see errors.`
                  : `Cleanup sweep completed: ${tabCount} lane tab(s), ${worktreeCount} worktree(s) considered.`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_doctor",
    label: "Herdr Doctor",
    description:
      "Idempotent, read-only preflight: extension source, native Herdr connectivity, plugin/routing registration, manifest store version, and the adapter capability matrix. Never mutates anything.",
    promptSnippet:
      "Run a read-only Herdr installation/health preflight before relying on dispatch, goals, or messaging.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const report = await doctor(ctx.cwd, ctx, signal);
      return {
        content: [
          {
            type: "text",
            text: `${report.ok ? "healthy" : "attention required"}: ${report.checks
              .map((entry) => `${entry.id}=${entry.status}`)
              .join(", ")}`,
          },
        ],
        details: report,
      };
    },
  });

  pi.registerCommand("herdr-plan", {
    description: "Create a Herdr workflow plan: /herdr-plan <objective>",
    handler: async (args, ctx) => {
      if (!args.trim()) throw new Error("Usage: /herdr-plan <objective>");
      const workflow = await plan(ctx.cwd, args.trim(), [], undefined, undefined, undefined, undefined, undefined, undefined, ctx);
      ctx.ui.notify(`Planned ${workflow.id}`, "info");
    },
  });
  pi.registerCommand("herdr-dispatch", {
    description:
      "Preview or dispatch: /herdr-dispatch <id> [--execute] [--restart]",
    handler: async (args, ctx) => {
      const [id, ...flags] = args.trim().split(/\s+/);
      if (!id) throw new Error("Usage: /herdr-dispatch <id> [--execute]");
      const result = await dispatch(
        ctx.cwd,
        id,
        flags.includes("--execute"),
        ctx,
        undefined,
        flags.includes("--restart"),
      );
      let message = `Dispatched ${id}`;
      if (result.dryRun) message = `Dry-run: ${id}`;
      else if (result.parentApprovalRequired)
        message = `Parent approval required for ${id}; observe the child through Herdr and approve from the designated root.`;
      else if (result.cancelled) message = "Dispatch cancelled";
      ctx.ui.notify(message, "info");
    },
  });
  pi.registerCommand("herdr-observe", {
    description: "Observe a workflow: /herdr-observe <id>",
    handler: async (args, ctx) => {
      if (!args.trim()) throw new Error("Usage: /herdr-observe <id>");
      const result = await observe(ctx.cwd, args.trim());
      ctx.ui.notify(`${args.trim()}: ${result.state}`, "info");
    },
  });
  pi.registerCommand("herdr-resume", {
    description:
      "Preview or resume paused goals or native sessions: /herdr-resume <id> [--execute]",
    handler: async (args, ctx) => {
      const [id, flag] = args.trim().split(/\s+/);
      if (!id) throw new Error("Usage: /herdr-resume <id> [--execute]");
      const result: any = await resume(ctx.cwd, id, flag === "--execute", ctx);
      let message = `Sent /goal-resume for ${id}`;
      if (result.dryRun) message = `Dry-run: ${id}`;
      if (result.parentApprovalRequired) return;
      if (result.cancelled) message = "Resume cancelled";
      if (result.resumed) message = `Resumed native sessions for ${id}`;
      ctx.ui.notify(message, "info");
    },
  });
  pi.registerCommand("herdr-close", {
    description: "Preview or close: /herdr-close <id> <evidence> [--execute]",
    handler: async (args, ctx) => {
      const execute = args.includes("--execute");
      const [id, ...rest] = args.replace("--execute", "").trim().split(/\s+/);
      const evidence = rest.join(" ");
      if (!id || !evidence)
        throw new Error("Usage: /herdr-close <id> <evidence> [--execute]");
      const result = await close(ctx.cwd, id, [evidence], execute, ctx);
      const laneRetirementResult = result as any;
      let message = `Closed ${id}`;
      if (laneRetirementResult.dryRun) message = `Dry-run: ${id}`;
      else if (laneRetirementResult.laneRetirement)
        message = laneRetirementResult.partialFailure
          ? `Lane retirement partially completed for ${id}; retry the remaining tabs.`
          : laneRetirementResult.alreadyRetired
            ? `Lane tabs for ${id} are already retired.`
            : `Retired lane tabs for ${id}`;
      else if (laneRetirementResult.parentApprovalRequired)
        message = `Parent approval required for ${id}; observe the child through Herdr and approve from the designated root.`;
      else if (laneRetirementResult.cancelled) message = "Close cancelled";
      ctx.ui.notify(message, "info");
    },
  });
}
