#!/usr/bin/env node
/**
 * Herdr Orchestrator durable event controller.
 *
 * This module intentionally uses only Node built-ins. Event hooks call `hook`
 * with HERDR_PLUGIN_EVENT and HERDR_PLUGIN_EVENT_JSON; the state directory is
 * supplied exclusively by Herdr through HERDR_PLUGIN_STATE_DIR.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync, renameSync, statSync } from "node:fs";
import {
  codeChangeWatcher,
  listRuntime,
  pruneRuntime,
  loadedCode,
  recordRuntime,
} from "./code-version.mjs";
export {
  checkoutRoot,
  codeFingerprint,
  gitCommit,
  listRuntime,
  loadedCode,
  recordRuntime,
} from "./code-version.mjs";
import { describeIdleServices, idleLaneServices } from "./lane-services.mjs";
export {
  describeIdleServices,
  idleLaneServices,
  laneBackgroundWork,
  parseProcessTable,
  isHarnessCommand,
  laneFinished,
  paneServiceProcesses,
  parseProcessIdentity,
} from "./lane-services.mjs";
import { promisify } from "node:util";
import { handleActivation } from "./activation.mjs";
import { handleBlockedLane, handleIdleLane, resolveScreenPrompts } from "./blocked-lane.mjs";
import {
  enqueueWakeHint,
  makeEnvelope,
  markDelivery,
  putMessage,
  storePath,
} from "../herdr-tools/inbox/index.mjs";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const OWNER = "herdr-orchestrator";
const CONFIG_NAME = "config.json";
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 10;
const SOCKET_TIMEOUT_MS = 2_500;
const MIN_NUDGE_INTERVAL_SECONDS = 5;
const MAX_NUDGE_INTERVAL_SECONDS = 86_400;
const MAX_DIGEST_WINDOW_SECONDS = 3_600;
const MAX_ESCALATE_MINUTES = 1_440;
const execFileAsync = promisify(execFile);
const MESSAGE_SUMMARY_MAX_LENGTH = 4_000;
const MESSAGE_DETAILS_MAX_LENGTH = 6_000;
// Windows ACLs do not map to Node's POSIX mode bits. Privacy is provided by
// Herdr's per-user plugin directory there; retain the mode check on Unix.
const POSIX_MODE_CHECKS = process.platform !== "win32";
const MESSAGE_DELIVERY_STATUSES = new Set([
  "pending",
  "sending",
  "delivered",
  "uncertain",
]);
const ACTIONABLE_CLASSIFICATIONS = new Set([
  "done",
  "blocked",
  "goal-paused",
]);
const TERMINAL_PARENT_GOAL_STATES = new Set([
  "completed",
  "blocked",
  "paused",
]);
const TERMINAL_WORKFLOW_STATES = new Set([
  "completed",
  "closed",
  "operator-closed",
  "superseded",
]);
const TERMINAL_LANE_STATES = new Set([
  "completion-reported",
  "completed",
  "operator-closed",
  "superseded",
]);
const USER_ACTIONABLE_REQUEST_STATUSES = new Set([
  "parent-question-required",
  "parent-approval-required",
]);
const POST_COMPLETION_STATUSES = new Set([
  "completion-reported",
  "completed",
  "operator-closed",
]);
const POST_COMPLETION_OBSERVATION_STATUSES = new Set(["done", "idle"]);
const QUEUE_SCHEMA_VERSION = 1;
const QUEUE_ITEM_STATES = new Set([
  "pending",
  "dispatched",
  "verified",
  "landed",
  "dropped",
]);
const SUPERVISOR_STATES = new Set(["running", "stopped", "paused"]);
const AGENT_STATUSES = new Set([
  "idle",
  "working",
  "blocked",
  "done",
  "unknown",
]);
const EVENT_NAMES = new Map([
  ["pane.agent_status_changed", "pane_agent_status_changed"],
]);
// Work/ready transitions carry fresh terminal output without making ordinary
// done/blocked wakes depend on Pi-specific reads.
const PI_PAUSE_PROBE_STATUSES = new Set(["idle", "working"]);
const WINDOWS_NAMED_PIPE_PREFIX = "\\\\.\\pipe\\";

export class ControllerError extends Error {
  constructor(message, code = "controller_error") {
    super(message);
    this.name = "ControllerError";
    this.code = code;
  }
}

class HerdrApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HerdrApiError";
    this.code = code;
  }
}

const now = () => new Date().toISOString();
const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sleep = (ms) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function assert(condition, message, code = "invalid") {
  if (!condition) throw new ControllerError(message, code);
}

function assertString(value, label) {
  assert(
    typeof value === "string" && value.length > 0,
    `${label} must be a non-empty string.`,
  );
  return value;
}

function assertNullableString(value, label) {
  assert(
    value === null || typeof value === "string",
    `${label} must be a string or null.`,
  );
  return value;
}

function assertSafeUInt(value, label) {
  assert(
    Number.isSafeInteger(value) && value >= 0,
    `${label} must be a non-negative safe integer.`,
  );
  return value;
}

function assertObjectShape(value, label, required, optional = []) {
  assert(isRecord(value), `${label} must be an object.`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value))
    assert(allowed.has(key), `${label}.${key} is not allowed.`);
  for (const key of required)
    assert(key in value, `${label}.${key} is required.`);
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireStateDir(stateDir = process.env.HERDR_PLUGIN_STATE_DIR) {
  assertString(stateDir, "HERDR_PLUGIN_STATE_DIR");
  assert(isAbsolute(stateDir), "HERDR_PLUGIN_STATE_DIR must be absolute.");
  return resolve(stateDir);
}

function isHerdrSocketPath(path) {
  return (
    isAbsolute(path) ||
    (path.toLowerCase().startsWith(WINDOWS_NAMED_PIPE_PREFIX) &&
      path.length > WINDOWS_NAMED_PIPE_PREFIX.length)
  );
}

/** Herdr's Windows socket environment value names a marker file. The server
 * exposes the same value as a named pipe, so raw Node clients must enter the
 * `\\\\.\\pipe\\` namespace instead of opening the marker file directly. */
export function herdrSocketEndpoint(socketPath, platform = process.platform) {
  if (platform !== "win32") return socketPath;
  if (socketPath.toLowerCase().startsWith(WINDOWS_NAMED_PIPE_PREFIX))
    return socketPath;
  return `${WINDOWS_NAMED_PIPE_PREFIX}${socketPath}`;
}

async function readRegularFile(path, label) {
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT")
      throw new ControllerError(`${label} is missing: ${path}`, "missing");
    throw error;
  }
  assert(details.isFile(), `${label} must be a regular file: ${path}`);
  return readFile(path, "utf8");
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ControllerError(
      `${label} is not valid JSON: ${error.message}`,
      "invalid_json",
    );
  }
}

const TARGET_KINDS = new Set(["name", "pane_id"]);

function validateTarget(value, label, paneId) {
  const target = assertString(value.target, `${label}.target`);
  const targetKind = assertString(value.target_kind, `${label}.target_kind`);
  assert(
    TARGET_KINDS.has(targetKind),
    `${label}.target_kind must be name or pane_id.`,
  );
  if (targetKind === "pane_id") {
    assert(
      target === paneId,
      `${label}.target must equal ${label}.pane_id when target_kind is pane_id.`,
    );
  }
  return { target, target_kind: targetKind };
}

function validateRoot(root) {
  const value = assertObjectShape(
    root,
    "config.root",
    ["target", "target_kind", "pane_id", "workspace_id"],
    ["agent_kind"],
  );
  const paneId = assertString(value.pane_id, "config.root.pane_id");
  const target = validateTarget(value, "config.root", paneId);
  const agentKind =
    "agent_kind" in value
      ? assertString(value.agent_kind, "config.root.agent_kind")
      : undefined;
  const normalized = {
    ...target,
    pane_id: paneId,
    workspace_id: assertString(value.workspace_id, "config.root.workspace_id"),
  };
  return agentKind === undefined
    ? normalized
    : { ...normalized, agent_kind: agentKind };
}

function validateLane(lane, index) {
  const label = `config.workflows[].lanes[${index}]`;
  const value = assertObjectShape(
    lane,
    label,
    ["lane_id", "target", "target_kind", "pane_id", "workspace_id"],
    ["relationship_id"],
  );
  const paneId = assertString(value.pane_id, `${label}.pane_id`);
  return {
    lane_id: assertString(value.lane_id, `${label}.lane_id`),
    ...validateTarget(value, label, paneId),
    pane_id: paneId,
    workspace_id: assertString(value.workspace_id, `${label}.workspace_id`),
    ...(typeof value.relationship_id === "string"
      ? {
          relationship_id: assertString(
            value.relationship_id,
            `${label}.relationship_id`,
          ),
        }
      : {}),
  };
}

function validateWorkflowMapping(workflow, index) {
  const value = assertObjectShape(
    workflow,
    `config.workflows[${index}]`,
    ["workflow_id", "manifest_path", "lanes"],
    ["pi_goal_pause_detection"],
  );
  const manifestPath = assertString(
    value.manifest_path,
    `config.workflows[${index}].manifest_path`,
  );
  assert(
    isAbsolute(manifestPath),
    `config.workflows[${index}].manifest_path must be absolute.`,
  );
  assert(
    Array.isArray(value.lanes) && value.lanes.length > 0,
    `config.workflows[${index}].lanes must be a non-empty array.`,
  );
  const piGoalPauseDetection = value.pi_goal_pause_detection ?? false;
  assert(
    typeof piGoalPauseDetection === "boolean",
    `config.workflows[${index}].pi_goal_pause_detection must be a boolean when present.`,
  );
  const lanes = value.lanes.map(validateLane);
  assert(
    new Set(lanes.map((lane) => lane.lane_id)).size === lanes.length,
    "A workflow mapping cannot repeat lane_id values.",
  );
  assert(
    new Set(lanes.map((lane) => lane.pane_id)).size === lanes.length,
    "A workflow mapping cannot repeat pane_id values.",
  );
  assert(
    new Set(lanes.map((lane) => `${lane.target_kind}:${lane.target}`)).size ===
      lanes.length,
    "A workflow mapping cannot repeat target values.",
  );
  return {
    workflow_id: assertString(
      value.workflow_id,
      `config.workflows[${index}].workflow_id`,
    ),
    manifest_path: resolve(manifestPath),
    pi_goal_pause_detection: piGoalPauseDetection,
    lanes,
  };
}

export function validateOrchestrator(input, index) {
  const label = `config.orchestrators[${index}]`;
  const value = assertObjectShape(input, label, [
    "id",
    "root",
    "program",
    "workflows",
  ]);
  const root = validateRoot(value.root);
  const program = assertObjectShape(
    value.program,
    `${label}.program`,
    ["id", "workspace_id"],
    [
      "parent_manifest_path",
      "digest_window_seconds",
      "directive_escalate_minutes",
      "capacity_escalate_minutes",
      "watchdog_minutes",
    ],
  );
  for (const key of ["directive_escalate_minutes", "capacity_escalate_minutes", "watchdog_minutes"])
    if (key in program)
      assert(
        Number.isSafeInteger(program[key]) && program[key] >= 1 && program[key] <= MAX_ESCALATE_MINUTES,
        `${label}.program.${key} must be an integer from 1 to ${MAX_ESCALATE_MINUTES}.`,
      );
  if ("digest_window_seconds" in program)
    assert(
      Number.isSafeInteger(program.digest_window_seconds) &&
        program.digest_window_seconds >= 0 &&
        program.digest_window_seconds <= MAX_DIGEST_WINDOW_SECONDS,
      `${label}.program.digest_window_seconds must be an integer from 0 to ${MAX_DIGEST_WINDOW_SECONDS}.`,
    );
  assert(
    Array.isArray(value.workflows),
    `${label}.workflows must be an array.`,
  );
  const workflows = value.workflows.map(validateWorkflowMapping);
  assertString(value.id, `${label}.id`);
  assertString(program.id, `${label}.program.id`);
  assertString(program.workspace_id, `${label}.program.workspace_id`);
  const parentManifestPath =
    "parent_manifest_path" in program
      ? assertString(
          program.parent_manifest_path,
          `${label}.program.parent_manifest_path`,
        )
      : undefined;
  if (parentManifestPath)
    assert(
      isAbsolute(parentManifestPath),
      `${label}.program.parent_manifest_path must be absolute.`,
    );
  assert(
    program.workspace_id === root.workspace_id,
    `${label}.program.workspace_id must equal its root workspace_id.`,
  );
  for (const workflow of workflows)
    for (const lane of workflow.lanes) {
      assert(
        lane.pane_id !== root.pane_id,
        `${label}.root.pane_id must differ from every child lane pane_id.`,
      );
      assert(
        lane.target_kind !== root.target_kind || lane.target !== root.target,
        `${label}.root target must differ from every child lane target.`,
      );
    }
  return {
    id: value.id,
    root,
    program: {
      id: program.id,
      workspace_id: program.workspace_id,
      ...(parentManifestPath
        ? { parent_manifest_path: resolve(parentManifestPath) }
        : {}),
      ...("digest_window_seconds" in program
        ? { digest_window_seconds: program.digest_window_seconds }
        : {}),
      ...Object.fromEntries(
        ["directive_escalate_minutes", "capacity_escalate_minutes", "watchdog_minutes"]
          .filter((key) => key in program)
          .map((key) => [key, program[key]]),
      ),
    },
    workflows,
  };
}

// v1 had one global root.  It is accepted only as an in-memory migration so a
// subsequent extension registration can atomically persist v2 without a
// service interruption.
export function validateConfig(input) {
  assert(isRecord(input), "config must be an object.");
  assert(input.owner === OWNER, `config.owner must be ${OWNER}.`);
  if (input.version === 1) {
    const legacy = assertObjectShape(input, "config", [
      "version",
      "owner",
      "root",
      "workflows",
    ]);
    const root = validateRoot(legacy.root);
    const workflows = legacy.workflows.map(validateWorkflowMapping);
    assert(
      Array.isArray(legacy.workflows) && workflows.length > 0,
      "config.workflows must be a non-empty array.",
    );
    return {
      version: 2,
      owner: OWNER,
      migratedFrom: 1,
      orchestrators: [
        {
          id: `legacy:${root.workspace_id}:${root.pane_id}`,
          root,
          program: { id: "legacy-global", workspace_id: root.workspace_id },
          workflows,
        },
      ],
    };
  }
  const value = assertObjectShape(input, "config", [
    "version",
    "owner",
    "orchestrators",
  ]);
  assert(value.version === 2, "config.version must be 1 or 2.");
  assert(
    Array.isArray(value.orchestrators) && value.orchestrators.length > 0,
    "config.orchestrators must be a non-empty array.",
  );
  const orchestrators = value.orchestrators.map(validateOrchestrator);
  assert(
    new Set(orchestrators.map((item) => item.id)).size === orchestrators.length,
    "config cannot repeat orchestrator IDs.",
  );
  // Workflow IDs are scoped to an orchestrator; isolated roots may use the
  // same ID because their manifest paths and pane routes remain distinct.
  for (const orchestrator of orchestrators) {
    const workflowIds = orchestrator.workflows.map(
      (workflow) => workflow.workflow_id,
    );
    assert(
      new Set(workflowIds).size === workflowIds.length,
      "config cannot repeat workflow_id values within an orchestrator.",
    );
  }
  return { version: 2, owner: OWNER, orchestrators };
}

export async function loadConfig(configDir) {
  assertString(configDir, "HERDR_PLUGIN_CONFIG_DIR");
  assert(isAbsolute(configDir), "HERDR_PLUGIN_CONFIG_DIR must be absolute.");
  const directory = resolve(configDir);
  const directoryDetails = await lstat(directory).catch((error) => {
    if (error.code === "ENOENT")
      throw new ControllerError(
        `Controller config directory is missing: ${directory}`,
        "missing_config_directory",
      );
    throw error;
  });
  assert(
    directoryDetails.isDirectory() && !directoryDetails.isSymbolicLink(),
    `Controller config directory must be a real directory: ${directory}`,
  );
  const path = join(directory, CONFIG_NAME);
  const details = await lstat(path).catch((error) => {
    if (error.code === "ENOENT")
      throw new ControllerError(
        `Controller config is missing: ${path}`,
        "missing_config",
      );
    throw error;
  });
  assert(details.isFile(), `Controller config must be a regular file: ${path}`);
  assert(
    !POSIX_MODE_CHECKS || (details.mode & 0o022) === 0,
    `Controller config must not be group- or world-writable: ${path}`,
  );
  return validateConfig(
    parseJson(
      await readRegularFile(path, "Controller config"),
      "Controller config",
    ),
  );
}

export function validateHookEnvelope(eventName, envelope) {
  const wireEvent = EVENT_NAMES.get(eventName);
  assert(
    wireEvent,
    `Unsupported plugin event hook: ${eventName}.`,
    "unsupported_event",
  );
  const outer = assertObjectShape(envelope, "event", ["event", "data"]);
  assert(outer.event === wireEvent, `event.event must be ${wireEvent}.`);
  const data = isRecord(outer.data)
    ? outer.data
    : (() => {
        throw new ControllerError("event.data must be an object.");
      })();
  if (eventName === "pane.agent_status_changed") {
    const value = assertObjectShape(
      data,
      "event.data",
      ["type", "pane_id", "workspace_id", "agent_status"],
      ["agent", "display_agent", "state_labels", "title"],
    );
    assert(value.type === wireEvent, `event.data.type must be ${wireEvent}.`);
    assert(
      AGENT_STATUSES.has(value.agent_status),
      "event.data.agent_status is not a supported agent status.",
    );
    if ("agent" in value) assertNullableString(value.agent, "event.data.agent");
    if ("display_agent" in value)
      assertNullableString(value.display_agent, "event.data.display_agent");
    if ("title" in value) assertNullableString(value.title, "event.data.title");
    if ("state_labels" in value) {
      assert(
        isRecord(value.state_labels),
        "event.data.state_labels must be an object.",
      );
      for (const [key, label] of Object.entries(value.state_labels)) {
        assertString(key, "event.data.state_labels key");
        assertString(label, `event.data.state_labels.${key}`);
      }
    }
    const normalized = {
      type: wireEvent,
      pane_id: assertString(value.pane_id, "event.data.pane_id"),
      workspace_id: assertString(value.workspace_id, "event.data.workspace_id"),
      agent_status: value.agent_status,
    };
    if ("agent" in value) normalized.agent = value.agent;
    return { event: eventName, data: normalized };
  }
  const value = assertObjectShape(data, "event.data", [
    "type",
    "pane_id",
    "workspace_id",
    "revision",
  ]);
  assert(value.type === wireEvent, `event.data.type must be ${wireEvent}.`);
  return {
    event: eventName,
    data: {
      type: wireEvent,
      pane_id: assertString(value.pane_id, "event.data.pane_id"),
      workspace_id: assertString(value.workspace_id, "event.data.workspace_id"),
      revision: assertSafeUInt(value.revision, "event.data.revision"),
    },
  };
}

function configuredMappings(config) {
  return config.orchestrators.flatMap((orchestrator) =>
    orchestrator.workflows.map((workflow) => ({ orchestrator, workflow })),
  );
}

const DEFAULT_NUDGE_INTERVAL_SECONDS = 300;
const NUDGE_INTERVAL_POLICY = 2;
const QUIET_PARENT_GOAL_STATUSES = new Set(["completed", "paused"]);

/**
 * Remove the short-lived `supervisor.intervalPolicy` key (#28) from every
 * goal copy in the manifest. Bridges loaded from releases before #28 validate
 * parent goals with a strict key allowlist and reject it, which broke
 * herdr_message and herdr_complete for lanes dispatched before an upgrade.
 * Returns whether any copy carried the new policy (2), so the marker can move
 * to rootSupervision.
 */
export function stripSupervisorIntervalPolicy(manifest) {
  let found = false;
  let changed = false;
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "supervisor" && isRecord(child) && "intervalPolicy" in child) {
        if (child.intervalPolicy === NUDGE_INTERVAL_POLICY) found = true;
        delete child.intervalPolicy;
        changed = true;
      }
      visit(child);
    }
  };
  for (const key of ["parentGoal", "parentGoals", "goalHistory", "goalHistoryByRoot"]) visit(manifest[key]);
  return { changed, found };
}

/**
 * One-time upgrade for goals written before the repeating nudge: an interval
 * above the 300 s default is lowered to it. The marker lives in this root's
 * rootSupervision entry (`nudgeIntervalPolicy: 2`), never in the strictly
 * validated supervisor, so goals the extension marked keep their chosen
 * interval. Pre-#28 extensions drop unknown top-level keys when they save,
 * so a lost marker at worst re-caps an interval chosen above 300 s.
 */
function upgradeNudgeInterval(manifest, orchestrator, supervisor, timestamp) {
  const entry = supervisionFor(manifest, orchestrator);
  if (entry?.nudgeIntervalPolicy === NUDGE_INTERVAL_POLICY) return false;
  supervisionFor(manifest, orchestrator, true).nudgeIntervalPolicy = NUDGE_INTERVAL_POLICY;
  if (supervisor.intervalSeconds > DEFAULT_NUDGE_INTERVAL_SECONDS) {
    supervisor.intervalSeconds = DEFAULT_NUDGE_INTERVAL_SECONDS;
    const capped = nextNudgeAt(timestamp, DEFAULT_NUDGE_INTERVAL_SECONDS);
    if (supervisor.nextNudgeAt && Date.parse(supervisor.nextNudgeAt) > Date.parse(capped))
      supervisor.nextNudgeAt = capped;
  }
  supervisor.updatedAt = timestamp;
  return true;
}

function latestLaneStatus(workflow, laneId) {
  const events = Array.isArray(workflow?.eventController?.events) ? workflow.eventController.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1)
    if (events[index].lane_id === laneId) return events[index].source?.agent_status;
  return undefined;
}

/** Mirrors the extension: a planned workflow bound to a root session other
 * than the one this root's session log records as current. */
function plannedByEarlierRootSession(manifest, workflow, rootId) {
  const bound = workflow.taskBinding?.rootSessionPath;
  const logs = Array.isArray(manifest.rootSessionLogs) ? manifest.rootSessionLogs : [];
  const current = logs.find((entry) => isRecord(entry) && entry.rootId === rootId) ?? manifest.sessionLog;
  const ref = isRecord(current) ? current.sessionRef : undefined;
  if (typeof bound !== "string" || !isRecord(ref)) return false;
  const known = [
    ref.sessionId,
    isRecord(ref.metadata) ? ref.metadata.sessionPath : undefined,
    isRecord(ref.nativeHandle) ? ref.nativeHandle.value : undefined,
  ].filter((value) => typeof value === "string");
  return known.length > 0 && !known.includes(bound);
}

/** Questions or approvals Zach still owes an answer on, for this root. */
function pendingForUser(manifest, owned) {
  const questions = [
    ...(Array.isArray(manifest.questionRequests) ? manifest.questionRequests : []),
    ...owned.flatMap((workflow) => (Array.isArray(workflow.questionRequests) ? workflow.questionRequests : [])),
  ].filter((request) => isRecord(request) && request.status === "parent-question-required");
  const approvals = owned
    .flatMap((workflow) => (Array.isArray(workflow.approvalRequests) ? workflow.approvalRequests : []))
    .filter((request) => isRecord(request) && request.status === "parent-approval-required");
  return [...questions.map((request) => request.id), ...approvals.map((request) => request.id)];
}

/**
 * Whether the supervisor should nudge this root, and why. Quiet for
 * completed and paused goals, and for action-required while Zach owes an
 * answer. Otherwise it nudges only when there is actionable work, and the
 * reasons name it.
 */
export function nudgeDecision({ goal, manifest, orchestrator, manifestPath, run }) {
  if (run?.state === "paused") return { quiet: "run-paused" };
  if (QUIET_PARENT_GOAL_STATUSES.has(goal.status)) return { quiet: `goal-${goal.status}` };
  const routes = orchestrator.workflows.filter(
    (route) => resolve(route.manifest_path) === resolve(manifestPath),
  );
  const routedIds = new Set(routes.map((route) => route.workflow_id));
  const owned = (Array.isArray(manifest.workflows) ? manifest.workflows : []).filter(
    (workflow) =>
      isRecord(workflow) &&
      (routedIds.has(workflow.id) ||
        (workflow.taskBinding?.rootPaneId === orchestrator.root.pane_id &&
          workflow.taskBinding?.workspaceId === orchestrator.root.workspace_id)),
  );
  const awaitingUser = pendingForUser(manifest, owned);
  if (goal.status === "action-required" && awaitingUser.length)
    return { quiet: "awaiting-user", awaitingUser };
  const reasons = [];
  for (const workflow of owned) {
    for (const request of Array.isArray(workflow.laneRequests) ? workflow.laneRequests : []) {
      if (!isRecord(request) || request.status !== "open") continue;
      const status = latestLaneStatus(workflow, request.laneId);
      // A permission request is filed by the lane's PermissionRequest hook,
      // which holds the tool call while it waits, so Herdr can report the
      // lane as working even though it is stopped on the root's answer.
      if (status === "working" && request.kind !== "permission") continue;
      reasons.push(
        `lane ${workflow.id}/${request.laneId} (${status ?? "status unknown"}) waits on ${request.kind === "lease" ? "lease ask" : request.kind === "permission" ? "permission" : "request"} ${request.id}: ${clipText(request.summary ?? request.kind, 160)}`,
      );
    }
    for (const message of Array.isArray(workflow.messageRequests) ? workflow.messageRequests : []) {
      const status = message?.delivery?.status ?? "pending";
      if (status === "pending" || status === "uncertain")
        reasons.push(`child message ${message.id} from ${workflow.id}/${message.laneId} is ${status === "pending" ? "unread" : "possibly unseen"}: ${clipText(message.summary ?? "", 160)}`);
    }
    if (workflow.status === "planned")
      reasons.push(
        plannedByEarlierRootSession(manifest, workflow, orchestrator.id)
          ? `workflow ${workflow.id} was planned by an earlier root session and cannot be dispatched as is; retire it with herdr_supersede (or re-plan it)`
          : `workflow ${workflow.id} is planned but not dispatched`,
      );
  }
  try {
    const pendingQueue = (queueStore(manifest)?.items ?? []).filter((item) => item.state === "pending");
    if (pendingQueue.length)
      reasons.push(`queue items waiting: ${pendingQueue.slice(0, 5).map((item) => item.id).join(", ")}${pendingQueue.length > 5 ? ` (+${pendingQueue.length - 5})` : ""}`);
  } catch {
    // A malformed queue is reported by its own readers; it is not a reason to nudge.
  }
  for (const directive of openDirectives(manifest, orchestrator))
    reasons.push(`directive ${directive.id} from ${directive.from} is open: ${clipText(directive.text, 160)}`);
  // Spec items waiting with no lane working: the loop has stalled, whatever
  // the goal says (a root that believes it is paused is exactly this case).
  const liveLanes = owned.flatMap((workflow) =>
    (Array.isArray(workflow.lanes) ? workflow.lanes : [])
      .filter((lane) => isRecord(lane) && !lane.completionReceipt && !["completed", "closed", "operator-closed", "superseded", "retired"].includes(workflow.status))
      .map((lane) => latestLaneStatus(workflow, lane.id))
      .filter((status) => status === "working" || status === "blocked"),
  );
  let specStall = false;
  if (!liveLanes.length && !awaitingUser.length) {
    const waiting = specWaiting(manifestPath);
    if (waiting.size) {
      specStall = true;
      const total = [...waiting.values()].reduce((sum, count) => sum + count, 0);
      reasons.push(
        `spec: ${total} item(s) are waiting (${[...waiting].map(([stage, count]) => `${stage}: ${count}`).join(", ")}) and no lane is working. The run state is ${run?.state ?? "running"}: advance them now (herdr_spec status names the next action).`,
      );
    }
  }
  // A wait on an event only holds while someone can send it: with no lane
  // working or blocked (and nobody owing an answer), the wait is a stall.
  if ((goal.status === "waiting-for-event" || goal.status === "blocked") && !awaitingUser.length && !reasons.length) {
    const live = owned.flatMap((workflow) =>
      (Array.isArray(workflow.lanes) ? workflow.lanes : [])
        .filter((lane) => isRecord(lane) && !lane.completionReceipt && !["completed", "closed", "operator-closed", "superseded", "retired"].includes(workflow.status))
        .map((lane) => latestLaneStatus(workflow, lane.id))
        .filter((status) => status === "working" || status === "blocked"),
    );
    if (!live.length)
      reasons.push(
        `parent goal ${goal.id} is ${goal.status}, but no lane is working or blocked, so nothing will change on its own: this is no progress, not a wait. Take the next action (herdr_spec status names it), reclaim or retire what is stale, or record a truthful state (action-required only while the user owes an answer)`,
      );
  }
  if (!reasons.length) return { quiet: "no-actionable-work", awaitingUser };
  return { reasons, awaitingUser, ...(specStall ? { specStall } : {}) };
}

const SUPERVISOR_DIAGNOSTICS_NAME = "supervisor-diagnostics.json";
const MAX_SUPERVISOR_DIAGNOSTICS = 50;
const DIAGNOSTIC_REFRESH_MS = 60_000;

/**
 * Record one skipped manifest in <stateDir>/supervisor-diagnostics.json so
 * the skip is visible even when supervisor stderr is not captured. Entries
 * are keyed by orchestrator, manifest, stage and error; a repeat refreshes
 * `lastAt` at most once a minute. Never throws.
 */
async function recordManifestSkip(stateDir, { orchestrator, manifestPath, stage, error, timestamp }) {
  const message = clipText(String(error?.message ?? error), 500);
  const code = typeof error?.code === "string" ? error.code : undefined;
  const skip = { manifestPath, status: "skipped", stage, error: message, ...(code ? { code } : {}) };
  if (!stateDir) return skip;
  try {
    const path = join(stateDir, SUPERVISOR_DIAGNOSTICS_NAME);
    let stored = { version: 1, skips: [] };
    try {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      if (isRecord(parsed) && Array.isArray(parsed.skips)) stored = parsed;
    } catch {
      // Missing or unreadable diagnostics start fresh.
    }
    const key = [orchestrator.id, manifestPath, stage, message].join("\n");
    const existing = stored.skips.find((item) => item.key === key);
    if (existing) {
      if (Date.parse(timestamp) - Date.parse(existing.lastAt) < DIAGNOSTIC_REFRESH_MS) return skip;
      existing.lastAt = timestamp;
    } else {
      stored.skips.push({
        key,
        orchestratorId: orchestrator.id,
        manifestPath,
        stage,
        error: message,
        ...(code ? { code } : {}),
        firstAt: timestamp,
        lastAt: timestamp,
      });
      if (stored.skips.length > MAX_SUPERVISOR_DIAGNOSTICS)
        stored.skips.splice(0, stored.skips.length - MAX_SUPERVISOR_DIAGNOSTICS);
    }
    const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch {
    // Diagnostics are best effort; the skip is still in the tick result.
  }
  return skip;
}

function configuredParentManifests(config) {
  return config.orchestrators.flatMap((orchestrator) => {
    const paths = new Set(
      orchestrator.workflows.map((workflow) => workflow.manifest_path),
    );
    if (orchestrator.program.parent_manifest_path)
      paths.add(orchestrator.program.parent_manifest_path);
    return [...paths].map((manifestPath) => ({
      orchestrator,
      manifestPath,
      workflows: orchestrator.workflows.filter(
        (workflow) => workflow.manifest_path === manifestPath,
      ),
    }));
  });
}

function manifestHasMultipleRoots(config, manifestPath) {
  const normalized = resolve(manifestPath);
  return configuredParentManifests(config).filter(
    (entry) => resolve(entry.manifestPath) === normalized,
  ).length > 1;
}

function recordBelongsToRoutes(record, routes) {
  return routes.some(
    (route) =>
      route.workflow_id === record.workflow_id &&
      route.lanes.some(
        (lane) =>
          lane.lane_id === record.lane_id &&
          lane.pane_id === record.pane_id &&
          lane.workspace_id === record.workspace_id,
      ),
  );
}

function locateMapping(config, event) {
  const matches = [];
  for (const orchestrator of config.orchestrators) {
    for (const workflow of orchestrator.workflows) {
      for (const lane of workflow.lanes) {
        if (
          lane.pane_id === event.data.pane_id &&
          lane.workspace_id === event.data.workspace_id
        ) {
          // Protocol 22 event.data.agent is an agent *kind* (for example pi),
          // never the configured Herdr agent name/prompt target.
          matches.push({ orchestrator, workflow, lane });
        }
      }
    }
  }
  if (matches.length === 0) return undefined;
  assert(
    matches.length === 1,
    "Event matches multiple explicit owner/workflow/child-lane mappings.",
    "ambiguous_mapping",
  );
  return matches[0];
}

function validateMessageRecord(value, label) {
  const message = assertObjectShape(
    value,
    label,
    [
      "version",
      "id",
      "workflowId",
      "laneId",
      "summary",
      "kind",
      "requestedAt",
      "delivery",
    ],
    ["details"],
  );
  assert(message.version === 1, `${label}.version must be 1.`);
  for (const key of ["id", "workflowId", "laneId", "summary", "requestedAt"])
    assertString(message[key], `${label}.${key}`);
  assert(
    message.summary.length <= MESSAGE_SUMMARY_MAX_LENGTH,
    `${label}.summary is too long.`,
  );
  assert(message.kind === "informational", `${label}.kind must be informational.`);
  if ("details" in message) {
    assert(
      typeof message.details === "string" &&
        message.details.length <= MESSAGE_DETAILS_MAX_LENGTH,
      `${label}.details is invalid.`,
    );
  }
  const delivery = assertObjectShape(
    message.delivery,
    `${label}.delivery`,
    ["status", "attempts", "updatedAt"],
    ["reason"],
  );
  assert(
    MESSAGE_DELIVERY_STATUSES.has(delivery.status),
    `${label}.delivery.status is invalid.`,
  );
  assertSafeUInt(delivery.attempts, `${label}.delivery.attempts`);
  assertString(delivery.updatedAt, `${label}.delivery.updatedAt`);
  if ("reason" in delivery)
    assertString(delivery.reason, `${label}.delivery.reason`);
  return message;
}

function validateMappedWorkflow(manifest, mapping, owner) {
  assert(isRecord(manifest), "Workflow manifest must be an object.");
  assert(
    Array.isArray(manifest.workflows),
    "Workflow manifest must contain workflows.",
  );
  const workflows = manifest.workflows.filter(
    (workflow) =>
      isRecord(workflow) && workflow.id === mapping.workflow.workflow_id,
  );
  assert(
    workflows.length === 1,
    "Manifest does not contain exactly one mapped workflow.",
    "invalid_mapping",
  );
  const workflow = workflows[0];
  assert(
    isRecord(workflow.ownership) && workflow.ownership.createdBy === owner,
    "Manifest workflow is not owned by the configured orchestrator.",
    "invalid_mapping",
  );
  assert(
    Array.isArray(workflow.lanes),
    "Mapped workflow has no lanes.",
    "invalid_mapping",
  );
  const lanes = workflow.lanes.filter(
    (lane) => isRecord(lane) && lane.id === mapping.lane.lane_id,
  );
  assert(
    lanes.length === 1,
    "Manifest does not contain exactly one configured child lane.",
    "invalid_mapping",
  );
  const lane = lanes[0];
  assert(
    lane.paneId === mapping.lane.pane_id,
    "Manifest lane pane ID differs from the explicit mapping.",
    "invalid_mapping",
  );
  if ("messageRequests" in workflow) {
    assert(
      Array.isArray(workflow.messageRequests),
      "Mapped workflow messageRequests must be an array.",
      "invalid_mapping",
    );
    workflow.messageRequests.forEach((message, index) =>
      validateMessageRecord(message, `workflow.messageRequests[${index}]`),
    );
  }
  // Manifest ownership and pane identity are authoritative. Agent names/kinds
  // are live Herdr metadata, not event-mapping identity.
  return workflow;
}

function validateParentGoal(goal) {
  const value = assertObjectShape(
    goal,
    "manifest.parentGoal",
    [
      "version",
      "id",
      "objective",
      "status",
      "nextAction",
      "signals",
      "createdAt",
      "updatedAt",
    ],
    [
      "supervisor",
      "root",
      "rootIdentity",
      "rootId",
      "root_id",
      "orchestratorId",
      "orchestrator_id",
      "scope",
      "paneId",
      "pane_id",
      "workspaceId",
      "workspace_id",
    ],
  );
  assert(value.version === 1, "manifest.parentGoal.version must be 1.");
  for (const key of [
    "id",
    "objective",
    "status",
    "nextAction",
    "createdAt",
    "updatedAt",
  ])
    assertString(value[key], `manifest.parentGoal.${key}`);
  assert(
    Array.isArray(value.signals),
    "manifest.parentGoal.signals must be an array.",
  );
  for (const signal of value.signals) {
    assert(isRecord(signal), "manifest.parentGoal contains an invalid signal.");
    for (const key of [
      "identity",
      "workflowId",
      "laneId",
      "classification",
      "receivedAt",
    ])
      assertString(signal[key], `manifest.parentGoal.signals[].${key}`);
    assert(
      ACTIONABLE_CLASSIFICATIONS.has(signal.classification),
      "manifest.parentGoal signal classification is invalid.",
    );
  }
  if ("supervisor" in value) validateSupervisor(value.supervisor);
  return value;
}

function validateSupervisor(supervisor) {
  const value = assertObjectShape(
    supervisor,
    "manifest.parentGoal.supervisor",
    [
      "version",
      "state",
      "intervalSeconds",
      "nudgeCount",
      "nextNudgeAt",
      "createdAt",
      "updatedAt",
    ],
    [
      "pauseReason",
      "lastNudgeAt",
      "lastAttemptAt",
      "lastDelivery",
      "rootActivity",
      "rootTurn",
      "intervalPolicy",
    ],
  );
  assert(
    value.version === 1,
    "manifest.parentGoal.supervisor.version must be 1.",
  );
  if ("intervalPolicy" in value)
    assert(value.intervalPolicy === 2, "manifest.parentGoal.supervisor.intervalPolicy must be 2.");
  assert(
    SUPERVISOR_STATES.has(value.state),
    "manifest.parentGoal.supervisor.state is invalid.",
  );
  assert(
    Number.isSafeInteger(value.intervalSeconds) &&
      value.intervalSeconds >= MIN_NUDGE_INTERVAL_SECONDS &&
      value.intervalSeconds <= MAX_NUDGE_INTERVAL_SECONDS,
    `manifest.parentGoal.supervisor.intervalSeconds must be an integer from ${MIN_NUDGE_INTERVAL_SECONDS} to ${MAX_NUDGE_INTERVAL_SECONDS}.`,
  );
  assertSafeUInt(value.nudgeCount, "manifest.parentGoal.supervisor.nudgeCount");
  assert(
    value.nextNudgeAt === null || typeof value.nextNudgeAt === "string",
    "manifest.parentGoal.supervisor.nextNudgeAt must be a string or null.",
  );
  for (const key of ["createdAt", "updatedAt"])
    assertString(value[key], `manifest.parentGoal.supervisor.${key}`);
  for (const key of ["pauseReason", "lastNudgeAt", "lastAttemptAt"])
    if (key in value)
      assertString(value[key], `manifest.parentGoal.supervisor.${key}`);
  if (value.state === "paused")
    assertString(
      value.pauseReason,
      "manifest.parentGoal.supervisor.pauseReason",
    );
  if ("rootActivity" in value) {
    const activity = assertObjectShape(
      value.rootActivity,
      "manifest.parentGoal.supervisor.rootActivity",
      ["status", "observedAt"],
    );
    assert(
      AGENT_STATUSES.has(activity.status),
      "manifest.parentGoal.supervisor.rootActivity.status is invalid.",
    );
    assertString(
      activity.observedAt,
      "manifest.parentGoal.supervisor.rootActivity.observedAt",
    );
  }
  if ("rootTurn" in value) {
    const turn = assertObjectShape(
      value.rootTurn,
      "manifest.parentGoal.supervisor.rootTurn",
      ["state", "runId", "paneId", "workspaceId", "updatedAt"],
    );
    assert(
      new Set(["active", "idle", "unknown"]).has(turn.state),
      "manifest.parentGoal.supervisor.rootTurn.state is invalid.",
    );
    for (const key of ["runId", "paneId", "workspaceId", "updatedAt"])
      assertString(turn[key], `manifest.parentGoal.supervisor.rootTurn.${key}`);
    assert(
      Number.isFinite(Date.parse(turn.updatedAt)),
      "manifest.parentGoal.supervisor.rootTurn.updatedAt is invalid.",
    );
  }
  if ("lastDelivery" in value) {
    const delivery = assertObjectShape(
      value.lastDelivery,
      "manifest.parentGoal.supervisor.lastDelivery",
      ["status", "attemptedAt"],
      ["deliveredAt", "acknowledgedAt", "reason"],
    );
    assert(
      new Set(["sending", "delivered", "pending", "uncertain"]).has(
        delivery.status,
      ),
      "manifest.parentGoal.supervisor.lastDelivery.status is invalid.",
    );
    assertString(
      delivery.attemptedAt,
      "manifest.parentGoal.supervisor.lastDelivery.attemptedAt",
    );
    if ("deliveredAt" in delivery)
      assertString(
        delivery.deliveredAt,
        "manifest.parentGoal.supervisor.lastDelivery.deliveredAt",
      );
    if ("acknowledgedAt" in delivery)
      assertString(
        delivery.acknowledgedAt,
        "manifest.parentGoal.supervisor.lastDelivery.acknowledgedAt",
      );
    if ("reason" in delivery)
      assertString(
        delivery.reason,
        "manifest.parentGoal.supervisor.lastDelivery.reason",
      );
  }
  return value;
}

function rootScopeAliases(orchestrator) {
  const root = orchestrator.root;
  return new Set([
    orchestrator.id,
    root.pane_id,
    `${root.workspace_id}:${root.pane_id}`,
    `${root.workspace_id}/${root.pane_id}`,
  ]);
}

function rootMetadataMatches(value, orchestrator) {
  if (!isRecord(value)) return false;
  const aliases = rootScopeAliases(orchestrator);
  const metadata = value.root ?? value.rootIdentity ?? value.owner;
  if (typeof metadata === "string" && aliases.has(metadata)) return true;
  if (isRecord(metadata)) {
    if (
      metadata.pane_id === orchestrator.root.pane_id &&
      metadata.workspace_id === orchestrator.root.workspace_id
    )
      return true;
    if (
      metadata.paneId === orchestrator.root.pane_id &&
      metadata.workspaceId === orchestrator.root.workspace_id
    )
      return true;
    if (typeof metadata.id === "string" && aliases.has(metadata.id)) return true;
  }
  for (const key of ["rootId", "root_id", "orchestratorId", "orchestrator_id", "scope"]) {
    if (typeof value[key] === "string" && aliases.has(value[key])) return true;
  }
  if (
    (value.paneId === orchestrator.root.pane_id ||
      value.pane_id === orchestrator.root.pane_id) &&
    (value.workspaceId === orchestrator.root.workspace_id ||
      value.workspace_id === orchestrator.root.workspace_id)
  )
    return true;
  const turn = value.supervisor?.rootTurn;
  return Boolean(
    isRecord(turn) &&
      turn.paneId === orchestrator.root.pane_id &&
      turn.workspaceId === orchestrator.root.workspace_id,
  );
}

function parentGoalCandidate(value) {
  if (!isRecord(value)) return undefined;
  if (typeof value.id === "string" && Array.isArray(value.signals)) return value;
  for (const key of ["goal", "parentGoal", "value"])
    if (isRecord(value[key])) return parentGoalCandidate(value[key]);
  return undefined;
}

function goalOwnedByRoot(goal, orchestrator) {
  const turn = goal?.supervisor?.rootTurn;
  return !isRecord(turn) ||
    (turn.paneId === orchestrator.root.pane_id &&
      turn.workspaceId === orchestrator.root.workspace_id);
}

function findRootGoal(value, orchestrator, seen = new Set()) {
  if (!isRecord(value) && !Array.isArray(value)) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isRecord(entry) || !rootMetadataMatches(entry, orchestrator)) continue;
      const candidate = parentGoalCandidate(entry);
      if (candidate) return candidate;
    }
    return undefined;
  }
  const candidate = parentGoalCandidate(value);
  if (candidate && rootMetadataMatches(value, orchestrator)) return candidate;
  for (const key of rootScopeAliases(orchestrator)) {
    if (key in value) {
      const scoped = parentGoalCandidate(value[key]);
      if (scoped) return scoped;
    }
  }
  for (const key of ["roots", "byRoot", "by_root", "goals", "parentGoals"])
    if (value[key] !== undefined) {
      const scoped = findRootGoal(value[key], orchestrator, seen);
      if (scoped) return scoped;
    }
  return undefined;
}

// A controller config may route multiple roots to one checkout manifest. New
// writers can store one goal per root in parentGoals (or an equivalent
// root-keyed container), while the historical parentGoal record remains fully
// supported for a single-root manifest. In a shared manifest, an unowned
// legacy goal is deliberately not selected: treating it as global would let a
// second root consume or mutate the first root's durable authority.
function parentGoalFor(manifest, orchestrator, shared = false) {
  for (const key of ["parentGoals", "parentGoalByRoot", "rootParentGoals", "rootGoals"]) {
    if (!(key in manifest)) continue;
    const goal = findRootGoal(manifest[key], orchestrator);
    if (goal) {
      const validated = validateParentGoal(goal);
      if (goalOwnedByRoot(validated, orchestrator)) return validated;
    }
    return undefined;
  }
  if (!("parentGoal" in manifest)) return undefined;
  const legacy = manifest.parentGoal;
  if (!shared) {
    const goal = parentGoalCandidate(legacy);
    return goal ? validateParentGoal(goal) : undefined;
  }
  const goal = findRootGoal(legacy, orchestrator);
  if (!goal) return undefined;
  const validated = validateParentGoal(goal);
  return goalOwnedByRoot(validated, orchestrator) ? validated : undefined;
}

function signalParentGoal(goal, record, timestamp = now()) {
  if (!goal) return;
  if (!ACTIONABLE_CLASSIFICATIONS.has(record.classification)) return;
  if (
    !goal.signals.some(
      (signal) => isRecord(signal) && signal.identity === record.identity,
    )
  ) {
    goal.signals.push({
      identity: record.identity,
      workflowId: record.workflow_id,
      laneId: record.lane_id,
      classification: record.classification,
      receivedAt: record.received_at,
    });
  }
  // A completed or explicitly blocked parent goal must never be revived by a
  // late lane hook; the durable signal remains available for manual review.
  // A pending user question/approval is stronger than a lane review breadcrumb
  // and must not be downgraded while the user still needs to act.
  if (
    goal.status !== "completed" &&
    goal.status !== "blocked" &&
    goal.status !== "paused" &&
    goal.status !== "action-required"
  )
    goal.status = "review-requested";
  goal.nextAction = `Review durable ${record.classification} event ${record.identity} for ${record.workflow_id}/${record.lane_id}; continue authorized safe local work or persist a truthful waiting/blocked state.`;
  goal.updatedAt = timestamp;
}

function workflowIsTerminal(workflow) {
  if (!isRecord(workflow)) return true;
  const hasStatus = typeof workflow.status === "string";
  const hasOutcome = typeof workflow.outcome === "string";
  const lanes = Array.isArray(workflow.lanes) ? workflow.lanes : [];
  const hasLaneLifecycle = lanes.some(
    (lane) =>
      isRecord(lane) &&
      ("status" in lane || "completionReceipt" in lane),
  );
  const nonTerminalLane = lanes.some(
    (lane) =>
      isRecord(lane) &&
      !lane.completionReceipt &&
      typeof lane.status === "string" &&
      !TERMINAL_LANE_STATES.has(lane.status),
  );
  // Early diagnostic manifests omitted lifecycle fields. Keep those legacy
  // records compatible; every explicit non-terminal state is active.
  if (!hasStatus && !hasOutcome && !hasLaneLifecycle) return true;
  return (
    !nonTerminalLane &&
    (!hasStatus || TERMINAL_WORKFLOW_STATES.has(workflow.status)) &&
    (!hasOutcome || TERMINAL_WORKFLOW_STATES.has(workflow.outcome))
  );
}

function signalParentGoalMismatch(goal, manifest, routedWorkflows, timestamp = now()) {
  if (!goal) return false;
  if (!TERMINAL_PARENT_GOAL_STATES.has(goal.status)) return false;
  const active = routedWorkflows
    .map((route) => ({
      route,
      workflow: manifest.workflows.find(
        (candidate) =>
          isRecord(candidate) && candidate.id === route.workflow_id,
      ),
    }))
    .filter(({ workflow }) => workflow && !workflowIsTerminal(workflow));
  if (active.length === 0) return false;

  const workflowIds = [
    ...new Set(active.map(({ route }) => route.workflow_id)),
  ].sort();
  let changed = false;
  for (const { route } of active) {
    const identity = `parent-goal-mismatch:${goal.id}:${route.workflow_id}`;
    if (
      goal.signals.some(
        (signal) => isRecord(signal) && signal.identity === identity,
      )
    )
      continue;
    goal.signals.push({
      identity,
      workflowId: route.workflow_id,
      // ParentGoal's additive signal contract is lane-shaped. Use the first
      // routed lane as the stable source marker for this workflow-level fact.
      laneId: route.lanes[0]?.lane_id ?? route.workflow_id,
      classification: "blocked",
      receivedAt: timestamp,
    });
    changed = true;
  }
  const nextAction =
    `Parent goal ${goal.id} is stale while routed workflow(s) remain active: ${workflowIds.join(", ")}. Run herdr_goal action=reset before initializing a fresh goal.`;
  if (goal.status !== "review-requested" || goal.nextAction !== nextAction) {
    goal.status = "review-requested";
    goal.nextAction = nextAction;
    goal.updatedAt = timestamp;
    changed = true;
  }
  return changed;
}

function queueStore(manifest) {
  if (!("queue" in manifest) || manifest.queue === undefined) return undefined;
  let value = manifest.queue;
  if (Array.isArray(value)) value = { version: QUEUE_SCHEMA_VERSION, items: value };
  assertObjectShape(value, "manifest.queue", ["version", "items"]);
  assert(value.version === QUEUE_SCHEMA_VERSION, "manifest.queue.version must be 1.");
  assert(Array.isArray(value.items), "manifest.queue.items must be an array.");
  const ids = new Set();
  for (const [index, item] of value.items.entries()) {
    const label = `manifest.queue.items[${index}]`;
    assertObjectShape(
      item,
      label,
      ["version", "id", "objective", "files", "after", "state", "createdAt", "updatedAt"],
      ["notes", "workflowId", "evidence"],
    );
    assert(item.version === QUEUE_SCHEMA_VERSION, `${label}.version must be 1.`);
    assert(/^queue-[0-9a-f]{8}$/i.test(item.id), `${label}.id must match queue-<8hex>.`);
    assert(!ids.has(item.id), `Duplicate queue item ID: ${item.id}.`);
    ids.add(item.id);
    assertString(item.objective, `${label}.objective`);
    assert(Array.isArray(item.files), `${label}.files must be an array.`);
    assert(item.files.every((file) => typeof file === "string" && file.trim()), `${label}.files must contain non-empty strings.`);
    assert(Array.isArray(item.after), `${label}.after must be an array.`);
    assert(item.after.every((dependency) => typeof dependency === "string" && dependency), `${label}.after must contain queue item IDs.`);
    assert(QUEUE_ITEM_STATES.has(item.state), `${label}.state is invalid.`);
    assertString(item.createdAt, `${label}.createdAt`);
    assertString(item.updatedAt, `${label}.updatedAt`);
    if ("notes" in item) assert(typeof item.notes === "string", `${label}.notes must be a string.`);
    if ("workflowId" in item) assert(typeof item.workflowId === "string", `${label}.workflowId must be a string.`);
    if ("evidence" in item) assert(typeof item.evidence === "string", `${label}.evidence must be a string.`);
  }
  for (const item of value.items)
    for (const dependency of item.after)
      assert(ids.has(dependency), `Queue item ${item.id} depends on unknown item ${dependency}.`);
  const normalized = { version: QUEUE_SCHEMA_VERSION, items: value.items };
  manifest.queue = normalized;
  return normalized;
}

function queueHeadReadiness(manifest, manifestPath) {
  const queue = queueStore(manifest);
  const item = queue?.items.find((candidate) => candidate.state === "pending");
  const blockers = { dependencies: [], files: [] };
  if (!item) return { item, blockers };
  for (const dependencyId of item.after) {
    const dependency = queue.items.find((candidate) => candidate.id === dependencyId);
    if (!dependency || !["landed", "dropped"].includes(dependency.state))
      blockers.dependencies.push({ id: dependencyId, ...(dependency ? { state: dependency.state } : {}) });
  }
  const rootCwd = dirname(dirname(dirname(resolve(manifestPath))));
  const paths = new Map(item.files.map((file) => [resolve(rootCwd, file), file]));
  if (paths.size > 0) {
    for (const other of queue.items) {
      if (other.id === item.id || ["landed", "dropped"].includes(other.state)) continue;
      const workflow = Array.isArray(manifest.workflows)
        ? manifest.workflows.find((candidate) => candidate.queueItemId === other.id)
        : undefined;
      const undischarged =
        other.state === "dispatched" ||
        other.state === "verified" ||
        Boolean(other.workflowId || (workflow && ["planned", "starting", "running", "blocked", "dispatch-failed"].includes(workflow.status)));
      if (!undischarged) continue;
      const overlap = other.files.filter((file) => paths.has(resolve(rootCwd, file)));
      if (overlap.length) blockers.files.push({ itemId: other.id, files: overlap });
    }
  }
  return { item, blockers };
}

function queueObjectiveSlug(objective) {
  const stopwords = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into", "is", "it", "of", "on", "or", "that", "the", "this", "these", "those", "to", "via", "with"]);
  const words = (objective ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((word) => !stopwords.has(word)) ?? [];
  return words.slice(0, 5).join("-").slice(0, 32).replace(/-+$/, "") || "queue";
}

function queueBlockerText(blockers) {
  const parts = [];
  if (blockers.dependencies.length)
    parts.push(`dependencies: ${blockers.dependencies.map((item) => `${item.id}${item.state ? ` (${item.state})` : ""}`).join(", ")}`);
  if (blockers.files.length)
    parts.push(`files: ${blockers.files.map((item) => `${item.itemId} [${item.files.join(", ")}]`).join(", ")}`);
  return parts.join("; ");
}

function queueOriginId(workflow, queue) {
  if (typeof workflow.queueItemId === "string" && workflow.queueItemId) return workflow.queueItemId;
  return queue?.items.find((item) => item.workflowId === workflow.id)?.id;
}

function queueItemBelongsToRoot(item, mapping, shared) {
  if (!shared) return true;
  if (rootMetadataMatches(item, mapping.orchestrator)) return true;
  return (
    typeof item.workflowId === "string" &&
    mapping.orchestrator.workflows.some(
      (workflow) => workflow.workflow_id === item.workflowId,
    )
  );
}

function signalParentGoalForQueue(goal, item, timestamp = now()) {
  if (!goal) return false;
  const nextAction = `Review queue head now dispatchable: ${item.id} ${queueObjectiveSlug(item.objective)}.`;
  if (goal.status === "review-requested" && goal.nextAction === nextAction) return false;
  goal.status = "review-requested";
  goal.nextAction = nextAction;
  goal.updatedAt = timestamp;
  return true;
}

function pendingParentAction(
  manifest,
  workflows = manifest.workflows,
  shared = false,
  orchestrator,
) {
  const actions = [];
  const add = (request, kind, workflowId) => {
    if (
      !isRecord(request) ||
      !USER_ACTIONABLE_REQUEST_STATUSES.has(request.status) ||
      typeof request.id !== "string" ||
      request.id.length === 0
    )
      return;
    actions.push({
      kind,
      id: request.id,
      workflowId:
        typeof request.workflowId === "string" && request.workflowId.length > 0
          ? request.workflowId
          : workflowId,
      requestedAt:
        typeof request.requestedAt === "string" ? request.requestedAt : undefined,
    });
  };
  if (Array.isArray(manifest.questionRequests))
    for (const request of manifest.questionRequests)
      if (
        !shared ||
        (orchestrator &&
          (rootMetadataMatches(request, orchestrator) ||
            (typeof request.workflowId === "string" &&
              orchestrator.workflows.some(
                (workflow) => workflow.workflow_id === request.workflowId,
              ))))
      )
        add(request, "question", undefined);
  if (Array.isArray(workflows))
    for (const workflow of workflows) {
      if (!isRecord(workflow)) continue;
      if (Array.isArray(workflow.questionRequests))
        for (const request of workflow.questionRequests)
          add(request, "question", workflow.id);
      if (Array.isArray(workflow.approvalRequests))
        for (const request of workflow.approvalRequests)
          add(request, "approval", workflow.id);
    }
  return actions
    .map((action, index) => ({ action, index }))
    .sort((left, right) => {
      const leftAt = left.action.requestedAt
        ? Date.parse(left.action.requestedAt)
        : NaN;
      const rightAt = right.action.requestedAt
        ? Date.parse(right.action.requestedAt)
        : NaN;
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt))
        return leftAt - rightAt || left.index - right.index;
      return left.index - right.index;
    })
    .map(({ action }) => action)[0];
}

function signalParentGoalForUserAction(
  goal,
  manifest,
  workflows,
  shared = false,
  orchestrator,
) {
  if (!goal) return false;
  const pending = pendingParentAction(
    manifest,
    workflows,
    shared,
    orchestrator,
  );
  if (!pending) return false;
  const workflowLabel = pending.workflowId
    ? ` for ${pending.workflowId}`
    : " for the mapped child";
  const nextAction =
    pending.kind === "question"
      ? `Answer pending parent question ${pending.id}${workflowLabel}; Zach's answer is required before the child can continue.`
      : `Approve or reject pending parent approval ${pending.id}${workflowLabel}; Zach's approval is required before the operation can continue.`;
  const terminal =
    goal.status === "completed" ||
    goal.status === "blocked" ||
    goal.status === "paused";
  const nextStatus = terminal ? goal.status : "action-required";
  if (goal.status === nextStatus && goal.nextAction === nextAction) return false;
  goal.status = nextStatus;
  goal.nextAction = nextAction;
  goal.updatedAt = now();
  return true;
}

function ensureLedger(workflow) {
  if (!("eventController" in workflow)) {
    workflow.eventController = { version: 1, events: [] };
  }
  const ledger = workflow.eventController;
  assertObjectShape(ledger, "workflow.eventController", ["version", "events"]);
  assert(ledger.version === 1, "workflow.eventController.version must be 1.");
  assert(
    Array.isArray(ledger.events),
    "workflow.eventController.events must be an array.",
  );
  for (const event of ledger.events) {
    assert(
      isRecord(event) &&
        typeof event.identity === "string" &&
        typeof event.classification === "string" &&
        isRecord(event.wake) &&
        typeof event.wake.status === "string" &&
        Number.isSafeInteger(event.wake.attempts) &&
        event.wake.attempts >= 0,
      "workflow.eventController contains an invalid event record.",
    );
  }
  return ledger;
}

async function atomicWriteJson(path, value) {
  const original = await lstat(path);
  assert(original.isFile(), `Manifest must be a regular file: ${path}`);
  const temporary = join(
    dirname(path),
    `.${basename(path)}.event-controller-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: original.mode & 0o777,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function acquireManifestLock(manifestPath) {
  // This sibling lock is shared with the global Pi extension's herdr_goal
  // writer. Controller state-dir locks cannot protect that separate process.
  const lockPath = join(
    dirname(manifestPath),
    `.${basename(manifestPath)}.herdr-orchestrator.lock`,
  );
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(
        join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, created_at: now() })}\n`,
        { mode: 0o600 },
      );
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw new ControllerError(
          `Timed out acquiring controller lock for ${manifestPath}.`,
          "lock_timeout",
        );
      await sleep(LOCK_RETRY_MS);
    }
  }
}

export class JsonLineHerdrClient {
  constructor(
    socketPath = process.env.HERDR_SOCKET_PATH,
    timeoutMs = SOCKET_TIMEOUT_MS,
  ) {
    assertString(socketPath, "HERDR_SOCKET_PATH");
    assert(
      isHerdrSocketPath(socketPath),
      "HERDR_SOCKET_PATH must be an absolute POSIX socket path or Windows named pipe.",
    );
    this.socketPath = socketPath;
    this.socketEndpoint = herdrSocketEndpoint(socketPath);
    this.timeoutMs = timeoutMs;
  }

  request(method, params) {
    const id = randomUUID();
    return new Promise((resolveRequest, rejectRequest) => {
      const socket = net.createConnection({ path: this.socketEndpoint });
      let settled = false;
      let sent = false;
      let buffer = "";
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        callback(value);
      };
      // A failure raised once the request bytes were already written cannot
      // prove Herdr never received or acted on it: mark it ambiguous so a
      // caller never treats it as safe-to-retry proof of nondelivery.
      const fail = (code, message) => {
        const error = new HerdrApiError(code, message);
        error.sent = sent;
        settle(rejectRequest, error);
      };
      socket.setEncoding("utf8");
      socket.setTimeout(this.timeoutMs);
      socket.once("timeout", () =>
        fail("socket_timeout", `Timed out calling Herdr ${method}.`),
      );
      socket.once("error", (error) =>
        fail(
          error.code ?? "socket_error",
          `Herdr socket ${method} failed: ${error.message}`,
        ),
      );
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        let response;
        try {
          response = JSON.parse(buffer.slice(0, newline));
        } catch (error) {
          settle(
            rejectRequest,
            new HerdrApiError(
              "invalid_response",
              `Herdr returned invalid JSON: ${error.message}`,
            ),
          );
          return;
        }
        if (!isRecord(response) || response.id !== id) {
          settle(
            rejectRequest,
            new HerdrApiError(
              "invalid_response",
              "Herdr returned an unexpected response ID.",
            ),
          );
          return;
        }
        if (
          isRecord(response.error) &&
          typeof response.error.code === "string" &&
          typeof response.error.message === "string"
        ) {
          settle(
            rejectRequest,
            new HerdrApiError(response.error.code, response.error.message),
          );
          return;
        }
        if (!("result" in response)) {
          settle(
            rejectRequest,
            new HerdrApiError(
              "invalid_response",
              "Herdr response has neither result nor error.",
            ),
          );
          return;
        }
        settle(resolveRequest, response.result);
      });
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
        sent = true;
      });
    });
  }
}

function extractAgentRead(result, expectedPaneId) {
  assert(
    isRecord(result) && result.type === "pane_read" && isRecord(result.read),
    "Herdr agent.read returned an invalid response.",
    "invalid_response",
  );
  const read = result.read;
  assert(
    read.pane_id === expectedPaneId,
    "Herdr agent.read response belongs to an unmapped pane.",
    "invalid_response",
  );
  return assertString(read.text, "Herdr agent.read response text");
}

function pausedGoalIds(output) {
  const ids = new Set();
  for (const line of output.split(/\r?\n/)) {
    if (!/\bpaus(?:e|ed|ing)\b/i.test(line)) continue;
    for (const match of line.matchAll(/\bpi-goal-[a-z0-9][a-z0-9_-]*\b/gi))
      ids.add(match[0].toLowerCase());
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function isPostCompletionLane(workflow, mapping) {
  const lane = workflow.lanes.find(
    (candidate) => candidate.id === mapping.lane.lane_id,
  );
  return Boolean(
    lane?.completionReceipt ||
      POST_COMPLETION_STATUSES.has(lane?.status) ||
      POST_COMPLETION_STATUSES.has(workflow.status) ||
      POST_COMPLETION_STATUSES.has(workflow.outcome),
  );
}

function suppressPostCompletionDone(classification, event, workflow, mapping) {
  if (
    event.data.agent_status === "done" &&
    classification.classification === "done" &&
    isPostCompletionLane(workflow, mapping)
  )
    return { ...classification, classification: "unclassified" };
  return classification;
}

async function classifyEvent(event, mapping, herdr, workflow) {
  const fallback = {
    classification:
      event.data.agent_status === "done" ||
      event.data.agent_status === "blocked"
        ? event.data.agent_status
        : "unclassified",
    source: { agent_status: event.data.agent_status },
  };
  if (
    !mapping.workflow.pi_goal_pause_detection ||
    !PI_PAUSE_PROBE_STATUSES.has(event.data.agent_status)
  )
    return suppressPostCompletionDone(fallback, event, workflow, mapping);
  try {
    // This one bounded read is triggered by a supported state-change hook; it
    // does not poll and runs only for an explicitly Pi-enabled workflow.
    const result = await herdr.request("agent.read", {
      target: mapping.lane.target,
      source: "recent_unwrapped",
      lines: 120,
      strip_ansi: true,
    });
    const output = extractAgentRead(result, mapping.lane.pane_id);
    const goalIds = pausedGoalIds(output);
    const source = {
      agent_status: event.data.agent_status,
      output_sha256: sha256(output),
    };
    if (goalIds.length > 0) source.goal_ids = goalIds;
    return suppressPostCompletionDone(
      {
        classification:
          goalIds.length > 0 ? "goal-paused" : fallback.classification,
        source,
      },
      event,
      workflow,
      mapping,
    );
  } catch (error) {
    return suppressPostCompletionDone(
      {
        ...fallback,
        source: {
          agent_status: event.data.agent_status,
          read_error: error instanceof Error ? error.message : String(error),
        },
      },
      event,
      workflow,
      mapping,
    );
  }
}

function rootAgent(result, root) {
  if (
    !isRecord(result) ||
    result.type !== "agent_info" ||
    !isRecord(result.agent)
  )
    return undefined;
  const agent = result.agent;
  if (
    agent.pane_id !== root.pane_id ||
    agent.workspace_id !== root.workspace_id
  )
    return undefined;
  if (root.target_kind === "name" && agent.name !== root.target)
    return undefined;
  if (root.target_kind === "pane_id" && root.target !== root.pane_id)
    return undefined;
  if (root.agent_kind !== undefined && agent.agent !== root.agent_kind)
    return undefined;
  return agent;
}

function rootMatches(result, root) {
  return rootAgent(result, root) !== undefined;
}

/**
 * Whether an `agent get` result shows the expected agent live in its pane,
 * ready for input. Text is only ever typed into such an agent: a pane whose
 * agent exited holds a raw shell, and typing a digest there leaves the shell
 * broken (an unclosed quote) so the agent cannot restart.
 */
export function liveAgentReady(result, expected) {
  const info = isRecord(result) && isRecord(result.result) ? result.result : result;
  if (!isRecord(info) || info.type !== "agent_info" || !isRecord(info.agent)) return { ok: false, reason: "no_agent_in_pane" };
  const agent = info.agent;
  if (typeof agent.agent !== "string" || !agent.agent) return { ok: false, reason: "no_agent_in_pane" };
  if (expected.pane_id && agent.pane_id !== expected.pane_id) return { ok: false, reason: "agent_pane_mismatch" };
  if (expected.workspace_id && agent.workspace_id !== undefined && agent.workspace_id !== expected.workspace_id) return { ok: false, reason: "agent_workspace_mismatch" };
  if (expected.name && agent.name !== undefined && agent.name !== expected.name) return { ok: false, reason: "agent_name_mismatch" };
  if (expected.agent_kind && agent.agent !== expected.agent_kind) return { ok: false, reason: "agent_kind_mismatch" };
  if (agent.interactive_ready === false || agent.launch_pending === true) return { ok: false, reason: "agent_not_interactive_ready" };
  if (agent.agent_status === "unknown") return { ok: false, reason: "agent_status_unknown" };
  return { ok: true, agent };
}

/**
 * Whether the pane shows a bare shell prompt: its only foreground process is
 * the shell. Herdr can keep an agent record for a moment after the agent
 * exits, so this is checked as well. undefined when process info is
 * unavailable (the agent check alone then decides).
 */
export function paneShowsShell(processInfo) {
  const result = isRecord(processInfo) && isRecord(processInfo.result) ? processInfo.result : processInfo;
  const info = isRecord(result?.process_info) ? result.process_info : result;
  if (!isRecord(info) || !Array.isArray(info.foreground_processes) || !info.shell_pid) return undefined;
  return info.foreground_processes.length > 0 && info.foreground_processes.every((item) => isRecord(item) && item.pid === info.shell_pid);
}

async function paneProcessInfo(herdr, paneId) {
  if (typeof herdr.processInfo === "function") return herdr.processInfo(paneId);
  const { stdout } = await execFileAsync("herdr", ["pane", "process-info", "--pane", paneId], { timeout: 5_000 });
  return JSON.parse(stdout);
}

/** Fetch and check the agent right before a send; never throws. */
export async function agentReadyForSend(herdr, target, expected) {
  let ready;
  try {
    ready = liveAgentReady(await herdr.request("agent.get", { target }), expected);
  } catch (error) {
    return { ok: false, reason: unavailable(error) ? `agent_unavailable:${error.code}` : `agent_check_failed:${error instanceof Error ? error.message : String(error)}` };
  }
  if (!ready.ok) return ready;
  const paneId = expected.pane_id ?? ready.agent.pane_id;
  if (typeof paneId === "string" && paneId) {
    const shell = await paneProcessInfo(herdr, paneId).then(paneShowsShell, () => undefined);
    if (shell === true) return { ok: false, reason: "pane_shows_shell_prompt" };
  }
  return ready;
}

const rootExpectation = (root) => ({
  pane_id: root.pane_id,
  workspace_id: root.workspace_id,
  ...(root.target_kind === "name" ? { name: root.target } : {}),
  ...(root.agent_kind !== undefined ? { agent_kind: root.agent_kind } : {}),
});

function rootEventMatches(event, root) {
  return (
    event.data.pane_id === root.pane_id &&
    event.data.workspace_id === root.workspace_id
  );
}

function unavailable(error) {
  return (
    error instanceof HerdrApiError &&
    new Set([
      "agent_not_found",
      "agent_not_running",
      "agent_blocked",
      "agent_pane_not_found",
      "agent_pane_unavailable",
      "server_unavailable",
      "socket_timeout",
      "socket_error",
      "ECONNREFUSED",
      "ENOENT",
    ]).has(error.code)
  );
}

const GOAL_SIDEBAR_TOKEN_NAMES = [
  "herdr_goal_status",
  "herdr_goal_next_1",
  "herdr_goal_next_2",
  "herdr_goal_next_3",
];

function workflowShortId(workflowId) {
  const generated = /^herdr-([a-z0-9]+)/i.exec(workflowId)?.[1];
  return (generated ?? workflowId.replace(/[^a-z0-9]/gi, ""))
    .toLowerCase()
    .slice(0, 8) || "workflow";
}

async function publishParticipantSidebar({ role, paneId, workflowId, herdr }) {
  try {
    const tokens = { herdr_role: role };
    if (workflowId) tokens.herdr_workflow = workflowShortId(workflowId);
    await herdr.request("pane.report_metadata", {
      pane_id: paneId,
      source: OWNER,
      tokens,
      ttl_ms: 86_400_000,
    });
  } catch {
    // Display-only role breadcrumbs must never change controller lifecycle.
  }
}

function wrapSidebarText(text, width = 20) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines = [];
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

function parentGoalSidebarTokens(goal, queue) {
  const next = wrapSidebarText(goal.nextAction).slice(0, 3);
  const pending = queue?.items.filter((item) => item.state === "pending") ?? [];
  return {
    herdr_role: "🐕 root",
    herdr_goal_status: `Goal: ${goal.status.replaceAll("-", " ")}`,
    herdr_goal_next_1: next[0] ? `Next: ${next[0]}` : null,
    herdr_goal_next_2: next[1] ?? null,
    herdr_goal_next_3: next[2] ?? null,
    ...(queue
      ? { herdr_queue: `${pending.length} pending · head ${pending[0] ? queueObjectiveSlug(pending[0].objective) : "none"}` }
      : {}),
  };
}

function parentGoalMobileLabel(goal) {
  return `Goal: ${goal.status.replaceAll("-for-event", "").replaceAll("-", " ")}`;
}

async function publishParentGoalSidebar(goal, root, herdr, queue) {
  // Display-only metadata is best effort: delivery or terminal failures must
  // never change the durable controller outcome.
  try {
    await herdr.request("pane.report_metadata", {
      pane_id: root.pane_id,
      source: OWNER,
      tokens: parentGoalSidebarTokens(goal, queue),
      // The compact/mobile switcher ignores sidebar rows but shows state labels.
      state_labels: {
        idle: parentGoalMobileLabel(goal),
        done: parentGoalMobileLabel(goal),
      },
      ttl_ms: 86_400_000,
    });
  } catch {
    // The root extension republishes on session start and direct goal changes.
  }
}

function routeScope(orchestrator, manifestPath) {
  return `${orchestrator.id}:${sha256(resolve(manifestPath))}`;
}

// Only a definite busy state defers a digest. "unknown" or an absent status
// must not starve a root of its updates; the Pi turn record gates Pi roots.
const DIGEST_BUSY_STATUSES = new Set(["working", "blocked"]);
const DIGEST_DETAILS_MAX_LENGTH = 1_500;
const AWAITING_ROOT_IDLE = "awaiting_root_idle";
const COLLECTING_UPDATES = "collecting_updates";
// Herdr reports done at the end of every child turn, usually right beside
// that lane's child message, so a short window turns bursts into one wake.
const DEFAULT_DIGEST_WINDOW_SECONDS = 60;
// A blocked or paused lane cannot continue until the root acts.
const URGENT_DIGEST_CLASSIFICATIONS = new Set(["blocked", "goal-paused"]);

function clipText(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * One prompt for everything the root has not seen yet. The root reads the
 * whole batch in a single turn instead of one turn per event, and each line
 * names the durable record it came from.
 */
const SPEC_LINE_STATES = ["pending", "deciding", "ready", "building", "reviewing", "integrating", "awaiting-push", "verifying", "failed"];

/**
 * The spec loop's burn-down line for the root digest, from spec.json and
 * spec-state.json next to the manifest (docs/SPEC-LOOP.md section 9). The
 * driver moves an item to done only through the verifier, so the recorded
 * states are enough here; no git access. Undefined without a spec.
 */
export async function specDigestLine(manifestPath) {
  try {
    const spec = JSON.parse(await readFile(join(dirname(dirname(manifestPath)), "spec.json"), "utf8"));
    const items = Array.isArray(spec?.items) ? spec.items : [];
    if (!items.length) return undefined;
    let state = {};
    try {
      state = JSON.parse(await readFile(join(dirname(manifestPath), "spec-state.json"), "utf8"))?.items ?? {};
    } catch {
      state = {};
    }
    const counts = new Map();
    let done = 0;
    let deferred = 0;
    let byDecision = 0;
    for (const item of items) {
      const record = isRecord(state[item?.id]) ? state[item.id] : {};
      const stage = typeof record.state === "string" ? record.state : "pending";
      if (stage === "done") done += 1;
      else if (stage === "resolved") {
        done += 1;
        byDecision += 1;
      } else if (stage === "deferred") deferred += 1;
      else {
        const key = stage === "blocked" ? `blocked(${record.blockedReason ?? "?"})` : stage;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const order = [...SPEC_LINE_STATES, ...[...counts.keys()].filter((key) => key.startsWith("blocked(")).sort()];
    // Deferred items are out of scope for now and not counted in M.
    return [
      `spec ${done}/${items.length - deferred} done${byDecision ? ` (${byDecision} by decision)` : ""}`,
      ...order.filter((key) => counts.has(key)).map((key) => `${counts.get(key)} ${key}`),
      ...(deferred ? [`${deferred} deferred`] : []),
    ].join(" · ");
  } catch {
    return undefined;
  }
}

export function digestText(items, open = [], specLine) {
  const lines = items.map((item, index) => {
    if (item.kind === "event") {
      const { record } = item;
      return `${index + 1}. ${record.classification}: ${record.workflow_id}/${record.lane_id} (event ${record.identity.slice(0, 12)})`;
    }
    if (item.kind === "alert") return `${index + 1}. ${item.request.kind}: ${item.request.text}`;
    if (item.kind === "directive") {
      const { request: directive } = item;
      return `${index + 1}. directive from ${directive.from} (${directive.id})${
        (directive.sends ?? 0) > 1 ? " [re-sent: not yet acknowledged]" : ""
      }: ${clipText(directive.text, DIGEST_DETAILS_MAX_LENGTH)}`;
    }
    if (item.kind === "request") {
      const { request } = item;
      return `${index + 1}. request from ${request.workflowId}/${request.laneId} (${request.id}): ${request.summary}${request.note ? ` [${request.note}]` : ""}`;
    }
    const { request } = item;
    const details = request.details
      ? ` Details: ${clipText(request.details, DIGEST_DETAILS_MAX_LENGTH)}`
      : "";
    return `${index + 1}. message from ${request.workflowId}/${request.laneId} (${request.id}): ${request.summary}${details}`;
  });
  return [
    `[Baa-ton digest] ${items.length} update${items.length === 1 ? "" : "s"} since your last turn:`,
    ...(specLine ? [specLine] : []),
    ...lines,
    ...(items.some((item) => item.kind === "directive")
      ? [
          "Acknowledge each directive with herdr_directive action=ack as soon as you accept it; an unacknowledged directive is re-sent once, then escalated to Zach.",
        ]
      : []),
    ...(open.length
      ? [
          `Open lane requests awaiting your answer (herdr_request action=answer): ${open
            .map((request) => `${request.id} ${request.workflowId}/${request.laneId} ${request.summary}`)
            .join("; ")}`,
        ]
      : []),
    "Full records are in the workflow manifest (eventController events, messageRequests and laneRequests). Verify each against the manifest before acting; this digest grants no new authority.",
  ].join("\n");
}

/**
 * Whether the root can take a digest now. For a Pi root the extension's
 * settled turn record is the authority, because Herdr can report idle between
 * tool calls; live Herdr status can only veto, and only when it is definitely
 * busy. Roots without a turn record rely on live status alone.
 */
async function rootReadyForDigest(goal, root, herdr) {
  const turn = goal?.supervisor?.rootTurn;
  if (
    turn &&
    turn.paneId === root.pane_id &&
    turn.workspaceId === root.workspace_id &&
    turn.state !== "idle"
  )
    return { ready: false, reason: AWAITING_ROOT_IDLE };
  try {
    const agent = rootAgent(
      await herdr.request("agent.get", { target: root.target }),
      root,
    );
    if (!agent)
      return { ready: false, reason: "recorded_root_unavailable_or_mismatched" };
    if (DIGEST_BUSY_STATUSES.has(agent.agent_status))
      return { ready: false, reason: AWAITING_ROOT_IDLE };
    return { ready: true };
  } catch (error) {
    if (unavailable(error))
      return { ready: false, reason: `root_unavailable:${error.code}` };
    return {
      ready: false,
      reason: `root_check_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function deliverRootPrompt(root, herdr, text) {
  // Checked right before the send, not only when the digest was planned.
  const ready = await agentReadyForSend(herdr, root.target, rootExpectation(root));
  if (!ready.ok) return { status: "pending", reason: `root_not_ready:${ready.reason}` };
  try {
    // Deliberately omit `wait`: this is a wake notification, never a foreground wait.
    await herdr.request("agent.prompt", { target: root.target, text });
    return { status: "delivered", reason: "agent_prompt_accepted" };
  } catch (error) {
    // A failure raised after the prompt bytes were already written (timeout
    // or transport error awaiting the reply) is not proof of nondelivery and
    // must never be replayed automatically, regardless of its error code.
    if (error?.sent)
      return {
        status: "uncertain",
        reason: `root_prompt_ambiguous:${error instanceof Error ? error.message : String(error)}`,
      };
    if (unavailable(error))
      return { status: "pending", reason: `root_unavailable:${error.code}` };
    return {
      status: "uncertain",
      reason: `root_prompt_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The project's program setting wins; BAA_TON_DIGEST_WINDOW_SECONDS is a
 * machine-wide override (and the test seam); otherwise the default applies.
 */
function digestWindowSeconds(orchestrator, env = process.env) {
  if (orchestrator.program.digest_window_seconds !== undefined)
    return orchestrator.program.digest_window_seconds;
  const override = env.BAA_TON_DIGEST_WINDOW_SECONDS;
  if (override !== undefined && /^\d+$/.test(override)) {
    const seconds = Number(override);
    if (seconds <= MAX_DIGEST_WINDOW_SECONDS) return seconds;
  }
  return DEFAULT_DIGEST_WINDOW_SECONDS;
}

function rootInboxIdentity(root) {
  return inboxIdentity(root.workspace_id, root.pane_id, root.agent_kind);
}

function interruptedDelivery(timestamp) {
  return { reason: "interrupted_root_delivery_requires_parent_review", timestamp };
}

const DEFAULT_DIRECTIVE_ESCALATE_MINUTES = 15;
const DIRECTIVE_RESEND_WITHOUT_TURN_MS = 5 * 60_000;
const DIRECTIVE_TEXT_MAX_LENGTH = 4_000;

/** Show a local Herdr notification to the operator; never throws. */
export async function herdrNotification({ title, body }) {
  try {
    await execFileAsync(
      "herdr",
      ["notification", "show", title, "--body", body, "--sound", "request"],
      { timeout: 10_000 },
    );
    return { status: "sent" };
  } catch (error) {
    return { status: "failed", reason: clipText(String(error?.message ?? error), 300) };
  }
}

function directiveEscalateMs(orchestrator) {
  return (
    (orchestrator.program.directive_escalate_minutes ?? DEFAULT_DIRECTIVE_ESCALATE_MINUTES) *
    60_000
  );
}

function rootSettledAfter(goal, since) {
  const turn = goal?.supervisor?.rootTurn;
  return turn?.state === "idle" && Date.parse(turn.updatedAt) > Date.parse(since);
}

function openDirectives(manifest, orchestrator) {
  return (Array.isArray(manifest.directives) ? manifest.directives : []).filter(
    (directive) =>
      isRecord(directive) &&
      directive.rootId === orchestrator.id &&
      directive.status === "open",
  );
}

/**
 * Record a directive for one root (from Zach or a supervisor session). It is
 * delivered in the root digest and stays open until the root acknowledges it
 * with herdr_directive; the supervisor tick re-sends it once, then escalates.
 */
export async function postDirective({ manifestPath, rootId, from, text, timestamp = now() }) {
  assertString(manifestPath, "manifestPath");
  assert(isAbsolute(manifestPath), "manifestPath must be absolute.");
  assertString(rootId, "rootId");
  assertString(from, "from");
  assert(
    typeof text === "string" && text.trim() && text.length <= DIRECTIVE_TEXT_MAX_LENGTH,
    `Directive text must be 1-${DIRECTIVE_TEXT_MAX_LENGTH} characters.`,
  );
  const release = await acquireManifestLock(manifestPath);
  try {
    const manifest = parseJson(
      await readRegularFile(manifestPath, "Parent manifest"),
      "Parent manifest",
    );
    manifest.directives = Array.isArray(manifest.directives) ? manifest.directives : [];
    const directive = {
      id: `directive-${randomUUID().slice(0, 8)}`,
      rootId,
      from,
      text: text.trim(),
      createdAt: timestamp,
      status: "open",
      sends: 0,
      delivery: { status: "pending", attempts: 0, updatedAt: timestamp },
    };
    manifest.directives.push(directive);
    await atomicWriteJson(manifestPath, manifest);
    return directive;
  } finally {
    await release();
  }
}

/** Queue open directives for the digest: new ones, and one re-send after the
 * root finished a turn without acknowledging. Mutates the manifest. */
function collectDirectiveItems({ orchestrator, manifest, goal, timestamp, items }) {
  let changed = false;
  for (const directive of openDirectives(manifest, orchestrator)) {
    const delivery = directive.delivery ?? {
      status: "pending",
      attempts: 0,
      updatedAt: directive.createdAt,
    };
    if (delivery.status === "sending") {
      const interrupted = interruptedDelivery(timestamp);
      directive.delivery = {
        ...delivery,
        status: "uncertain",
        updatedAt: interrupted.timestamp,
        reason: interrupted.reason,
      };
      changed = true;
      continue;
    }
    if (
      (delivery.status === "delivered" || delivery.status === "uncertain") &&
      (directive.sends ?? 0) === 1
    ) {
      const sentAt = directive.sentAt ?? delivery.updatedAt;
      const turned = goal?.supervisor?.rootTurn
        ? rootSettledAfter(goal, sentAt)
        : Date.parse(timestamp) - Date.parse(sentAt) > DIRECTIVE_RESEND_WITHOUT_TURN_MS;
      if (turned) {
        directive.delivery = {
          status: "pending",
          attempts: delivery.attempts ?? 1,
          updatedAt: timestamp,
          reason: "not_acknowledged_after_root_turn",
        };
        changed = true;
      }
    }
    if (directive.delivery?.status === "pending")
      items.push({ kind: "directive", request: directive });
  }
  return changed;
}

/**
 * Escalate open directives the root has not acknowledged: after the one
 * re-send was ignored, or after directive_escalate_minutes (default 15) in
 * any state, including never delivered because the root stayed busy or had
 * a dialog open. One local Herdr notification per directive.
 */
export async function escalateDirectives({
  orchestrator,
  manifestPath,
  manifest,
  goal,
  notify = herdrNotification,
  timestamp = now(),
}) {
  const limit = directiveEscalateMs(orchestrator);
  const escalated = [];
  for (const directive of openDirectives(manifest, orchestrator)) {
    if (directive.escalatedAt) continue;
    const delivery = directive.delivery ?? {};
    const sentAt = directive.sentAt ?? delivery.updatedAt;
    const resentAndIgnored =
      (directive.sends ?? 0) >= 2 &&
      (delivery.status === "delivered" || delivery.status === "uncertain") &&
      (rootSettledAfter(goal, sentAt) || Date.parse(timestamp) - Date.parse(sentAt) > limit);
    const overdue = Date.parse(timestamp) - Date.parse(directive.createdAt) > limit;
    if (!resentAndIgnored && !overdue) continue;
    const reason = resentAndIgnored
      ? "re-sent once and still not acknowledged"
      : `not acknowledged after ${Math.round(limit / 60_000)} min`;
    const outcome = await notify({
      title: "Baa-ton: directive not acknowledged",
      body: clipText(`${orchestrator.id}: ${reason}. ${directive.from}: ${directive.text}`, 500),
    });
    directive.escalatedAt = timestamp;
    directive.escalation = { ...outcome, reason };
    escalated.push(directive.id);
  }
  if (escalated.length) await atomicWriteJson(manifestPath, manifest);
  return escalated;
}

const DEFAULT_CAPACITY_ESCALATE_MINUTES = 15;
const DEFAULT_WATCHDOG_MINUTES = 30;
const GIB = 1024 ** 3;

function roundTo(value, digits = 1) {
  return value === undefined ? undefined : Math.round(value * 10 ** digits) / 10 ** digits;
}

/**
 * One local capacity sample: available memory (macOS: free + inactive +
 * speculative + purgeable pages; Linux: MemAvailable), swap in use, and the
 * one-minute load per CPU. Fields the platform cannot report are omitted.
 */
export async function sampleCapacity() {
  const cpus = Math.max(1, os.cpus().length);
  const sample = {
    freeMemoryGb: roundTo(os.freemem() / GIB),
    load1PerCpu: roundTo(os.loadavg()[0] / cpus, 2),
  };
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("vm_stat", [], { timeout: 5_000 });
      const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1] ?? 4096);
      const pages = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(stdout)?.[1] ?? 0);
      sample.freeMemoryGb = roundTo(
        (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable")) *
          pageSize /
          GIB,
      );
      const swap = await execFileAsync("sysctl", ["-n", "vm.swapusage"], { timeout: 5_000 });
      const used = /used = ([\d.]+)([MG])/.exec(swap.stdout);
      if (used) sample.swapUsedGb = roundTo(Number(used[1]) / (used[2] === "G" ? 1 : 1024));
    } else if (process.platform === "linux") {
      const meminfo = await readFile("/proc/meminfo", "utf8");
      const kb = (label) => Number(new RegExp(`^${label}:\\s+(\\d+) kB`, "m").exec(meminfo)?.[1]);
      if (Number.isFinite(kb("MemAvailable"))) sample.freeMemoryGb = roundTo((kb("MemAvailable") * 1024) / GIB);
      if (Number.isFinite(kb("SwapTotal")) && Number.isFinite(kb("SwapFree")))
        sample.swapUsedGb = roundTo(((kb("SwapTotal") - kb("SwapFree")) * 1024) / GIB);
    }
  } catch {
    // Keep the portable os.* figures when the platform probe is unavailable.
  }
  return sample;
}

/** The processes holding the most resident memory, largest first. */
export async function topMemoryUsers(limit = 5) {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "rss=,pid=,comm="], {
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout
      .split("\n")
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line))
      .filter(Boolean)
      .map(([, rss, pid, command]) => ({ rssGb: Number(rss) / (1024 * 1024), pid: Number(pid), command: basename(command.trim()) }))
      .sort((a, b) => b.rssGb - a.rssGb)
      .slice(0, limit)
      .map((item) => `${item.command} (${item.pid}) ${roundTo(item.rssGb)} GB`);
  } catch {
    return [];
  }
}

function supervisionFor(manifest, orchestrator, create = false) {
  const entries = Array.isArray(manifest.rootSupervision) ? manifest.rootSupervision : [];
  let entry = entries.find((item) => isRecord(item) && item.rootId === orchestrator.id);
  if (!entry && create) {
    entry = { rootId: orchestrator.id, alerts: [] };
    manifest.rootSupervision = [...entries, entry];
  }
  if (entry && !Array.isArray(entry.alerts)) entry.alerts = [];
  return entry;
}

function queueRootAlert(entry, kind, text, timestamp) {
  const alert = {
    id: `alert-${randomUUID().slice(0, 8)}`,
    kind,
    text,
    createdAt: timestamp,
    delivery: { status: "pending", attempts: 0, updatedAt: timestamp },
  };
  entry.alerts.push(alert);
  // Keep the record bounded; delivered alerts are history only.
  if (entry.alerts.length > 50) entry.alerts.splice(0, entry.alerts.length - 50);
  return alert;
}

function describeSample(sample) {
  return [
    sample.freeMemoryGb !== undefined ? `free ${sample.freeMemoryGb} GB` : undefined,
    sample.swapUsedGb !== undefined ? `swap ${sample.swapUsedGb} GB` : undefined,
    sample.load1PerCpu !== undefined ? `load ${sample.load1PerCpu}/CPU` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
}

function describeGate(gate) {
  return [
    gate.minFreeMemoryGb !== undefined ? `free >= ${gate.minFreeMemoryGb} GB` : undefined,
    gate.maxSwapUsedGb !== undefined ? `swap <= ${gate.maxSwapUsedGb} GB` : undefined,
    gate.maxLoadPerCpu !== undefined ? `load <= ${gate.maxLoadPerCpu}/CPU` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
}

export function capacityGateSatisfied(gate, sample) {
  const checks = [];
  if (gate.minFreeMemoryGb !== undefined) checks.push(sample.freeMemoryGb !== undefined && sample.freeMemoryGb >= gate.minFreeMemoryGb);
  if (gate.maxSwapUsedGb !== undefined) checks.push(sample.swapUsedGb !== undefined && sample.swapUsedGb <= gate.maxSwapUsedGb);
  if (gate.maxLoadPerCpu !== undefined) checks.push(sample.load1PerCpu !== undefined && sample.load1PerCpu <= gate.maxLoadPerCpu);
  return checks.length > 0 && checks.every(Boolean);
}

/** When lanes or the root last showed progress, or undefined while one is
 * working right now. */
function lastProgressAt(manifest, orchestrator, manifestPath, goal) {
  if (goal?.supervisor?.rootTurn?.state === "active") return undefined;
  const routes = orchestrator.workflows.filter(
    (route) => resolve(route.manifest_path) === resolve(manifestPath),
  );
  let latest = Date.parse(goal?.supervisor?.rootTurn?.updatedAt ?? goal?.updatedAt ?? goal?.createdAt ?? 0) || 0;
  for (const route of routes) {
    const stored = manifest.workflows?.find((item) => isRecord(item) && item.id === route.workflow_id);
    const events = Array.isArray(stored?.eventController?.events) ? stored.eventController.events : [];
    for (const lane of route.lanes) {
      const laneEvents = events.filter((event) => event.lane_id === lane.lane_id);
      const last = laneEvents.at(-1);
      if (last?.source?.agent_status === "working") return undefined;
      for (const event of laneEvents) latest = Math.max(latest, Date.parse(event.received_at ?? event.at ?? 0) || 0);
    }
  }
  return latest;
}

/**
 * Capacity gate and no-progress watchdog for one root, on the supervisor
 * tick. Queues root alerts (delivered in the digest) and sends at most one
 * Herdr notification per blocked gate and per idle episode.
 */
export async function superviseRoot({
  orchestrator,
  manifestPath,
  manifest,
  goal,
  notify = herdrNotification,
  sample = sampleCapacity,
  topUsers = topMemoryUsers,
  timestamp = now(),
}) {
  let changed = false;
  const outcome = { capacity: undefined, watchdog: undefined };
  const entry = supervisionFor(manifest, orchestrator);
  const gate = entry?.capacityGate;
  if (gate?.status === "waiting") {
    const current = await sample();
    if (capacityGateSatisfied(gate, current)) {
      gate.status = "cleared";
      gate.clearedAt = timestamp;
      gate.sample = current;
      queueRootAlert(
        entry,
        "capacity-available",
        `capacity available for "${gate.reason}": ${describeSample(current)} (gate: ${describeGate(gate)}). Resume the work you parked on capacity.`,
        timestamp,
      );
      outcome.capacity = "cleared";
      changed = true;
    } else if (
      !gate.escalatedAt &&
      Date.parse(timestamp) - Date.parse(gate.createdAt) >
        (orchestrator.program.capacity_escalate_minutes ?? DEFAULT_CAPACITY_ESCALATE_MINUTES) * 60_000
    ) {
      const users = await topUsers();
      const minutes = Math.round((Date.parse(timestamp) - Date.parse(gate.createdAt)) / 60_000);
      // Name (never stop) stacks still held by finished lanes: retiring
      // those lanes is usually the fastest way to clear the gate.
      const idle = describeIdleServices(idleLaneServices(manifest.workflows));
      gate.escalatedAt = timestamp;
      gate.sample = current;
      if (idle) queueRootAlert(entry, "capacity-idle-services", idle, timestamp);
      gate.escalation = await notify({
        title: "Baa-ton: capacity still blocked",
        body: clipText(
          `${orchestrator.id} has waited ${minutes} min for "${gate.reason}" (${describeGate(gate)}). Now ${describeSample(current)}. Top memory: ${users.length ? users.join("; ") : "unavailable"}.${idle ? ` ${idle}` : ""}`,
          500,
        ),
      });
      outcome.capacity = "escalated";
      changed = true;
    }
  }
  if (goal && !TERMINAL_PARENT_GOAL_STATES.has(goal.status)) {
    const since = lastProgressAt(manifest, orchestrator, manifestPath, goal);
    const limit = (orchestrator.program.watchdog_minutes ?? DEFAULT_WATCHDOG_MINUTES) * 60_000;
    if (since !== undefined && Date.parse(timestamp) - since > limit) {
      const target = entry ?? supervisionFor(manifest, orchestrator, true);
      const idleSince = new Date(since).toISOString();
      if (target.watchdog?.idleSince !== idleSince) {
        const minutes = Math.round((Date.parse(timestamp) - since) / 60_000);
        const reason = `no lane has been working for ${minutes} min while parent goal ${goal.id} is ${goal.status}${goal.nextAction ? ` (next: ${clipText(goal.nextAction, 200)})` : ""}`;
        queueRootAlert(target, "no-progress", `${reason}. Plan or dispatch the next step, or record a truthful goal state.`, timestamp);
        target.watchdog = {
          idleSince,
          alertedAt: timestamp,
          notification: await notify({ title: "Baa-ton: no progress", body: clipText(`${orchestrator.id}: ${reason}.`, 500) }),
        };
        outcome.watchdog = "alerted";
        changed = true;
      }
    }
  }
  // A live goal whose supervisor is stopped gets no nudges at all (a reset
  // once left the new goal stopped while every lane sat idle). The episode
  // starts when a tick first sees it stopped; alert once after the watchdog
  // delay, so a deliberate short stop stays quiet.
  const stopped =
    goal && !QUIET_PARENT_GOAL_STATUSES.has(goal.status) && goal.supervisor?.state === "stopped";
  const existing = supervisionFor(manifest, orchestrator)?.supervisorStopped;
  if (!stopped && existing) {
    delete supervisionFor(manifest, orchestrator).supervisorStopped;
    changed = true;
  } else if (stopped) {
    const target = supervisionFor(manifest, orchestrator, true);
    if (!target.supervisorStopped || target.supervisorStopped.goalId !== goal.id) {
      target.supervisorStopped = { goalId: goal.id, since: timestamp };
      changed = true;
    } else if (!target.supervisorStopped.alertedAt) {
      const limit = (orchestrator.program.watchdog_minutes ?? DEFAULT_WATCHDOG_MINUTES) * 60_000;
      const since = Date.parse(target.supervisorStopped.since);
      if (Date.parse(timestamp) - since > limit) {
        const minutes = Math.round((Date.parse(timestamp) - since) / 60_000);
        const reason = `the supervisor for parent goal ${goal.id} (${goal.status}) has been stopped for ${minutes} min, so the root gets no nudges`;
        queueRootAlert(
          target,
          "supervisor-stopped",
          `${reason}. Run herdr_goal action=start, or record the goal as completed or paused.`,
          timestamp,
        );
        target.supervisorStopped.alertedAt = timestamp;
        target.supervisorStopped.notification = await notify({
          title: "Baa-ton: supervisor stopped",
          body: clipText(`${orchestrator.id}: ${reason}.`, 500),
        });
        outcome.watchdog = outcome.watchdog ?? "supervisor-stopped";
        changed = true;
      }
    }
  }
  if (changed) await atomicWriteJson(manifestPath, manifest);
  return outcome;
}

function collectAlertItems({ orchestrator, manifest, timestamp, items }) {
  const entry = supervisionFor(manifest, orchestrator);
  let changed = false;
  for (const alert of entry?.alerts ?? []) {
    if (alert.delivery?.status === "sending") {
      const interrupted = interruptedDelivery(timestamp);
      alert.delivery = { ...alert.delivery, status: "uncertain", updatedAt: interrupted.timestamp, reason: interrupted.reason };
      changed = true;
      continue;
    }
    if (alert.delivery?.status === "pending") items.push({ kind: "alert", request: alert });
  }
  return changed;
}

/** Pending root-bound items for one orchestrator's routes in this manifest. */
function collectDigestItems({ orchestrator, manifestPath, manifest, goal, timestamp }) {
  const routes = orchestrator.workflows.filter(
    (route) => resolve(route.manifest_path) === resolve(manifestPath),
  );
  const items = [];
  const open = [];
  let changed = false;
  for (const route of routes) {
    const stored = manifest.workflows.find(
      (candidate) => isRecord(candidate) && candidate.id === route.workflow_id,
    );
    if (!stored) continue;
    const events = isRecord(stored.eventController) && Array.isArray(stored.eventController.events)
      ? stored.eventController.events
      : [];
    for (const record of events) {
      if (!ACTIONABLE_CLASSIFICATIONS.has(record.classification)) continue;
      if (!recordBelongsToRoutes(record, routes)) continue;
      if (record.wake?.status === "sending") {
        const interrupted = interruptedDelivery(timestamp);
        record.wake = {
          ...record.wake,
          status: "uncertain",
          reason: interrupted.reason,
          updated_at: interrupted.timestamp,
        };
        changed = true;
        continue;
      }
      if (record.wake?.status === "pending") items.push({ kind: "event", record });
    }
    const laneById = new Map(route.lanes.map((lane) => [lane.lane_id, lane]));
    const requests = Array.isArray(stored.messageRequests) ? stored.messageRequests : [];
    for (const request of requests) {
      const lane = laneById.get(request.laneId);
      if (!lane) continue;
      const status = request.delivery?.status ?? "pending";
      const attempts = Number.isSafeInteger(request.delivery?.attempts) ? request.delivery.attempts : 0;
      if (status === "sending") {
        const interrupted = interruptedDelivery(timestamp);
        request.delivery = {
          status: "uncertain",
          attempts,
          updatedAt: interrupted.timestamp,
          reason: interrupted.reason,
        };
        changed = true;
        continue;
      }
      if (status !== "pending") continue;
      // A child message is a new review signal, including for terminal lanes
      // and goals. Signal once, when it is first seen, not on every deferral.
      if (attempts === 0 && !request.delivery?.reason) {
        signalParentGoalForMessage(goal, request, timestamp);
        changed = true;
      }
      items.push({ kind: "message", request, lane });
    }
    // Formal lane requests: each new open request is one urgent digest item;
    // every digest also lists the requests still awaiting an answer.
    const laneRequests = Array.isArray(stored.laneRequests) ? stored.laneRequests : [];
    for (const request of laneRequests) {
      if (!isRecord(request) || request.status !== "open") continue;
      const lane = laneById.get(request.laneId);
      if (!lane) continue;
      open.push(request);
      const status = request.delivery?.status ?? "pending";
      if (status === "sending") {
        const interrupted = interruptedDelivery(timestamp);
        request.delivery = {
          status: "uncertain",
          attempts: Number.isSafeInteger(request.delivery?.attempts) ? request.delivery.attempts : 0,
          updatedAt: interrupted.timestamp,
          reason: interrupted.reason,
        };
        changed = true;
        continue;
      }
      if (status !== "pending") continue;
      request.delivery ??= { status: "pending", updatedAt: timestamp };
      if (!request.delivery.attempts && !request.delivery.reason) {
        signalParentGoalForMessage(goal, request, timestamp);
        changed = true;
      }
      items.push({ kind: "request", request, lane });
    }
  }
  if (collectDirectiveItems({ orchestrator, manifest, goal, timestamp, items })) changed = true;
  if (collectAlertItems({ orchestrator, manifest, timestamp, items })) changed = true;
  return { items, changed, open };
}

/**
 * The root dispatcher. Every pending lifecycle event and child message for
 * one orchestrator goes to its root as a single digest, and only when the
 * root's turn has settled; while the root works they stay pending and the
 * next hook or supervisor tick delivers them together. Callers hold the
 * manifest lock and pass the parsed manifest; this writes it back.
 */
export async function dispatchRootDigest({
  orchestrator,
  manifestPath,
  manifest,
  goal,
  configDir,
  herdr,
  timestamp = now(),
}) {
  const { items, changed, open } = collectDigestItems({
    orchestrator,
    manifestPath,
    manifest,
    goal,
    timestamp,
  });
  let dirty = changed;
  if (items.length === 0) {
    if (dirty) await atomicWriteJson(manifestPath, manifest);
    return { status: "empty", count: 0 };
  }
  const defer = async (reason) => {
    for (const item of items) {
      if (item.kind === "event" && item.record.wake.reason !== reason) {
        item.record.wake = { ...item.record.wake, reason, updated_at: timestamp };
        dirty = true;
      } else if (item.kind !== "event" && item.request.delivery.reason !== reason) {
        item.request.delivery = { ...item.request.delivery, reason, updatedAt: timestamp };
        dirty = true;
      }
    }
    if (dirty) await atomicWriteJson(manifestPath, manifest);
    return { status: "deferred", reason, count: items.length };
  };
  const windowSeconds = digestWindowSeconds(orchestrator);
  const urgent = items.some(
    (item) =>
      item.kind === "request" ||
      item.kind === "directive" ||
      item.kind === "alert" ||
      (item.kind === "event" &&
        URGENT_DIGEST_CLASSIFICATIONS.has(item.record.classification)),
  );
  if (!urgent && windowSeconds > 0) {
    const oldest = Math.min(
      ...items.map((item) =>
        Date.parse(item.kind === "event" ? item.record.received_at : item.request.requestedAt),
      ),
    );
    const elapsed = Date.parse(timestamp) - oldest;
    if (Number.isFinite(elapsed) && elapsed < windowSeconds * 1_000)
      return defer(COLLECTING_UPDATES);
  }
  const root = orchestrator.root;
  const readiness = await rootReadyForDigest(goal, root, herdr);
  if (!readiness.ready) return defer(readiness.reason);

  const scope = routeScope(orchestrator, manifestPath);
  const inbox = [];
  for (const item of items) {
    if (item.kind === "event") {
      const { record } = item;
      inbox.push(
        await persistControllerMessage(configDir, {
          logicalKey: `lane-event:${scope}:${record.workflow_id}/${record.lane_id}/${record.classification}`,
          occurrenceId: record.identity,
          kind: "lifecycle-event",
          from: inboxIdentity(record.workspace_id, record.pane_id, record.source?.agent),
          to: rootInboxIdentity(root),
          payload: record,
          wake: true,
        }),
      );
    } else if (item.kind === "directive" || item.kind === "alert") {
      inbox.push(undefined);
    } else if (item.kind === "request") {
      const { request, lane } = item;
      inbox.push(
        await persistControllerMessage(configDir, {
          logicalKey: `lane-request:${scope}:${request.workflowId}/${request.laneId}:${request.id}`,
          occurrenceId: request.id,
          kind: "lane-request",
          from: inboxIdentity(lane.workspace_id, lane.pane_id, lane.target),
          to: rootInboxIdentity(root),
          payload: request,
          wake: true,
        }),
      );
    } else {
      const { request, lane } = item;
      inbox.push(
        await persistControllerMessage(configDir, {
          logicalKey: `child-message:${scope}:${request.workflowId}/${request.laneId}:${sha256(request.summary)}`,
          occurrenceId: request.id,
          kind: "child-message",
          from: inboxIdentity(lane.workspace_id, lane.pane_id, lane.target),
          to: rootInboxIdentity(root),
          payload: request,
          wake: true,
        }),
      );
    }
  }
  // Persist "sending" before the prompt: an interrupted send becomes
  // uncertain on the next pass and is never replayed.
  const attemptsFor = [];
  for (const item of items) {
    if (item.kind === "event") {
      const attempts = (Number.isSafeInteger(item.record.wake.attempts) ? item.record.wake.attempts : 0) + 1;
      item.record.wake = { ...item.record.wake, status: "sending", attempts, reason: "root_digest_started", updated_at: timestamp };
      attemptsFor.push(attempts);
    } else {
      const attempts = (Number.isSafeInteger(item.request.delivery.attempts) ? item.request.delivery.attempts : 0) + 1;
      item.request.delivery = { status: "sending", attempts, updatedAt: timestamp };
      if (item.kind === "directive") {
        item.request.sends = (item.request.sends ?? 0) + 1;
        item.request.sentAt = timestamp;
      }
      attemptsFor.push(attempts);
    }
  }
  await atomicWriteJson(manifestPath, manifest);
  for (const [index, stored] of inbox.entries())
    if (stored)
      await markDelivery(stored.path, stored.message.occurrence_id, "sending", {
        attempts: attemptsFor[index],
      });

  const runLine = await runStateDigestLine();
  const specLine = await specDigestLine(manifestPath);
  const outcome = await deliverRootPrompt(root, herdr, digestText(items, open, [runLine, specLine].filter(Boolean).join("\n") || undefined));
  const finishedAt = now();
  for (const [index, item] of items.entries()) {
    if (item.kind === "event")
      item.record.wake = { ...item.record.wake, ...outcome, updated_at: finishedAt };
    else
      item.request.delivery = {
        status: outcome.status,
        attempts: attemptsFor[index],
        updatedAt: finishedAt,
        reason: outcome.reason,
      };
    await finishControllerMessage(inbox[index], outcome.status, {
      attempts: attemptsFor[index],
      reason: outcome.reason,
    });
  }
  await atomicWriteJson(manifestPath, manifest);
  return { status: outcome.status, reason: outcome.reason, count: items.length };
}

function queueHeadWakeText(item) {
  return [
    `queue head now dispatchable: ${item.id} ${queueObjectiveSlug(item.objective)}`,
    `Review the durable queue item ${item.id} before planning or dispatching it; this notice grants no new authority.`,
  ].join(" ");
}

async function deliverQueueHeadWake(item, root, herdr) {
  try {
    const rootInfo = await herdr.request("agent.get", { target: root.target });
    if (!rootMatches(rootInfo, root))
      return { status: "pending", reason: "recorded_root_unavailable_or_mismatched" };
    const ready = await agentReadyForSend(herdr, root.target, rootExpectation(root));
    if (!ready.ok) return { status: "pending", reason: `root_not_ready:${ready.reason}` };
  } catch (error) {
    if (unavailable(error))
      return { status: "pending", reason: `root_unavailable:${error.code}` };
    return { status: "uncertain", reason: `root_check_failed:${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    await herdr.request("agent.prompt", {
      target: root.target,
      text: queueHeadWakeText(item),
    });
    return { status: "delivered", reason: "agent_prompt_accepted" };
  } catch (error) {
    if (error?.sent)
      return { status: "uncertain", reason: `root_prompt_ambiguous:${error instanceof Error ? error.message : String(error)}` };
    if (unavailable(error))
      return { status: "pending", reason: `root_unavailable:${error.code}` };
    return { status: "uncertain", reason: `root_prompt_failed:${error instanceof Error ? error.message : String(error)}` };
  }
}

async function processQueueHeadWake({
  manifestPath,
  manifest,
  workflow,
  mapping,
  configDir,
  herdr,
  timestamp = now(),
  goal,
  shared = false,
}) {
  if (!workflowIsTerminal(workflow)) return undefined;
  const queue = queueStore(manifest);
  const originId = queueOriginId(workflow, queue);
  const origin = queue?.items.find((item) => item.id === originId);
  if (!origin || origin.state !== "landed") return undefined;
  const readiness = queueHeadReadiness(manifest, manifestPath);
  if (
    readiness.item &&
    !queueItemBelongsToRoot(readiness.item, mapping, shared)
  )
    return undefined;
  if (!readiness.item || readiness.blockers.dependencies.length || readiness.blockers.files.length)
    return { status: "blocked", item: readiness.item, blockers: readiness.blockers };
  const logicalKey = `queue-head:${routeScope(mapping.orchestrator, manifestPath)}:${readiness.item.id}`;
  const occurrenceId = sha256(logicalKey);
  const changed = signalParentGoalForQueue(goal, readiness.item, timestamp);
  if (changed) await atomicWriteJson(manifestPath, manifest);
  const inboxMessage = await persistControllerMessage(configDir, {
    logicalKey,
    occurrenceId,
    kind: "queue-head",
    from: inboxIdentity(
      mapping.orchestrator.root.workspace_id,
      mapping.orchestrator.root.pane_id,
      mapping.orchestrator.root.agent_kind,
    ),
    to: inboxIdentity(
      mapping.orchestrator.root.workspace_id,
      mapping.orchestrator.root.pane_id,
      mapping.orchestrator.root.agent_kind,
    ),
    payload: {
      queueItemId: readiness.item.id,
      objective: readiness.item.objective,
      blockers: readiness.blockers,
    },
    wake: true,
    dedupe: "occurrence",
  });
  if (inboxMessage) {
    const prior = inboxMessage.message.delivery?.status;
    if (prior === "delivered" || prior === "uncertain")
      return { status: prior, item: readiness.item, deduplicated: true };
    if (prior === "sending") {
      await markDelivery(
        inboxMessage.path,
        inboxMessage.message.occurrence_id,
        "uncertain",
        { reason: "interrupted_root_delivery_requires_parent_review" },
      );
      return { status: "uncertain", item: readiness.item, deduplicated: true };
    }
    await markDelivery(
      inboxMessage.path,
      inboxMessage.message.occurrence_id,
      "sending",
      { attempts: (inboxMessage.message.delivery?.attempts ?? 0) + 1 },
    );
  }
  const outcome = await deliverQueueHeadWake(
    readiness.item,
    mapping.orchestrator.root,
    herdr,
  );
  await finishControllerMessage(
    inboxMessage,
    outcome.status,
    { attempts: inboxMessage?.message.delivery?.attempts ?? 1, reason: outcome.reason },
  );
  return { ...outcome, item: readiness.item, deduplicated: false };
}

function signalParentGoalForMessage(goal, message, timestamp = now()) {
  if (!goal) return false;
  goal.status = "review-requested";
  goal.nextAction =
    `Review child message ${message.id} from ${message.workflowId}/${message.laneId}: ${message.summary}`;
  goal.updatedAt = timestamp;
  return true;
}

/**
 * Route one durable child message from the extension/bridge through the same
 * controller inbox and root wake path used by lifecycle events. The caller
 * has already fenced its live pane; this function revalidates the registered
 * workflow and authoritative manifest before sending anything.
 */
export async function routeChildMessage(options = {}) {
  const {
    configDir: configuredConfigDir,
    stateDir,
    workflowId,
    laneId,
    messageId,
    herdr,
  } = options;
  const configDir = configuredConfigDir ?? stateDir;
  assertString(configDir, "HERDR_PLUGIN_CONFIG_DIR");
  assertString(workflowId, "workflowId");
  assertString(laneId, "laneId");
  assertString(messageId, "messageId");
  const config = await loadConfig(configDir);
  let matches = [];
  for (const orchestrator of config.orchestrators)
    for (const workflow of orchestrator.workflows)
      if (workflow.workflow_id === workflowId) {
        const lane = workflow.lanes.find((candidate) => candidate.lane_id === laneId);
        if (lane) matches.push({ orchestrator, workflow, lane });
      }
  // Workflow IDs are unique within an orchestrator, not necessarily across
  // isolated roots. A child bridge carries its pane/workspace identity, so use
  // that identity to select the root-owned manifest before treating a repeated
  // ID as ambiguous. Never fall back to cwd or choose the first match.
  if (matches.length > 1) {
    const paneId = process.env.HERDR_PANE_ID;
    const workspaceId = process.env.HERDR_WORKSPACE_ID;
    if (paneId && workspaceId) {
      const scoped = matches.filter(
        ({ lane }) =>
          lane.pane_id === paneId && lane.workspace_id === workspaceId,
      );
      if (scoped.length > 0) matches = scoped;
    }
  }
  assert(
    matches.length === 1,
    matches.length === 0
      ? "Child message route is not registered for this workflow/lane."
      : "Child message route is ambiguously registered.",
    matches.length === 0 ? "invalid_mapping" : "ambiguous_mapping",
  );
  const mapping = matches[0];
  const manifestPath = resolve(mapping.workflow.manifest_path);
  const release = await acquireManifestLock(manifestPath);
  try {
    const manifest = parseJson(
      await readRegularFile(manifestPath, "Workflow manifest"),
      "Workflow manifest",
    );
    const workflow = validateMappedWorkflow(
      manifest,
      { workflow: mapping.workflow, lane: mapping.lane },
      config.owner,
    );
    const request = workflow.messageRequests?.find(
      (candidate) =>
        isRecord(candidate) &&
        candidate.id === messageId &&
        candidate.workflowId === workflowId &&
        candidate.laneId === laneId,
    );
    assert(
      request,
      `Durable child message ${messageId} is missing from the authoritative manifest.`,
      "invalid_mapping",
    );
    const goal = parentGoalFor(
      manifest,
      mapping.orchestrator,
      manifestHasMultipleRoots(config, manifestPath),
    );
    const digest = await dispatchRootDigest({
      orchestrator: mapping.orchestrator,
      manifestPath,
      manifest,
      goal,
      configDir,
      herdr: herdr ?? new JsonLineHerdrClient(),
    });
    return {
      accepted: true,
      delivery: request.delivery?.status ?? "pending",
      request,
      digest,
    };
  } finally {
    await release();
  }
}

function supervisorWakeText(goal, reasons = []) {
  return [
    `[Baa-ton supervisor] Parent goal ${goal.id} is ${goal.status} and work is waiting on you:`,
    ...reasons.map((reason, index) => `${index + 1}) ${reason}`),
    `Objective: ${goal.objective}`,
    `Next action: ${goal.nextAction}`,
    "Handle these now through safe local actions, or record a truthful goal state: completed, paused, or action-required with the question for Zach. Do not push, merge, create a PR, deploy, or mutate production without explicit user approval.",
  ].join("\n");
}

async function deliverSupervisorNudge(goal, root, herdr, reasons) {
  try {
    const rootInfo = await herdr.request("agent.get", { target: root.target });
    const agent = rootAgent(rootInfo, root);
    if (!agent)
      return {
        status: "pending",
        reason: "recorded_root_unavailable_or_mismatched",
      };
    const ready = await agentReadyForSend(herdr, root.target, rootExpectation(root));
    if (!ready.ok) return { status: "pending", reason: `root_not_ready:${ready.reason}` };
    if (agent.agent_status !== "idle" && agent.agent_status !== "done")
      return {
        status: "pending",
        reason: `root_not_idle:${String(agent.agent_status)}`,
      };
  } catch (error) {
    if (unavailable(error))
      return { status: "pending", reason: `root_unavailable:${error.code}` };
    return {
      status: "uncertain",
      reason: `root_check_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    await herdr.request("agent.prompt", {
      target: root.target,
      text: supervisorWakeText(goal, reasons),
    });
    return { status: "delivered", reason: "agent_prompt_accepted" };
  } catch (error) {
    // Same ambiguous-send rule as deliverRootPrompt: a post-write failure can never
    // be treated as a definite non-delivery safe to retry.
    if (error?.sent)
      return {
        status: "uncertain",
        reason: `root_prompt_ambiguous:${error instanceof Error ? error.message : String(error)}`,
      };
    if (unavailable(error))
      return { status: "pending", reason: `root_unavailable:${error.code}` };
    return {
      status: "uncertain",
      reason: `root_prompt_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function nudgeDue(supervisor, timestamp) {
  if (supervisor.state !== "running" || supervisor.nextNudgeAt === null)
    return false;
  let dueAt = Date.parse(supervisor.nextNudgeAt);
  // A delivered or possibly-delivered nudge (including legacy one-shot
  // records) is never followed by another within one full interval.
  const last = supervisor.lastDelivery;
  if (last && (last.status === "delivered" || last.status === "uncertain")) {
    const earliest = Date.parse(last.attemptedAt) + supervisor.intervalSeconds * 1000;
    if (Number.isFinite(earliest)) dueAt = Math.max(dueAt, earliest);
  }
  return Number.isFinite(dueAt) && dueAt <= Date.parse(timestamp);
}

function nextNudgeAt(timestamp, intervalSeconds) {
  return new Date(Date.parse(timestamp) + intervalSeconds * 1000).toISOString();
}

function inboxIdentity(workspaceId, paneId, agent) {
  return {
    workspace_id: workspaceId,
    pane_id: paneId,
    ...(agent ? { agent } : {}),
  };
}

async function persistControllerMessage(stateDir, {
  logicalKey,
  occurrenceId,
  kind,
  from,
  to,
  payload,
  wake = false,
  dedupe = "occurrence",
}) {
  // Older diagnostic fixtures and pre-task registrations may describe a
  // cross-workspace child. They remain supported by the controller's legacy
  // ledger, but are not eligible for herdr-link/1 delivery until a
  // workspace-scoped mapping is registered.
  if (from.workspace_id !== to.workspace_id) return undefined;
  const path = storePath({ stateDir });
  const stored = await putMessage(path, {
    envelope: makeEnvelope({
      logicalKey,
      occurrenceId,
      kind,
      from,
      to,
      payload,
    }),
    dedupe,
  });
  if (wake)
    await enqueueWakeHint(path, {
      recipient: to,
      occurrenceId: stored.message.occurrence_id,
    });
  return { path, message: stored.message, created: stored.created };
}

async function finishControllerMessage(stored, status, details = {}) {
  if (!stored) return;
  await markDelivery(stored.path, stored.message.occurrence_id, status, details);
}

async function observeRootActivity(root, herdr, timestamp) {
  try {
    const result = await herdr.request("agent.get", { target: root.target });
    const agent = rootAgent(result, root);
    if (!agent)
      return {
        available: false,
        reason: "recorded_root_unavailable_or_mismatched",
      };
    if (!AGENT_STATUSES.has(agent.agent_status))
      return { available: false, reason: "root_status_invalid" };
    return {
      available: true,
      status: agent.agent_status,
      observedAt: timestamp,
    };
  } catch (error) {
    if (unavailable(error))
      return { available: false, reason: `root_unavailable:${error.code}` };
    return {
      available: false,
      reason: `root_check_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const LANE_DELIVERY_BUSY = new Set(["working", "blocked"]);

/**
 * Deliver what the root left queued for its lanes: herdr_tell messages and
 * lane-request answers whose first delivery found the lane busy. Text is
 * typed only into an idle lane and only while nothing was typed before
 * (pending); a prompt that may have landed becomes uncertain and is never
 * retyped. Returns whether the manifest changed.
 */
export async function deliverLaneQueue({ workflow, herdr, timestamp = now() }) {
  const lanes = new Map((Array.isArray(workflow?.lanes) ? workflow.lanes : []).map((lane) => [lane.id, lane]));
  const kindOf = (lane) => lane?.agentKind ?? workflow?.agentKind;
  const queued = [];
  for (const message of Array.isArray(workflow?.laneMessages) ? workflow.laneMessages : [])
    if (isRecord(message) && message.delivery?.status === "pending")
      queued.push({ laneId: message.laneId, record: message, key: "delivery", text: message.delivery.text ?? `[Baa-ton root message] ${message.id}: ${message.text}` });
  for (const request of Array.isArray(workflow?.laneRequests) ? workflow.laneRequests : [])
    if (isRecord(request) && request.status !== "open" && request.answerDelivery?.status === "pending" && typeof request.answerDelivery.text === "string")
      queued.push({ laneId: request.laneId, record: request, key: "answerDelivery", text: request.answerDelivery.text });
  let changed = false;
  const busy = new Set();
  for (const item of queued) {
    const lane = lanes.get(item.laneId);
    const paneId = lane?.paneId;
    if (!paneId || busy.has(paneId)) continue;
    const previous = item.record[item.key];
    // Only into the lane's own agent, live and ready; never into a shell.
    const ready = await agentReadyForSend(herdr, paneId, { pane_id: paneId, ...(kindOf(lane) ? { agent_kind: kindOf(lane) } : {}) });
    const agent = ready.ok ? ready.agent : undefined;
    if (!agent || LANE_DELIVERY_BUSY.has(agent.agent_status)) {
      busy.add(paneId);
      continue;
    }
    const attempts = (previous.attempts ?? 0) + 1;
    try {
      await herdr.request("agent.prompt", { target: paneId, text: item.text });
      item.record[item.key] = { status: "delivered", updatedAt: timestamp, attempts, by: "supervisor" };
    } catch (error) {
      item.record[item.key] = {
        status: error?.sent || !unavailable(error) ? "uncertain" : "pending",
        updatedAt: timestamp,
        attempts,
        reason: error instanceof Error ? error.message : String(error),
        ...(error?.sent || !unavailable(error) ? {} : { text: item.text }),
      };
    }
    // One prompt per lane per tick: the lane is busy with it now.
    busy.add(paneId);
    changed = true;
  }
  return changed;
}

/** The operator's durable run state (running unless an operator paused it); never throws. */
export async function operatorRunState() {
  try {
    const { operatorStorePath, readOperatorStore, runState } = await import("../herdr-tools/operator.mjs");
    return runState(await readOperatorStore(operatorStorePath()));
  } catch {
    return { state: "running", implicit: true };
  }
}

async function runStateDigestLine() {
  try {
    const { runStateLine } = await import("../herdr-tools/operator.mjs");
    return runStateLine(await operatorRunState());
  } catch {
    return undefined;
  }
}

/** Spec items waiting for the root's loop to move them (read-only), by state. */
function specWaiting(manifestPath) {
  try {
    const spec = JSON.parse(readFileSync(join(dirname(dirname(manifestPath)), "spec.json"), "utf8"));
    let state = {};
    try {
      state = JSON.parse(readFileSync(join(dirname(manifestPath), "spec-state.json"), "utf8"))?.items ?? {};
    } catch {
      state = {};
    }
    const counts = new Map();
    for (const item of Array.isArray(spec?.items) ? spec.items : []) {
      const record = isRecord(state[item?.id]) ? state[item.id] : {};
      const stage = typeof record.state === "string" ? record.state : "pending";
      const waiting = ["awaiting-push", "pending", "ready", "failed"].includes(stage) || (stage === "blocked" && record.blockedReason === "exhausted") || (stage === "integrating" && !record.lane);
      if (waiting) counts.set(stage, (counts.get(stage) ?? 0) + 1);
    }
    return counts;
  } catch {
    return new Map();
  }
}

/**
 * Operator messages (docs/OPERATOR-MESSAGES.md) waiting for their target:
 * the same live, idle, never-retype rules as root-to-lane delivery.
 */
export async function deliverOperatorQueue({ herdr, storePath, timestamp = now() } = {}) {
  // Loaded on use: the supervisor starts and runs without it.
  const { deliverOperatorMessages, operatorStorePath, withOperatorStore } = await import("../herdr-tools/operator.mjs");
  storePath ??= operatorStorePath();
  const { existsSync: exists } = await import("node:fs");
  if (!exists(storePath)) return [];
  return withOperatorStore(storePath, (store) =>
    deliverOperatorMessages(store, {
      at: timestamp,
      ready: (paneId, expected) => agentReadyForSend(herdr, paneId, expected),
      prompt: async (paneId, text) => {
        try {
          await herdr.request("agent.prompt", { target: paneId, text });
        } catch (error) {
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { sent: Boolean(error?.sent) || !unavailable(error) });
        }
      },
    }),
  );
}

export async function runSupervisorTick({
  stateDir = process.env.HERDR_PLUGIN_STATE_DIR,
  configDir = process.env.HERDR_PLUGIN_CONFIG_DIR ?? stateDir,
  herdr,
  notify = herdrNotification,
  sample = sampleCapacity,
  topUsers = topMemoryUsers,
  timestamp = now(),
} = {}) {
  requireStateDir(stateDir);
  const config = await loadConfig(configDir);
  const api = herdr ?? new JsonLineHerdrClient();
  const results = [];
  const pendingWakes = [];
  const seenManifests = new Set();
  for (const entry of configuredParentManifests(config)) {
    const { orchestrator, manifestPath, workflows } = entry;
    const manifestKey = `${orchestrator.id}:${manifestPath}`;
    if (seenManifests.has(manifestKey)) continue;
    seenManifests.add(manifestKey);
    // One unreadable, missing or invalid manifest (often a historical
    // mapping) must not starve the valid ones after it. Skip it for this
    // tick and leave a durable diagnostic; nothing is retried here, and any
    // delivery already marked sending becomes uncertain on the next pass.
    let release;
    try {
      release = await acquireManifestLock(manifestPath);
    } catch (error) {
      results.push(await recordManifestSkip(stateDir, { orchestrator, manifestPath, stage: "lock", error, timestamp }));
      continue;
    }
    try {
      const manifest = parseJson(
        await readRegularFile(manifestPath, "Parent manifest"),
        "Parent manifest",
      );
      // Do not schedule against an unowned or stale registration merely because
      // it shares a manifest with a valid workflow in this orchestrator.
      const matchedWorkflows = workflows.map((candidate) =>
        validateMappedWorkflow(
          manifest,
          { workflow: candidate, lane: candidate.lanes[0] },
          config.owner,
        ),
      );
      const sharedManifest = manifestHasMultipleRoots(config, manifestPath);
      const goal = parentGoalFor(manifest, orchestrator, sharedManifest);
      // Forward compatibility: keep parent goals readable by older bridges.
      const policy = stripSupervisorIntervalPolicy(manifest);
      if (policy.changed) {
        if (policy.found)
          supervisionFor(manifest, orchestrator, true).nudgeIntervalPolicy = NUDGE_INTERVAL_POLICY;
        await atomicWriteJson(manifestPath, manifest);
      }
      // Queue continuation uses this existing event-driven tick as its retry
      // point. A landed predecessor can wake only a clear ordered head.
      for (const [workflowIndex, stored] of matchedWorkflows.entries()) {
        const candidate = workflows[workflowIndex];
        const queueWake = await processQueueHeadWake({
          manifestPath,
          manifest,
          workflow: stored,
          mapping: { orchestrator, workflow: candidate, lane: candidate.lanes[0] },
          configDir,
          herdr: api,
          timestamp,
          goal,
          shared: sharedManifest,
        });
        if (
          queueWake &&
          queueWake.status !== "blocked" &&
          !queueWake.deduplicated
        )
          pendingWakes.push({
            manifestPath,
            workflowId: stored.id,
            kind: "queue-head",
            queueItemId: queueWake.item?.id,
            status: queueWake.status,
          });
      }
      // Screen prompts first (the root's answer or the due default, as keys),
      // then root-to-lane deliveries the lane was too busy to take earlier.
      let laneQueueChanged = false;
      for (const stored of matchedWorkflows)
        if (await resolveScreenPrompts({ herdr: api, manifest, workflow: stored, timestamp })) laneQueueChanged = true;
      for (const stored of matchedWorkflows)
        if (await deliverLaneQueue({ workflow: stored, herdr: api, timestamp })) laneQueueChanged = true;
      if (laneQueueChanged) await atomicWriteJson(manifestPath, manifest);
      // Herdr's sidebar rows are selected by canonical agent kind, while
      // pane.report_metadata supplies the per-pane role/workflow breadcrumb.
      // The display-only publication runs in finally, after lifecycle work,
      // so it cannot affect live-root checks or delivery decisions.
      // Parent questions and approvals are persisted by the extension, while
      // this controller owns the parent goal. Reconcile them on the same
      // event-driven tick so the sidebar reserves "action required" for a
      // record that actually needs Zach's decision.
      if (
        signalParentGoalForUserAction(
          goal,
          manifest,
          matchedWorkflows,
          sharedManifest,
          orchestrator,
        )
      ) {
        await atomicWriteJson(manifestPath, manifest);
        if (goal)
          await publishParentGoalSidebar(
            goal,
            orchestrator.root,
            api,
            queueStore(manifest),
          );
      }
      // A terminal parent goal must not silently coexist with a newly routed
      // workflow. This check is deliberately separate from ordinary lane
      // review signals and is also run when no wake is pending.
      if (signalParentGoalMismatch(goal, manifest, workflows, timestamp)) {
        await atomicWriteJson(manifestPath, manifest);
        if (goal)
          await publishParentGoalSidebar(
            goal,
            orchestrator.root,
            api,
            queueStore(manifest),
          );
      }
      // The root's own question dialog, when nothing else will answer it.
      try {
        const { superviseRootDialog } = await import("./root-dialog.mjs");
        const dialog = await superviseRootDialog({
          orchestrator,
          manifest,
          manifestPath,
          entry: supervisionFor(manifest, orchestrator, true),
          herdr: api,
          notify,
          timestamp,
        });
        if (dialog.changed) await atomicWriteJson(manifestPath, manifest);
        if (dialog.action === "answered") pendingWakes.push({ manifestPath, kind: "root-dialog-answered" });
      } catch {
        // Best effort: a missing helper or a Herdr hiccup never blocks the tick.
      }
      const escalatedDirectives = await escalateDirectives({
        orchestrator,
        manifestPath,
        manifest,
        goal,
        notify,
        timestamp,
      });
      if (escalatedDirectives.length)
        pendingWakes.push({ manifestPath, kind: "directive-escalation", directiveIds: escalatedDirectives });
      const supervision = await superviseRoot({
        orchestrator,
        manifestPath,
        manifest,
        goal,
        notify,
        sample,
        topUsers,
        timestamp,
      });
      if (supervision.capacity || supervision.watchdog)
        pendingWakes.push({ manifestPath, kind: "supervision", ...supervision });
      // Event-driven delivery point for everything the root has not seen:
      // a digest deferred while the root worked goes out on the first tick
      // after its turn settles, independent of parent-goal status.
      const digest = await dispatchRootDigest({
        orchestrator,
        manifestPath,
        manifest,
        goal,
        configDir,
        herdr: api,
        timestamp,
      });
      if (digest.count > 0) {
        pendingWakes.push({
          manifestPath,
          kind: "digest",
          status: digest.status,
          count: digest.count,
          ...(digest.reason ? { reason: digest.reason } : {}),
        });
        if (goal && digest.status !== "deferred")
          await publishParentGoalSidebar(
            goal,
            orchestrator.root,
            api,
            queueStore(manifest),
          );
      }
      if (!goal) {
        results.push({ manifestPath, status: "no-parent-goal" });
        continue;
      }
      if (!("supervisor" in goal)) {
        results.push({ manifestPath, status: "supervisor-stopped" });
        continue;
      }
      const supervisor = goal.supervisor;
      const persist = async () => {
        supervisor.updatedAt = timestamp;
        goal.updatedAt = timestamp;
        await atomicWriteJson(manifestPath, manifest);
      };
      if (upgradeNudgeInterval(manifest, orchestrator, supervisor, timestamp)) await persist();
      // The operator's run state is the only pause: when an operator set it
      // to running, a pause the root put on its own goal is lifted.
      const run = await operatorRunState();
      if (!run.implicit && run.state === "running" && (supervisor.state === "paused" || goal.status === "paused")) {
        supervisor.state = "running";
        delete supervisor.pauseReason;
        if (goal.status === "paused") goal.status = "active";
        supervisor.nextNudgeAt = timestamp;
        queueRootAlert(
          supervisionFor(manifest, orchestrator, true),
          "run-resumed",
          `The run state is running (set by ${run.by} at ${run.at}). Your own pause is lifted: continue the work.`,
          timestamp,
        );
        await persist();
      }
      if (supervisor.state !== "running") {
        results.push({ manifestPath, status: "not-running" });
        continue;
      }
      // An interrupted send may have reached the root: it is never replayed,
      // and the next nudge waits a full interval.
      if (supervisor.lastDelivery?.status === "sending") {
        supervisor.lastDelivery = {
          status: "uncertain",
          attemptedAt: supervisor.lastDelivery.attemptedAt,
          reason: "interrupted_root_delivery_requires_parent_review",
        };
        supervisor.nextNudgeAt = nextNudgeAt(timestamp, supervisor.intervalSeconds);
        await persist();
        results.push({ manifestPath, status: "uncertain" });
        continue;
      }
      const decision = nudgeDecision({ goal, manifest, orchestrator, manifestPath, run });
      // A stall episode ends as soon as the spec no longer stalls.
      if (!decision.specStall && supervisionFor(manifest, orchestrator)?.stall) {
        delete supervisionFor(manifest, orchestrator).stall;
        await persist();
      }
      if (decision.quiet) {
        results.push({ manifestPath, status: "quiet", reason: decision.quiet });
        continue;
      }
      // A digest sent on this tick already woke the root; it counts as this
      // interval's wake, so the next nudge waits a full interval.
      if (digest.status === "delivered" || digest.status === "uncertain") {
        supervisor.nextNudgeAt = nextNudgeAt(timestamp, supervisor.intervalSeconds);
        await persist();
        results.push({ manifestPath, status: "digest-delivered" });
        continue;
      }
      // A digest still collecting updates will wake the root shortly; a
      // nudge now would arrive first and repeat the same items.
      if (digest.status === "deferred" && digest.reason === COLLECTING_UPDATES) {
        results.push({ manifestPath, status: "digest-collecting" });
        continue;
      }
      // Goals parked under the old rule have no schedule: start one now.
      if (supervisor.nextNudgeAt === null) {
        supervisor.nextNudgeAt = nextNudgeAt(timestamp, supervisor.intervalSeconds);
        await persist();
        results.push({ manifestPath, status: "scheduled" });
        continue;
      }
      if (!nudgeDue(supervisor, timestamp)) {
        results.push({ manifestPath, status: "not-due" });
        continue;
      }
      const turn = supervisor.rootTurn;
      if (
        !turn ||
        turn.state !== "idle" ||
        turn.paneId !== orchestrator.root.pane_id ||
        turn.workspaceId !== orchestrator.root.workspace_id ||
        orchestrator.root.agent_kind !== "pi"
      ) {
        results.push({ manifestPath, status: "root-turn-not-idle" });
        continue;
      }
      // Live Herdr status can veto delivery, but can never create idle authority.
      const activity = await observeRootActivity(
        orchestrator.root,
        api,
        timestamp,
      );
      if (!activity.available) {
        supervisor.lastAttemptAt = timestamp;
        supervisor.lastDelivery = {
          status: "pending",
          attemptedAt: timestamp,
          reason: activity.reason,
        };
        supervisor.nextNudgeAt = nextNudgeAt(
          timestamp,
          supervisor.intervalSeconds,
        );
        supervisor.updatedAt = timestamp;
        goal.updatedAt = timestamp;
        await atomicWriteJson(manifestPath, manifest);
        results.push({ manifestPath, status: "pending" });
        continue;
      }
      supervisor.rootActivity = {
        status: activity.status,
        observedAt: activity.observedAt,
      };
      // Herdr's done is an unseen completion, also ready for input. The Pi
      // settled proof above is still mandatory for either ready state.
      if (activity.status !== "idle" && activity.status !== "done") {
        supervisor.nextNudgeAt = nextNudgeAt(
          timestamp,
          supervisor.intervalSeconds,
        );
        supervisor.updatedAt = timestamp;
        goal.updatedAt = timestamp;
        await atomicWriteJson(manifestPath, manifest);
        results.push({ manifestPath, status: "root-not-idle" });
        continue;
      }
      const attemptedAt = timestamp;
      supervisor.lastAttemptAt = attemptedAt;
      supervisor.lastDelivery = { status: "sending", attemptedAt };
      supervisor.nextNudgeAt = null;
      supervisor.updatedAt = timestamp;
      goal.updatedAt = timestamp;
      await atomicWriteJson(manifestPath, manifest);
      const inboxMessage = await persistControllerMessage(configDir, {
        logicalKey: `supervisor-wake:${routeScope(orchestrator, manifestPath)}:${goal.id}`,
        occurrenceId: sha256(
          canonicalJson({
            goal: goal.id,
            nextAction: goal.nextAction,
            attemptedAt,
          }),
        ),
        kind: "supervisor-wake",
        from: inboxIdentity(
          orchestrator.root.workspace_id,
          orchestrator.root.pane_id,
          orchestrator.root.agent_kind,
        ),
        to: inboxIdentity(
          orchestrator.root.workspace_id,
          orchestrator.root.pane_id,
          orchestrator.root.agent_kind,
        ),
        payload: { goalId: goal.id, objective: goal.objective, nextAction: goal.nextAction },
        wake: true,
      });
      if (inboxMessage)
        await markDelivery(
          inboxMessage.path,
          inboxMessage.message.occurrence_id,
          "sending",
          { attempts: 1 },
        );
      const outcome = await deliverSupervisorNudge(
        goal,
        orchestrator.root,
        api,
        decision.reasons,
      );
      supervisor.lastDelivery = {
        status: outcome.status,
        attemptedAt,
        ...(outcome.status === "delivered" ? { deliveredAt: timestamp } : {}),
        reason: outcome.reason,
      };
      if (outcome.status === "delivered") {
        supervisor.nudgeCount += 1;
        supervisor.lastNudgeAt = supervisor.lastDelivery.deliveredAt;
        // Two stall nudges the root did not act on: tell the user, once.
        if (decision.specStall) {
          const entry = supervisionFor(manifest, orchestrator, true);
          entry.stall = { since: entry.stall?.since ?? timestamp, nudges: (entry.stall?.nudges ?? 0) + 1, ...(entry.stall?.notifiedAt ? { notifiedAt: entry.stall.notifiedAt } : {}) };
          if (entry.stall.nudges >= 2 && !entry.stall.notifiedAt) {
            entry.stall.notifiedAt = timestamp;
            const specReason = decision.reasons.find((reason) => reason.startsWith("spec: ")) ?? "spec items are waiting";
            entry.stall.notification = await notify({
              title: "Baa-ton: the root is not moving",
              body: clipText(`${orchestrator.id}: ${entry.stall.nudges} nudges unanswered since ${entry.stall.since}; ${specReason.replace(/ The run state is.*$/, "")}`, 300),
            });
          }
        }
      }
      // Repeat while the condition holds: every outcome, including an
      // uncertain send, waits one full interval before the next nudge.
      supervisor.nextNudgeAt = nextNudgeAt(timestamp, supervisor.intervalSeconds);
      supervisor.updatedAt = timestamp;
      goal.updatedAt = supervisor.updatedAt;
      await atomicWriteJson(manifestPath, manifest);
      await finishControllerMessage(
        inboxMessage,
        outcome.status,
        { attempts: 1, reason: outcome.reason },
      );
      results.push({ manifestPath, status: outcome.status });
    } catch (error) {
      results.push(await recordManifestSkip(stateDir, { orchestrator, manifestPath, stage: "supervise", error, timestamp }));
    } finally {
      await release();
      // Publish both sides of the mapping; this is best effort, so a missing
      // pane or older Herdr never blocks supervision.
      await publishParticipantSidebar({
        role: "🐕 root",
        paneId: orchestrator.root.pane_id,
        herdr: api,
      });
      for (const candidate of workflows)
        for (const lane of candidate.lanes)
          await publishParticipantSidebar({
            role: "🐑 child",
            paneId: lane.pane_id,
            workflowId: candidate.workflow_id,
            herdr: api,
          });
    }
  }
  // Operator messages ride the same tick (best effort, never blocks it).
  let operator = [];
  try {
    const { operatorStorePath } = await import("../herdr-tools/operator.mjs");
    const { resolveAgentPrompts } = await import("./blocked-lane.mjs");
    // Registered agents' due prompt defaults first; their messages then go out.
    await resolveAgentPrompts({ herdr: api, storePath: operatorStorePath(), timestamp });
    operator = await deliverOperatorQueue({ herdr: api, timestamp });
  } catch {
    operator = [];
  }
  return { accepted: true, results, pendingWakes, ...(operator.length ? { operator } : {}) };
}

function newRecord(event, mapping, classification, identity) {
  return {
    identity,
    received_at: now(),
    event: event.event,
    workflow_id: mapping.workflow.workflow_id,
    lane_id: mapping.lane.lane_id,
    pane_id: mapping.lane.pane_id,
    workspace_id: mapping.lane.workspace_id,
    agent_target: mapping.lane.target,
    ...(mapping.lane.relationship_id
      ? { relationship_id: mapping.lane.relationship_id }
      : {}),
    classification: classification.classification,
    source: classification.source,
    wake: {
      status: ACTIONABLE_CLASSIFICATIONS.has(classification.classification)
        ? "pending"
        : "not-required",
      attempts: 0,
      updated_at: now(),
    },
  };
}

async function updateWake(manifestPath, manifest, record, patch) {
  record.wake = { ...record.wake, ...patch, updated_at: now() };
  await atomicWriteJson(manifestPath, manifest);
}

async function recordRootActivity(config, event, stateDir) {
  const timestamp = now();
  const results = [];
  const seenManifests = new Set();
  for (const entry of configuredParentManifests(config)) {
    const { orchestrator, manifestPath, workflows } = entry;
    // A root status is scoped to its own record; no cross-root activity writes.
    if (!rootEventMatches(event, orchestrator.root)) continue;
    const manifestKey = `${orchestrator.id}:${manifestPath}`;
    if (seenManifests.has(manifestKey)) continue;
    seenManifests.add(manifestKey);
    let release;
    try {
      release = await acquireManifestLock(manifestPath);
    } catch (error) {
      results.push(await recordManifestSkip(stateDir, { orchestrator, manifestPath, stage: "root-activity-lock", error, timestamp }));
      continue;
    }
    try {
      const manifest = parseJson(
        await readRegularFile(manifestPath, "Parent manifest"),
        "Parent manifest",
      );
      for (const candidate of workflows)
        validateMappedWorkflow(
          manifest,
          { workflow: candidate, lane: candidate.lanes[0] },
          config.owner,
        );
      const goal = parentGoalFor(
        manifest,
        orchestrator,
        manifestHasMultipleRoots(config, manifestPath),
      );
      if (!goal || !("supervisor" in goal)) {
        results.push({ manifestPath, status: "no-supervisor" });
        continue;
      }
      // Detection hooks are telemetry, not Pi run boundaries. In particular an
      // idle/done event between tool calls must not release rootTurn or a wake.
      goal.supervisor.rootActivity = {
        status: event.data.agent_status,
        observedAt: timestamp,
      };
      goal.supervisor.updatedAt = timestamp;
      goal.updatedAt = timestamp;
      await atomicWriteJson(manifestPath, manifest);
      results.push({ manifestPath, status: "recorded" });
    } catch (error) {
      results.push(await recordManifestSkip(stateDir, { orchestrator, manifestPath, stage: "root-activity", error, timestamp }));
    } finally {
      await release();
    }
  }
  return { accepted: true, rootActivity: results };
}

/**
 * Handles exactly one hook. It is exported for foreground tests; normal plugin
 * execution calls it with the Herdr-provided environment variables.
 */
export async function handleHook({
  eventName = process.env.HERDR_PLUGIN_EVENT,
  eventJson = process.env.HERDR_PLUGIN_EVENT_JSON,
  stateDir = process.env.HERDR_PLUGIN_STATE_DIR,
  configDir = process.env.HERDR_PLUGIN_CONFIG_DIR ?? stateDir,
  herdr,
} = {}) {
  assertString(eventName, "HERDR_PLUGIN_EVENT");
  const rawEnvelope =
    typeof eventJson === "string"
      ? parseJson(eventJson, "HERDR_PLUGIN_EVENT_JSON")
      : eventJson;
  const event = validateHookEnvelope(eventName, rawEnvelope);
  requireStateDir(stateDir);
  let config;
  try {
    config = await loadConfig(configDir);
  } catch (error) {
    // An enabled controller may receive ordinary pane events before the root
    // has dispatched its first workflow and atomically installed config.json.
    // Only that exact absent-file case is inert; malformed or unsafe existing
    // config remains a visible, fail-closed hook error.
    if (error instanceof ControllerError && error.code === "missing_config")
      return { accepted: true, ignored: true, reason: "missing_config" };
    throw error;
  }
  const mapping = locateMapping(config, event);
  // A linked plugin sees every pane status transition. Root transitions are
  // durable activity evidence for idle-only nudging; other panes are inert.
  if (!mapping) {
    if (
      config.orchestrators.some((orchestrator) =>
        rootEventMatches(event, orchestrator.root),
      )
    ) {
      const activation = await handleActivation(
        configDir,
        event,
        herdr ?? new JsonLineHerdrClient(),
      );
      if (activation) return activation;
      return recordRootActivity(config, event, stateDir);
    }
    // A standalone agent registered on the operator channel (an admin
    // session, an external assistant): its blocked prompts are covered too.
    if (event.data.agent_status === "blocked") {
      try {
        const { operatorStorePath, readOperatorStore } = await import("../herdr-tools/operator.mjs");
        const storePath = operatorStorePath();
        const store = await readOperatorStore(storePath);
        const found = Object.entries(store.agents).find(([, agent]) => agent.paneId === event.data.pane_id && (!agent.workspaceId || agent.workspaceId === event.data.workspace_id));
        if (found) {
          const { handleBlockedAgent } = await import("./blocked-lane.mjs");
          const blocked = await handleBlockedAgent({ herdr: herdr ?? new JsonLineHerdrClient(), name: found[0], agent: found[1], timestamp: now(), storePath, notify: herdrNotification });
          return { accepted: true, operatorAgent: found[0], blocked };
        }
      } catch (error) {
        return { accepted: true, ignored: true, reason: `unmapped_event (operator agent check failed: ${error instanceof Error ? error.message : String(error)})` };
      }
    }
    return { accepted: true, ignored: true, reason: "unmapped_event" };
  }
  const api = herdr ?? new JsonLineHerdrClient();
  const release = await acquireManifestLock(mapping.workflow.manifest_path);
  try {
    const manifest = parseJson(
      await readRegularFile(
        mapping.workflow.manifest_path,
        "Workflow manifest",
      ),
      "Workflow manifest",
    );
    const workflow = validateMappedWorkflow(manifest, mapping, config.owner);
    const sharedManifest = manifestHasMultipleRoots(
      config,
      mapping.workflow.manifest_path,
    );
    const goal = parentGoalFor(manifest, mapping.orchestrator, sharedManifest);
    const routedManifestWorkflows = manifest.workflows.filter((candidate) =>
      mapping.orchestrator.workflows.some(
        (route) => route.workflow_id === candidate.id,
      ),
    );
    const ledger = ensureLedger(workflow);
    // Native protocol 22's pane_agent_status_changed payload carries no
    // occurrence/state_change_seq field (unlike pane_output_changed, whose
    // `revision` already makes its content hash occurrence-aware). Hashing
    // status content alone collapses a genuine repeat transition (blocked ->
    // working -> blocked) into the first occurrence's identity forever.
    // Fence occurrences from our own ordered, durable delivery history
    // instead of inventing an unsupported hook field: a status hook is only
    // a "repeat" of the most recently recorded transition for that exact
    // pane if the reported status actually matches it.
    const priorPaneTransitions =
      event.data.type === "pane_agent_status_changed"
        ? ledger.events.filter(
            (entry) =>
              entry.pane_id === event.data.pane_id &&
              entry.event === event.event,
          )
        : [];
    const previousTransition = priorPaneTransitions.at(-1);
    const postCompletionObservation =
      isPostCompletionLane(workflow, mapping) &&
      POST_COMPLETION_OBSERVATION_STATUSES.has(event.data.agent_status);
    const isRepeatStatus =
      !postCompletionObservation &&
      Boolean(previousTransition) &&
      previousTransition.source?.agent_status === event.data.agent_status;
    const identity =
      event.data.type === "pane_agent_status_changed"
        ? sha256(
            canonicalJson({
              event: event.event,
              data: event.data,
              occurrence: isRepeatStatus
                ? priorPaneTransitions.length - 1
                : priorPaneTransitions.length,
            }),
          )
        : sha256(canonicalJson({ event: event.event, data: event.data }));
    let record = isRepeatStatus
      ? previousTransition
      : ledger.events.find((entry) => entry.identity === identity);
    const created = !record;
    let inboxMessage;
    let queueWake;
    if (!record) {
      const classification = await classifyEvent(event, mapping, api, workflow);
      record = newRecord(event, mapping, classification, identity);
      ledger.events.push(record);
      signalParentGoal(goal, record);
      // Question/approval records are written by the extension rather than a
      // pane hook. Reconcile after the lane breadcrumb so a user request wins
      // over the review-only status and next action from this event.
      signalParentGoalForUserAction(
        goal,
        manifest,
        routedManifestWorkflows,
        sharedManifest,
        mapping.orchestrator,
      );
      // A mapped event also reevaluates terminal parent-goal state. Keep this
      // after ordinary event/user signals so the mismatch action remains the
      // durable instruction presented to the root.
      signalParentGoalMismatch(
        goal,
        manifest,
        mapping.orchestrator.workflows,
      );
      inboxMessage = await persistControllerMessage(configDir, {
        logicalKey: `lane-event:${routeScope(mapping.orchestrator, mapping.workflow.manifest_path)}:${record.workflow_id}/${record.lane_id}/${record.classification}`,
        occurrenceId: record.identity,
        kind: "lifecycle-event",
        from: inboxIdentity(
          record.workspace_id,
          record.pane_id,
          record.source?.agent,
        ),
        to: inboxIdentity(
          mapping.orchestrator.root.workspace_id,
          mapping.orchestrator.root.pane_id,
          mapping.orchestrator.root.agent_kind,
        ),
        payload: record,
        wake: ACTIONABLE_CLASSIFICATIONS.has(record.classification),
      });
      await atomicWriteJson(mapping.workflow.manifest_path, manifest);
      if (goal)
        await publishParentGoalSidebar(
          goal,
          mapping.orchestrator.root,
          api,
          queueStore(manifest),
        );
    } else {
      const userActionChanged = signalParentGoalForUserAction(
        goal,
        manifest,
        routedManifestWorkflows,
        sharedManifest,
        mapping.orchestrator,
      );
      const mismatchChanged = signalParentGoalMismatch(
        goal,
        manifest,
        mapping.orchestrator.workflows,
      );
      if (userActionChanged || mismatchChanged) {
        await atomicWriteJson(mapping.workflow.manifest_path, manifest);
        if (goal)
          await publishParentGoalSidebar(
            goal,
            mapping.orchestrator.root,
            api,
            queueStore(manifest),
          );
      }
    }
    // A lane that turned blocked: read its screen once, approve a known-safe
    // permission prompt, or route the prompt to the root with a default.
    // Every blocked event, repeats included: a lane can move from one prompt
    // to the next without another status, and the handler dedupes by prompt.
    let blocked;
    if (event.data.agent_status === "blocked") {
      const lane = (workflow.lanes ?? []).find((item) => item.id === mapping.lane.lane_id);
      blocked = await handleBlockedLane({
        herdr: api,
        manifest,
        workflow,
        laneId: mapping.lane.lane_id,
        paneId: event.data.pane_id,
        target: mapping.lane.target ?? event.data.pane_id,
        agentKind: lane?.agentKind ?? workflow.agentKind,
        timestamp: record.received_at ?? now(),
      });
      if (blocked.status === "approved" || (blocked.status === "routed" && !blocked.reason)) await atomicWriteJson(mapping.workflow.manifest_path, manifest);
    } else if (event.data.agent_status === "done" && !postCompletionObservation) {
      // Idle without a receipt, asking for direction in plain text.
      blocked = await handleIdleLane({
        herdr: api,
        manifest,
        agentKind: (workflow.lanes ?? []).find((item) => item.id === mapping.lane.lane_id)?.agentKind ?? workflow.agentKind,
        workflow,
        laneId: mapping.lane.lane_id,
        paneId: event.data.pane_id,
        target: mapping.lane.target ?? event.data.pane_id,
        timestamp: record.received_at ?? now(),
      });
      if (blocked.status === "routed") await atomicWriteJson(mapping.workflow.manifest_path, manifest);
    }
    // A queue continuation is evaluated after every mapped lifecycle hook;
    // inbox occurrence dedupe makes repeated post-completion observations safe.
    queueWake = await processQueueHeadWake({
      manifestPath: mapping.workflow.manifest_path,
      manifest,
      workflow,
      mapping,
      configDir,
      herdr: api,
      goal,
      shared: sharedManifest,
    });
    if (!ACTIONABLE_CLASSIFICATIONS.has(record.classification) || blocked?.status === "approved") {
      return { accepted: true, deduplicated: !created, record, queueWake, ...(blocked ? { blocked } : {}) };
    }
    const digest = await dispatchRootDigest({
      orchestrator: mapping.orchestrator,
      manifestPath: mapping.workflow.manifest_path,
      manifest,
      goal,
      configDir,
      herdr: api,
    });
    return { accepted: true, deduplicated: !created, record, queueWake, digest, ...(blocked ? { blocked } : {}) };
  } finally {
    await release();
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user; any other
    // failure (notably ESRCH) means a stale lease may be reclaimed.
    return error.code === "EPERM";
  }
}

async function supervisorLeaseDirectory(configDir) {
  assertString(configDir, "HERDR_PLUGIN_CONFIG_DIR");
  assert(isAbsolute(configDir), "HERDR_PLUGIN_CONFIG_DIR must be absolute.");
  const directory = resolve(configDir);
  const details = await lstat(directory).catch((error) => {
    if (error.code === "ENOENT")
      throw new ControllerError(
        `Controller config directory is missing: ${directory}`,
        "missing_config_directory",
      );
    throw error;
  });
  assert(
    details.isDirectory() &&
      !details.isSymbolicLink() &&
      (!POSIX_MODE_CHECKS || (details.mode & 0o022) === 0),
    `Controller config directory must be a private real directory: ${directory}`,
  );
  return directory;
}

async function acquireSupervisorLease(leaseDirectory) {
  // Herdr may create a fresh state directory for each startup invocation.
  // The plugin config directory is stable per linked plugin, so the singleton
  // lease must live there rather than in an invocation-local state directory.
  const leasePath = join(leaseDirectory, "supervisor.lock");
  while (true) {
    try {
      await mkdir(leasePath, { mode: 0o700 });
      await writeFile(
        join(leasePath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, created_at: now() })}\n`,
        { mode: 0o600 },
      );
      return async () => rm(leasePath, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(
          await readRegularFile(
            join(leasePath, "owner.json"),
            "Supervisor lease",
          ),
        );
        if (
          Number.isSafeInteger(owner.pid) &&
          owner.pid > 0 &&
          !processIsAlive(owner.pid)
        ) {
          await rm(leasePath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // An incomplete or unreadable lease could belong to a process that is
        // still starting. Keep it rather than risking a duplicate supervisor.
      }
      return undefined;
    }
  }
}

const SUPERVISOR_LOG_MAX_BYTES = 1024 * 1024;

/**
 * Append one line to <configDir>/supervisor.log (and stderr), so a
 * supervisor failure is visible without reading any pane. Capped at 1 MB with
 * one rotated file; never throws.
 */
export function supervisorLog(configDir, message) {
  const line = `${new Date().toISOString()} [${process.pid}] ${message}\n`;
  process.stderr.write(`herdr-orchestrator-controller supervisor: ${message}\n`);
  if (!configDir) return;
  const path = join(configDir, "supervisor.log");
  try {
    if (statSync(path).size > SUPERVISOR_LOG_MAX_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // No log yet.
  }
  try {
    appendFileSync(path, line, { mode: 0o600 });
  } catch {
    // Best effort: stderr has it too.
  }
}

/** Exit code the supervisor runner uses to ask its launcher for a restart. */
export const SUPERVISOR_RESTART_EXIT_CODE = 75;

export async function runSupervisorLoop({
  intervalMs = 5_000,
  stateDir = process.env.HERDR_PLUGIN_STATE_DIR,
  configDir = process.env.HERDR_PLUGIN_CONFIG_DIR ?? stateDir,
  herdr,
  // Called (after the lease is released) once the code on disk has changed
  // and stayed stable; the runner exits so its launcher loads the new code.
  onCodeChange,
  codeChanged,
  loaded,
  // Deploy without anyone (self-update.mjs): the real supervisor run tests
  // and fast-forwards new commits; tests pass a fake or nothing.
  selfUpdate,
} = {}) {
  assert(
    Number.isSafeInteger(intervalMs) && intervalMs >= 5_000,
    "Supervisor scheduler interval must be at least 5000ms.",
  );
  const resolvedStateDir = requireStateDir(stateDir);
  const resolvedConfigDir = await supervisorLeaseDirectory(configDir);
  const releaseLease = await acquireSupervisorLease(resolvedConfigDir);
  if (!releaseLease)
    return {
      started: false,
      reason: "supervisor_already_running",
      stop: async () => {},
    };
  const code = onCodeChange ? (loaded ?? loadedCode()) : undefined;
  const changed = onCodeChange ? (codeChanged ?? codeChangeWatcher(code)) : undefined;
  const removeRuntime = code
    ? recordRuntime(resolvedConfigDir, {
        role: "supervisor",
        checkout: code.checkout,
        fingerprint: code.fingerprint,
        commit: code.commit,
      })
    : () => {};
  supervisorLog(resolvedConfigDir, `started${code ? ` on ${code.commit?.slice(0, 12) ?? "?"} (${code.fingerprint}) from ${code.checkout}` : ""}`);
  let updater = selfUpdate;
  if (!updater && onCodeChange && code) {
    try {
      const { createSelfUpdater } = await import("./self-update.mjs");
      // Created on first use: a missing socket must not disable deploys.
      let client;
      const api = {
        request: (method, params) => (client ??= herdr ?? new JsonLineHerdrClient()).request(method, params),
        ...(typeof herdr?.processInfo === "function" ? { processInfo: herdr.processInfo.bind(herdr) } : {}),
      };
      updater = createSelfUpdater({
        configDir: resolvedConfigDir,
        ownCheckout: code.checkout,
        runtime: () => listRuntime(resolvedConfigDir),
        prune: () => pruneRuntime(resolvedConfigDir),
        dialogOpen: async (paneId) => {
          const { classifyScreen, readScreen } = await import("./blocked-lane.mjs");
          return classifyScreen(await readScreen(api, paneId, paneId)).kind !== "unknown";
        },
        // Fail closed: an unreadable config means no root is known, so no reload.
        rootPanes: async () => new Set((await loadConfig(resolvedConfigDir).catch(() => ({ orchestrators: [] }))).orchestrators.map((orchestrator) => orchestrator.root.pane_id)),
        notify: herdrNotification,
        ready: (paneId, expected) => agentReadyForSend(api, paneId, expected),
        prompt: async (paneId, text) => {
          try {
            await api.request("agent.prompt", { target: paneId, text });
          } catch (error) {
            throw Object.assign(error instanceof Error ? error : new Error(String(error)), { sent: Boolean(error?.sent) || !unavailable(error) });
          }
        },
      });
    } catch (error) {
      updater = undefined;
      supervisorLog(resolvedConfigDir, `self-update disabled: could not start the updater: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let stopping = false;
  let ticking = false;
  let timer;
  let inFlightTick;
  let lastTickError;
  let lastUpdateError;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    // Keep the lease until a tick that already owns the manifest lock has
    // settled. A restart must see this process as the supervisor rather than
    // overlap a late socket delivery with a new scheduler.
    await inFlightTick;
    await releaseLease();
    removeRuntime();
  };
  const checkCode = () => {
    if (stopping || !changed) return;
    let fingerprint;
    try {
      fingerprint = changed();
    } catch {
      return;
    }
    if (!fingerprint) return;
    supervisorLog(resolvedConfigDir, `code changed on disk (${code?.fingerprint ?? "?"} -> ${fingerprint}); restarting.`);
    void stop().then(() => onCodeChange(fingerprint));
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  const tick = () => {
    if (stopping || ticking) return Promise.resolve();
    ticking = true;
    const current = (async () => {
      try {
        try {
          await runSupervisorTick({
            stateDir: resolvedStateDir,
            configDir: resolvedConfigDir,
            herdr,
          });
          if (lastTickError) supervisorLog(resolvedConfigDir, "tick recovered");
          lastTickError = undefined;
        } catch (error) {
          // Logged once per distinct error, not every 5 seconds.
          const message = error instanceof Error ? error.message : String(error);
          if (message !== lastTickError) supervisorLog(resolvedConfigDir, `tick failed: ${message}`);
          lastTickError = message;
        }
        // Deploys do not depend on the rest of the tick succeeding.
        if (updater && !stopping) {
          try {
            const update = await updater.tick();
            if (lastUpdateError) supervisorLog(resolvedConfigDir, "self-update recovered");
            lastUpdateError = undefined;
            for (const event of update?.events ?? []) supervisorLog(resolvedConfigDir, `self-update: ${event}`);
          } catch (error) {
            const message = error instanceof Error ? error.stack ?? error.message : String(error);
            if (message !== lastUpdateError) supervisorLog(resolvedConfigDir, `self-update failed: ${message}`);
            lastUpdateError = message;
          }
        }
      } finally {
        ticking = false;
      }
    })();
    inFlightTick = current;
    return current.finally(() => {
      if (inFlightTick === current) inFlightTick = undefined;
      checkCode();
    });
  };
  // Herdr restarts restore panes and agents asynchronously. Do not make an
  // immediate startup nudge race that restoration; the first normal interval
  // is the server-settle window, then later ticks retain the same cadence.
  timer = setInterval(() => void tick(), intervalMs);
  return { started: true, stop, tick };
}

/**
 * The Herdr [[startup]] entry point. Herdr runs startup hooks only when its
 * server starts, so after an update the old supervisor would keep running
 * from memory. The launcher runs the supervisor as a child and starts it again
 * when it exits with SUPERVISOR_RESTART_EXIT_CODE (its code changed on disk).
 * Any other exit ends the launcher, as a crash did before. A runaway guard
 * stops after more than `maxRestarts` restarts within `windowMs`.
 */
export async function runSupervisorLauncher({
  spawnRunner = spawnSupervisorRunner,
  restartDelayMs = 1_000,
  maxRestarts = 5,
  windowMs = 10 * 60_000,
  clock = () => Date.now(),
} = {}) {
  const restarts = [];
  while (true) {
    const exitCode = await spawnRunner();
    if (exitCode !== SUPERVISOR_RESTART_EXIT_CODE) return exitCode;
    const at = clock();
    restarts.push(at);
    while (restarts.length && at - restarts[0] > windowMs) restarts.shift();
    if (restarts.length > maxRestarts) {
      process.stderr.write(
        `herdr-orchestrator-controller supervisor: ${restarts.length} code-change restarts in ${Math.round(windowMs / 60_000)} min; stopping.\n`,
      );
      return exitCode;
    }
    if (restartDelayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, restartDelayMs));
  }
}

function spawnSupervisorRunner() {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "supervisor-run"], {
      stdio: "inherit",
      env: process.env,
      cwd: process.cwd(),
    });
    const forward = (signal) => child.kill(signal);
    process.on("SIGTERM", forward);
    process.on("SIGINT", forward);
    child.on("exit", (exitCode, signal) => {
      process.off("SIGTERM", forward);
      process.off("SIGINT", forward);
      resolveExit(exitCode ?? (signal ? 1 : 0));
    });
    child.on("error", () => resolveExit(1));
  });
}

export function hookResponse(result) {
  if (result.ignored)
    return { accepted: true, ignored: true, reason: result.reason };
  // Root activity hooks intentionally persist supervisor state without adding
  // a lane-event ledger record, so they have no record.identity or wake.
  if (result.rootActivity)
    return { accepted: true, rootActivity: result.rootActivity };
  if (result.operatorAgent)
    return { accepted: true, operatorAgent: result.operatorAgent, blocked: result.blocked };
  return {
    accepted: result.accepted,
    deduplicated: result.deduplicated,
    identity: result.record.identity,
    wake: result.record.wake.status,
    // The blocked-lane (or idle-question) outcome, for `herdr plugin log`.
    ...(result.blocked ? { blocked: result.blocked } : {}),
  };
}

async function main() {
  const command = process.argv[2];
  if (command === "hook") {
    const result = await handleHook();
    process.stdout.write(`${JSON.stringify(hookResponse(result))}\n`);
    return;
  }
  if (command === "supervisor-once") {
    process.stdout.write(`${JSON.stringify(await runSupervisorTick())}\n`);
    return;
  }
  if (command === "supervisor") {
    process.exitCode = await runSupervisorLauncher();
    return;
  }
  if (command === "supervisor-run") {
    await runSupervisorLoop({
      onCodeChange: () => process.exit(SUPERVISOR_RESTART_EXIT_CODE),
    });
    return;
  }
  throw new ControllerError(
    "Usage: node controller.mjs <hook|supervisor-once|supervisor|supervisor-run>.",
    "usage",
  );
}

let launchedDirectly = false;
try {
  // Compare real paths: a plugin root reached through a symlink (for
  // example macOS /var -> /private/var) must still run main().
  launchedDirectly =
    Boolean(process.argv[1]) &&
    realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  launchedDirectly = false;
}
if (launchedDirectly) {
  main().catch((error) => {
    process.stderr.write(
      `herdr-orchestrator-controller: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
