#!/usr/bin/env node
/**
 * Harness-neutral durable inbox/outbox.
 *
 * The storage format intentionally keeps the herdr-link/1 envelope shape at
 * the edge while adding the durability and delivery state that Link does not
 * provide.  Every write is a short, locked, atomic JSON transaction.  Callers
 * must perform terminal/network effects after the `stored` transaction and
 * record the resulting delivery state in a later transaction.
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
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const HERDR_LINK_PROTOCOL = "herdr-link/1";
export const INBOX_STORE_VERSION = 1;
export const MESSAGE_STATES = [
  "stored",
  "notified",
  "received",
  "acknowledged",
  "resolved",
];

const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 10;
const STORE_NAME = "inbox.json";
const STATE_ORDER = new Map(
  MESSAGE_STATES.map((state, index) => [state, index]),
);
// The filesystem lock coordinates separate bridge/controller processes. A
// process-local queue additionally preserves invocation order for concurrent
// callers in one process, so a logical retry cannot win the lock ahead of the
// original call merely due to event-loop scheduling.
const transactionQueues = new Map();

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertString(value, label) {
  assert(
    typeof value === "string" && value.length > 0,
    `${label} must be a non-empty string.`,
  );
  return value;
}

function now() {
  return new Date().toISOString();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function identity(value, label) {
  const input = isRecord(value) ? value : {};
  return {
    workspace_id: assertString(input.workspace_id, `${label}.workspace_id`),
    pane_id: assertString(input.pane_id, `${label}.pane_id`),
    ...(typeof input.agent === "string" && input.agent
      ? { agent: input.agent }
      : {}),
    ...(typeof input.session_id === "string" && input.session_id
      ? { session_id: input.session_id }
      : {}),
  };
}

/**
 * Whether a message between these endpoints can use the inbox: herdr-link/1
 * stays within one Herdr workspace. Cross-workspace routes (a lane in its
 * worktree's own workspace reporting to the root) go through the manifest
 * and the controller's hooks instead; callers skip the inbox for them.
 */
export function inboxRoutable(from, to) {
  return isRecord(from) && isRecord(to) && typeof from.workspace_id === "string" && from.workspace_id === to.workspace_id;
}

export function makeEnvelope({
  logicalKey,
  occurrenceId = randomUUID(),
  kind,
  from,
  to,
  payload = {},
}) {
  const logical = assertString(logicalKey, "logicalKey");
  const occurrence = assertString(occurrenceId, "occurrenceId");
  const sender = identity(from, "from");
  const recipient = identity(to, "to");
  assert(
    sender.workspace_id === recipient.workspace_id,
    "herdr-link/1 messages must remain within the same Herdr workspace.",
  );
  assert(isRecord(payload), "herdr-link/1 message payload must be an object.");
  return {
    protocol: HERDR_LINK_PROTOCOL,
    id: occurrence,
    from: sender,
    to: recipient,
    message: {
      type: assertString(kind, "message.type"),
      logical_key: logical,
      occurrence_id: occurrence,
      payload,
    },
  };
}

export function storePath({ stateDir, manifestPath } = {}) {
  const directory =
    stateDir ?? (manifestPath ? dirname(manifestPath) : undefined);
  assertString(directory, "inbox state directory");
  assert(isAbsolute(directory), "inbox state directory must be absolute.");
  return join(resolve(directory), STORE_NAME);
}

function emptyStore() {
  return {
    version: INBOX_STORE_VERSION,
    revision: 0,
    messages: [],
    wake_hints: [],
  };
}

function validateStore(value) {
  assert(isRecord(value), "Inbox store must be an object.");
  assert(
    value.version === INBOX_STORE_VERSION,
    "Inbox store version is unsupported.",
  );
  assert(
    Number.isSafeInteger(value.revision) && value.revision >= 0,
    "Inbox store revision is invalid.",
  );
  assert(
    Array.isArray(value.messages),
    "Inbox store messages must be an array.",
  );
  assert(
    Array.isArray(value.wake_hints),
    "Inbox store wake_hints must be an array.",
  );
  return value;
}

async function loadUnlocked(path) {
  try {
    return validateStore(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function acquireLock(path) {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath, { recursive: false, mode: 0o700 });
      await writeFile(
        join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, created_at: now() })}\n`,
        { mode: 0o600 },
      );
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw new Error(`Timed out acquiring inbox lock for ${path}.`);
      await new Promise((resolveSleep) =>
        setTimeout(resolveSleep, LOCK_RETRY_MS),
      );
    }
  }
}

async function transaction(path, mutate) {
  const resolvedPath = resolve(path);
  const previous = transactionQueues.get(resolvedPath) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const release = await acquireLock(resolvedPath);
      try {
        const store = await loadUnlocked(resolvedPath);
        const result = await mutate(store);
        store.revision += 1;
        await atomicWrite(resolvedPath, store);
        return result;
      } finally {
        await release();
      }
    });
  transactionQueues.set(resolvedPath, operation);
  try {
    return await operation;
  } finally {
    if (transactionQueues.get(resolvedPath) === operation)
      transactionQueues.delete(resolvedPath);
  }
}

export async function readStore(path) {
  return loadUnlocked(resolve(path));
}

function messageAt(store, occurrenceId) {
  const message = store.messages.find(
    (candidate) => candidate.occurrence_id === occurrenceId,
  );
  assert(
    message,
    `No durable inbox message exists with occurrence ${occurrenceId}.`,
  );
  return message;
}

function stateEntry(at, details = {}) {
  return { at, ...details };
}

function setState(message, state, details = {}) {
  const current = MESSAGE_STATES.findLast(
    (candidate) => message.states[candidate],
  );
  if (current && STATE_ORDER.get(state) < STATE_ORDER.get(current))
    throw new Error(
      `Inbox message state cannot move from ${current} to ${state}.`,
    );
  if (!message.states[state])
    message.states[state] = stateEntry(now(), details);
  return message.states[state];
}

function messageView(message) {
  return structuredClone(message);
}

/**
 * Persist one message before any notification. `dedupe: "logical"` reuses an
 * unresolved occurrence; `dedupe: "occurrence"` lets each new transition of
 * the same logical event coexist while remaining idempotent by occurrence ID.
 */
export async function putMessage(
  path,
  {
    envelope,
    logicalKey,
    occurrenceId,
    kind,
    from,
    to,
    payload,
    dedupe = "logical",
  },
) {
  const resolvedPath = resolve(path);
  const candidate =
    envelope ??
    makeEnvelope({ logicalKey, occurrenceId, kind, from, to, payload });
  assert(
    candidate.protocol === HERDR_LINK_PROTOCOL,
    "Inbox envelope protocol must be herdr-link/1.",
  );
  const logical = candidate.message.logical_key;
  const occurrence = candidate.message.occurrence_id;
  return transaction(resolvedPath, (store) => {
    const byOccurrence = store.messages.find(
      (message) => message.occurrence_id === occurrence,
    );
    if (byOccurrence)
      return {
        created: false,
        message: messageView(byOccurrence),
        revision: store.revision,
      };
    if (dedupe === "logical") {
      const unresolved = store.messages.find(
        (message) =>
          message.logical_key === logical && !message.states.resolved,
      );
      if (unresolved)
        return {
          created: false,
          message: messageView(unresolved),
          revision: store.revision,
        };
    }
    const timestamp = now();
    const message = {
      envelope: candidate,
      logical_key: logical,
      occurrence_id: occurrence,
      states: {
        stored: stateEntry(timestamp),
        notified: null,
        received: null,
        acknowledged: null,
        resolved: null,
      },
      delivery: { status: "pending", attempts: 0, updated_at: timestamp },
      created_at: timestamp,
      updated_at: timestamp,
    };
    store.messages.push(message);
    return {
      created: true,
      message: messageView(message),
      revision: store.revision,
    };
  });
}

export async function getMessage(path, occurrenceId) {
  const store = await readStore(path);
  const message = store.messages.find(
    (candidate) => candidate.occurrence_id === occurrenceId,
  );
  return message ? messageView(message) : undefined;
}

export async function findMessage(path, predicate) {
  const store = await readStore(path);
  const message = store.messages.find(predicate);
  return message ? messageView(message) : undefined;
}

export async function updateMessage(path, occurrenceId, update = {}) {
  return transaction(resolve(path), (store) => {
    const message = messageAt(store, occurrenceId);
    if (update.state) setState(message, update.state, update.details);
    if (update.delivery) {
      assert(
        [
          "pending",
          "sending",
          "notified",
          "delivered",
          "uncertain",
          "acknowledged",
          "resolved",
        ].includes(update.delivery.status),
        "Inbox delivery status is invalid.",
      );
      message.delivery = {
        ...message.delivery,
        ...update.delivery,
        updated_at: now(),
      };
    }
    if (update.result !== undefined)
      message.result = structuredClone(update.result);
    if (update.resolution !== undefined)
      message.resolution = structuredClone(update.resolution);
    message.updated_at = now();
    return messageView(message);
  });
}

export async function markState(path, occurrenceId, state, details = {}) {
  return updateMessage(path, occurrenceId, { state, details });
}

export async function markDelivery(path, occurrenceId, status, details = {}) {
  const state = status === "delivered" ? "notified" : status;
  return updateMessage(path, occurrenceId, {
    delivery: { status, ...details },
    ...(state === "notified" ? { state, details } : {}),
  });
}

/**
 * Add a message to one coalesced recipient wake hint. The hint is durable
 * metadata only; callers still retain and reconcile each message separately.
 */
export async function enqueueWakeHint(path, { recipient, occurrenceId }) {
  const target = identity(recipient, "recipient");
  assertString(occurrenceId, "occurrenceId");
  return transaction(resolve(path), (store) => {
    let hint = store.wake_hints.find(
      (candidate) =>
        candidate.status === "pending" &&
        candidate.recipient.workspace_id === target.workspace_id &&
        candidate.recipient.pane_id === target.pane_id,
    );
    const timestamp = now();
    if (!hint) {
      hint = {
        id: randomUUID(),
        recipient: target,
        occurrence_ids: [],
        status: "pending",
        attempts: 0,
        created_at: timestamp,
        updated_at: timestamp,
      };
      store.wake_hints.push(hint);
    }
    const added = !hint.occurrence_ids.includes(occurrenceId);
    if (added) hint.occurrence_ids.push(occurrenceId);
    hint.updated_at = timestamp;
    return {
      created: added,
      hint: structuredClone(hint),
      revision: store.revision,
    };
  });
}

export async function markWakeHint(path, hintId, status, details = {}) {
  return transaction(resolve(path), (store) => {
    const hint = store.wake_hints.find((candidate) => candidate.id === hintId);
    assert(hint, `No durable wake hint exists with ID ${hintId}.`);
    assert(
      ["pending", "notified", "uncertain", "resolved"].includes(status),
      "Wake hint status is invalid.",
    );
    hint.status = status;
    hint.attempts += status === "pending" || status === "uncertain" ? 1 : 0;
    Object.assign(hint, details, { updated_at: now() });
    return structuredClone(hint);
  });
}

export async function pendingMessages(path, { recipient, kinds } = {}) {
  const store = await readStore(path);
  return store.messages
    .filter((message) => {
      if (message.states.resolved) return false;
      if (message.delivery.status === "uncertain") return false;
      if (
        recipient &&
        (message.envelope.to.workspace_id !== recipient.workspace_id ||
          message.envelope.to.pane_id !== recipient.pane_id)
      )
        return false;
      if (kinds && !kinds.includes(message.envelope.message.type)) return false;
      return true;
    })
    .map(messageView);
}

/**
 * Reconcile pending records without performing I/O. The controller supplies a
 * delivery callback, which runs outside the store transaction and then calls
 * markDelivery/markState. This keeps the substrate useful to every adapter.
 */
export async function reconcilePending(
  path,
  { recipient, kinds, deliver } = {},
) {
  assert(
    typeof deliver === "function",
    "reconcilePending requires a deliver callback.",
  );
  const pending = await pendingMessages(path, { recipient, kinds });
  const results = [];
  for (const message of pending) {
    const result = await deliver(messageView(message));
    results.push({ occurrenceId: message.occurrence_id, result });
  }
  return results;
}

function permissionDecision(answer, input) {
  if (isRecord(answer)) return answer;
  if (typeof answer === "string") {
    try {
      const parsed = JSON.parse(answer);
      if (
        isRecord(parsed) &&
        (parsed.behavior === "allow" || parsed.behavior === "deny")
      )
        return parsed;
    } catch {
      // Plain-text answers remain safe denials below.
    }
    if (answer.trim().toLowerCase() === "allow")
      return { behavior: "allow", updatedInput: input };
  }
  return {
    behavior: "deny",
    message:
      typeof answer === "string" && answer.trim()
        ? answer
        : "Permission remains pending parent approval.",
  };
}

/** Store a parent answer. It never releases a waiting permission request. */
export async function answerMessage(
  path,
  occurrenceId,
  answer,
  { uncertain = false } = {},
) {
  return transaction(resolve(path), (store) => {
    const message = messageAt(store, occurrenceId);
    assert(
      message.envelope.message.type === "permission-request",
      "Only permission requests accept broker answers.",
    );
    if (message.resolution?.answer !== undefined)
      return { stored: false, message: messageView(message) };
    message.resolution = {
      answer,
      decision: permissionDecision(
        answer,
        message.envelope.message.payload.input,
      ),
      released_at: null,
      release_count: 0,
    };
    message.delivery = {
      ...message.delivery,
      status: uncertain ? "uncertain" : "acknowledged",
      updated_at: now(),
    };
    setState(message, "received", { answer_received: true });
    setState(message, "acknowledged", { answer_stored: true });
    message.updated_at = now();
    return { stored: true, message: messageView(message) };
  });
}

/**
 * Release a parent decision to the waiting harness exactly once. A transport
 * uncertainty never becomes an allow: it remains pending until reconciled.
 */
export async function releasePermission(path, occurrenceId) {
  return transaction(resolve(path), (store) => {
    const message = messageAt(store, occurrenceId);
    const resolution = message.resolution;
    if (!resolution)
      return { released: false, pending: true, message: messageView(message) };
    if (message.delivery.status === "uncertain")
      return {
        released: false,
        pending: true,
        uncertain: true,
        message: messageView(message),
      };
    if (resolution.released_at)
      return {
        released: false,
        replay: true,
        decision: structuredClone(resolution.decision),
        message: messageView(message),
      };
    resolution.released_at = now();
    resolution.release_count = 1;
    message.delivery = {
      ...message.delivery,
      status: "resolved",
      updated_at: now(),
    };
    if (!message.states.received && !message.states.acknowledged)
      setState(message, "received", { decision_released: true });
    setState(message, "resolved", { decision_released: true });
    message.updated_at = now();
    return {
      released: true,
      decision: structuredClone(resolution.decision),
      message: messageView(message),
    };
  });
}
