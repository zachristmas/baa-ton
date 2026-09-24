// VENDORED, DO NOT EDIT. Parent-goal validation copied verbatim from
// packages/controller/controller.mjs at 974a77d, the last release before the
// lane-admin series. Lanes dispatched before an upgrade keep running MCP
// bridges loaded from that code, and it rejects unknown keys in parent goals
// and their supervisors. controller.test.mjs runs manifests written by current
// code through it. Re-vendor (keep the old copy) when the oldest supported
// release changes.

const MIN_NUDGE_INTERVAL_SECONDS = 5;

const MAX_NUDGE_INTERVAL_SECONDS = 86_400;

const ACTIONABLE_CLASSIFICATIONS = new Set([
  "done",
  "blocked",
  "goal-paused",
]);

const SUPERVISOR_STATES = new Set(["running", "stopped", "paused"]);

const AGENT_STATUSES = new Set([
  "idle",
  "working",
  "blocked",
  "done",
  "unknown",
]);

class ControllerError extends Error {
  constructor(message, code = "controller_error") {
    super(message);
    this.name = "ControllerError";
    this.code = code;
  }
}

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

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
    ],
  );
  assert(
    value.version === 1,
    "manifest.parentGoal.supervisor.version must be 1.",
  );
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

export { validateParentGoal };
