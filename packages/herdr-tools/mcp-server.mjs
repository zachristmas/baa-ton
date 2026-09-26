#!/usr/bin/env node
/**
 * Local stdio MCP bridge for the Herdr Orchestrator workflow tools.
 *
 * It deliberately reuses the registered tool implementations so every harness
 * has the same validation, root gates, and durable manifest behavior. This
 * process is not a dispatcher or background worker.
 */
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { Value } from "typebox/value";
import { Type } from "typebox";
import {
  answerMessage,
  digest,
  enqueueWakeHint,
  findMessage,
  makeEnvelope,
  markDelivery,
  markState,
  putMessage,
  releasePermission,
  storePath,
  updateMessage,
} from "./inbox/index.mjs";
import {
  applyHerdrIdentity,
  clearAppliedHerdrIdentity,
  resolveHerdrIdentity,
} from "./live-identity.mjs";
import {
  CONTROLLER_PLUGIN_ID,
  liveHerdrAgentList,
  liveHerdrConfigDirectory,
  liveHerdrPaneProcessInfo,
  spawnHerdrProcess,
} from "./live-herdr.mjs";
import { liveProcessParentPid } from "./live-process.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const createJiti = require("jiti");
const jiti = createJiti(fileURLToPath(import.meta.url), {
  alias: { typebox: require.resolve("typebox") },
});
const extension = await jiti.import(join(root, "index.ts"));

// The bridge must expose the same installed model registry the interactive
// runtime uses. Discovery refreshes the requested provider immediately before
// preflight; keeping this bridge-start registry snapshot out of preflight is
// important because a stale catalog must never authorize a launch. The package
// exports map does not expose internals, so resolve them by absolute file path.
let packageRoot = null;
for (let dir = root; dir !== dirname(dir); dir = dirname(dir)) {
  const candidate = join(
    dir,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  if (existsSync(join(candidate, "package.json"))) {
    packageRoot = candidate;
    break;
  }
}
if (!packageRoot)
  throw new Error(
    "pi-coding-agent package not found for the MCP bridge model registry.",
  );
const importDist = (name) =>
  import(pathToFileURL(join(packageRoot, "dist", name)).href);
const { ModelRuntime } = await importDist("core/model-runtime.js");
const { ModelRegistry } = await importDist("core/model-registry.js");
// Do not refresh at bridge startup. The registry is intentionally only a
// runtime handle here; pi-launch-adapter's discoverCatalog performs a
// provider-scoped live refresh and fails closed on any refresh error. This
// prevents a frozen bridge-start snapshot from becoming a preflight fallback.
const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
const modelRegistry = new ModelRegistry(modelRuntime);
const tools = new Map();
const lifecycleHandlers = new Map();
const activeRequests = new Map();
extension.default({
  on(event, handler) {
    if (typeof event !== "string" || typeof handler !== "function") return;
    const handlers = lifecycleHandlers.get(event) ?? [];
    handlers.push(handler);
    lifecycleHandlers.set(event, handlers);
  },
  registerTool(definition) {
    if (definition.name.startsWith("herdr_"))
      tools.set(definition.name, definition);
  },
  registerCommand() {},
  async exec(command, args, options = {}) {
    const result = await new Promise((resolveResult) => {
      const child =
        command === "herdr"
          ? spawnHerdrProcess(command, args, {
              cwd: process.cwd(),
              env: process.env,
              spawnProcess: require("node:child_process").spawn,
              stdio: ["ignore", "pipe", "pipe"],
            })
          : require("node:child_process").spawn(command, args, {
              cwd: options.cwd ?? process.cwd(),
              env: process.env,
              stdio: ["ignore", "pipe", "pipe"],
            });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        resolveResult(value);
      };
      const abort = () => {
        child.kill("SIGTERM");
        finish({ stdout, stderr, code: null, cancelled: true });
      };
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code, signal) =>
        finish({ stdout, stderr, code, signal }),
      );
      child.on("error", (error) =>
        finish({ stdout, stderr: `${stderr}${error.message}`, code: 1 }),
      );
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
      if (Number.isFinite(options.timeout) && options.timeout > 0)
        timer = setTimeout(() => {
          child.kill("SIGTERM");
          finish({ stdout, stderr, code: null, timedOut: true });
        }, options.timeout);
    });
    return result;
  },
  sendMessage() {},
});

async function refreshCurrentHerdrIdentity() {
  const configuredDirectory = process.env.HERDR_PLUGIN_CONFIG_DIR;
  const configuredConfig =
    configuredDirectory && isAbsolute(configuredDirectory)
      ? join(resolve(configuredDirectory), "config.json")
      : undefined;
  if (!configuredConfig || !existsSync(configuredConfig)) {
    try {
      const directory = await liveHerdrConfigDirectory(CONTROLLER_PLUGIN_ID);
      if (isAbsolute(directory))
        process.env.HERDR_PLUGIN_CONFIG_DIR = resolve(directory);
    } catch {
      // Identity resolution and read-only diagnostics retain their existing
      // fallback behavior if a live config-dir query is unavailable.
    }
  }
  const identity = await resolveHerdrIdentity({
    env: process.env,
    listAgents: liveHerdrAgentList,
    listPaneProcesses: ({ paneId }) => liveHerdrPaneProcessInfo(paneId),
    currentProcessPids: [process.pid, process.ppid],
    currentProcessPid: process.pid,
    getParentPid: liveProcessParentPid,
    maxProcessAncestorDepth: 8,
    currentCwd: process.cwd(),
    allowStaticFallback: staticRootFallbackAllowed,
  });
  applyHerdrIdentity(process.env, identity);
  return identity;
}

// Record which code this bridge loaded so herdr_doctor can report version
// skew (a lane keeps its bridge for its whole session, across updates).
if (process.env.HERDR_ENV === "1" && process.env.BAA_TON_NO_RUNTIME_RECORDS !== "1") {
  try {
    const { loadedCode, recordRuntime } = await import(
      pathToFileURL(join(root, "..", "controller", "code-version.mjs")).href
    );
    const code = loadedCode();
    recordRuntime(configDirectory(), {
      role: "bridge",
      checkout: code.checkout,
      fingerprint: code.fingerprint,
      commit: code.commit,
      paneId: process.env.HERDR_PANE_ID,
      workspaceId: process.env.HERDR_WORKSPACE_ID,
    });
  } catch {
    // Version reporting is best effort and never blocks the bridge.
  }
}

const permissionToolName =
  "mcp__herdr-orchestrator__herdr_permission_prompt";

// herdr_message owns its manifest record and controller-routed child-message
// inbox entry; it is intentionally not wrapped in the generic MCP mutation
// envelope, which would create a second inbox record.
const mutationKinds = new Map([
  ["herdr_goal", "goal"],
  ["herdr_question_answer", "answer"],
  ["herdr_complete", "completion"],
  ["herdr_operator_close", "lifecycle"],
  ["herdr_plan", "lifecycle"],
  ["herdr_dispatch", "lifecycle"],
  ["herdr_resume", "lifecycle"],
  ["herdr_close", "lifecycle"],
]);

// MCP clients do not receive the Pi extension's before_agent_start prompt.
// Keep this short, harness-neutral briefing next to the bridge so a manually
// started non-Pi root gets the same operating contract after bootstrap.
const ROOT_BRIEFING = [
  "ROOT BRIEFING",
  "You are the sole Baa-ton parent executor. The durable manifest is authoritative; inspect it before making workflow decisions.",
  "Delegate only with herdr_plan, then herdr_dispatch. Every child is a new Herdr-created session; never create Pi subagents, background jobs, or detached work.",
  "Treat child lifecycle, child-message, parent-question-required, parent-approval-required, and blocker records as durable signals. Children persist requests and Herdr wakes the root; do not poll or ask the user to operate a child pane or Pi goal UI. Persist a truthful goal state when waiting, blocked, paused, or complete.",
  "Push, merge, PR, deploy, production mutation, and Herdr resource closure require explicit user approval. Close only extension-owned resources with evidence.",
].join("\n");

const ROOT_EXECUTOR_TOOLS = new Set([
  "herdr_goal",
  "herdr_question_answer",
  "herdr_operator_close",
  "herdr_plan",
  "herdr_reconcile_root",
  "herdr_tell",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function timestamp() {
  return new Date().toISOString();
}

function configDirectory() {
  const directory =
    process.env.HERDR_PLUGIN_CONFIG_DIR ?? process.env.HERDR_PLUGIN_STATE_DIR;
  if (directory && isAbsolute(directory)) {
    const configured = resolve(directory);
    if (existsSync(join(configured, "config.json"))) return configured;
  }
  // Match index.ts's rootConfigPath fallback so Claude/OpenCode callers that
  // inherit only the pane identity still resolve the controller route. On
  // Windows Herdr stores plugin config under AppData rather than .config.
  return process.platform === "win32"
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
}

async function readControllerConfig() {
  const directory = configDirectory();
  if (!directory) return undefined;
  try {
    return JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function agentAtIdentity(agent, identity) {
  const kind = agent?.agent ?? agent?.agent_session?.agent;
  return (
    kind === "claude" &&
    agent?.pane_id === identity.paneId &&
    agent?.workspace_id === identity.workspaceId
  );
}

async function staticRootFallbackAllowed({ fallback, agents }) {
  if (!fallback.paneId || !fallback.workspaceId) return false;
  const config = await readControllerConfig();
  const roots =
    config?.version === 1
      ? [config.root]
      : config?.orchestrators?.map((orchestrator) => orchestrator.root) ?? [];
  const registered = roots.some(
    (root) =>
      root?.pane_id === fallback.paneId &&
      root?.workspace_id === fallback.workspaceId,
  );
  return registered && agents.some((agent) => agentAtIdentity(agent, fallback));
}

function endpointFromEnvironment() {
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  const paneId = process.env.HERDR_PANE_ID;
  if (!workspaceId || !paneId) return undefined;
  const agent = process.env.HERDR_AGENT_KIND ?? process.env.HERDR_AGENT;
  return {
    workspace_id: workspaceId,
    pane_id: paneId,
    ...(agent ? { agent } : {}),
  };
}

function routeManifest(orchestrator) {
  if (orchestrator.program?.parent_manifest_path)
    return resolve(orchestrator.program.parent_manifest_path);
  const first = orchestrator.workflows?.find((workflow) => workflow.manifest_path);
  return first?.manifest_path ? resolve(first.manifest_path) : undefined;
}

async function currentRoute() {
  const self = endpointFromEnvironment();
  if (!self) return undefined;
  const config = await readControllerConfig();
  if (!config) return undefined;
  const orchestrators =
    config.version === 1
      ? [
          {
            id: `legacy:${config.root?.workspace_id}:${config.root?.pane_id}`,
            root: config.root,
            program: { id: process.cwd(), workspace_id: config.root?.workspace_id },
            workflows: config.workflows ?? [],
          },
        ]
      : config.orchestrators ?? [];
  for (const orchestrator of orchestrators) {
    if (
      orchestrator.root?.pane_id === self.pane_id &&
      orchestrator.root?.workspace_id === self.workspace_id
    )
      return {
        role: "root",
        orchestrator,
        root: orchestrator.root,
        manifestPath: routeManifest(orchestrator),
        workflowId: undefined,
        laneId: undefined,
      };
    for (const workflow of orchestrator.workflows ?? [])
      for (const lane of workflow.lanes ?? [])
        if (
          lane.pane_id === self.pane_id &&
          lane.workspace_id === self.workspace_id
        )
          return {
            role: "lane",
            orchestrator,
            root: orchestrator.root,
            manifestPath: routeManifest(orchestrator),
            workflowId: workflow.workflow_id,
            laneId: lane.lane_id,
            lane,
          };
  }
  return undefined;
}

async function acquireManifestLock(manifestPath) {
  const lockPath = join(
    dirname(manifestPath),
    `.${basename(manifestPath)}.herdr-orchestrator.lock`,
  );
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("Timed out acquiring MCP lifecycle lock.");
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
    }
  }
}

async function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function updateManifest(manifestPath, mutate) {
  if (!manifestPath) return false;
  let details;
  try {
    details = await lstat(manifestPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!details.isFile()) throw new Error("MCP lifecycle manifest is not a regular file.");
  const release = await acquireManifestLock(manifestPath);
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const changed = await mutate(manifest);
    if (changed) await atomicWriteJson(manifestPath, manifest);
    return changed;
  } finally {
    await release();
  }
}

async function persistBridgeLifecycle(route, state, runId) {
  if (!route || route.role !== "root") return;
  const self = endpointFromEnvironment();
  await updateManifest(route.manifestPath, (manifest) => {
    const supervisor = manifest.parentGoal?.supervisor;
    if (!supervisor || !self) return false;
    if (
      state !== "active" &&
      supervisor.rootTurn &&
      supervisor.rootTurn.runId !== runId
    )
      return false;
    supervisor.rootTurn = {
      state,
      runId,
      paneId: self.pane_id,
      workspaceId: self.workspace_id,
      updatedAt: timestamp(),
    };
    supervisor.updatedAt = supervisor.rootTurn.updatedAt;
    if (manifest.parentGoal) manifest.parentGoal.updatedAt = supervisor.updatedAt;
    return true;
  });
}

function lifecycleContext(controller, state) {
  return {
    ...ctx,
    signal: controller.signal,
    isIdle: () => state === "idle",
    abort: () => controller.abort(),
    sessionManager: {
      getSessionFile: () => process.env.HERDR_SESSION_PATH,
    },
  };
}

async function emitLifecycle(event, controller, state) {
  for (const handler of lifecycleHandlers.get(event) ?? [])
    await handler({}, lifecycleContext(controller, state));
}

async function beginMcpTurn(requestId, controller) {
  const runId = `mcp-${String(requestId)}-${randomUUID()}`;
  const route = await currentRoute();
  await persistBridgeLifecycle(route, "active", runId);
  await emitLifecycle("before_agent_start", controller, "active");
  await emitLifecycle("agent_start", controller, "active");
  // The extension lifecycle handler owns its own Pi run identifier. Reassert
  // this bridge request's active lease after those handlers so the matching
  // settled/cancelled transition can close exactly this MCP turn.
  await persistBridgeLifecycle(route, "active", runId);
  return { runId, route };
}

async function endMcpTurn(turn, controller) {
  const state = controller.signal.aborted ? "unknown" : "idle";
  try {
    await emitLifecycle("agent_settled", controller, state);
  } finally {
    await persistBridgeLifecycle(turn.route, state, turn.runId);
  }
}

function bridgeStorePath(route) {
  const directory = configDirectory();
  return directory
    ? storePath({ stateDir: directory })
    : route?.manifestPath
      ? storePath({ manifestPath: route.manifestPath })
      : undefined;
}

function bridgeMessageEndpoints(route) {
  const from = endpointFromEnvironment();
  if (!route || !from || !route.root) return undefined;
  const to = {
    workspace_id: route.root.workspace_id,
    pane_id: route.root.pane_id,
    ...(route.root.agent_kind ? { agent: route.root.agent_kind } : {}),
  };
  return { from, to };
}

async function persistBridgeMessage(name, args, requestId) {
  const kind = mutationKinds.get(name);
  if (!kind) return undefined;
  const route = await currentRoute();
  const endpoints = bridgeMessageEndpoints(route);
  const path = bridgeStorePath(route);
  if (!route || !endpoints || !path) return undefined;
  const logicalKey = `${kind}:${route.workflowId ?? "root"}:${route.laneId ?? route.root.pane_id}:${name}:${digest(args)}`;
  // JSON-RPC request IDs are only unique enough for an in-flight request. A
  // harness may reuse one across turns, so the durable occurrence must also
  // include the payload-bound logical key; otherwise a fresh plan can resolve
  // to an old, already-resolved message and regress it to received.
  const occurrenceId = `${name}:${String(requestId)}:${digest(logicalKey)}`;
  const stored = await putMessage(path, {
    envelope: makeEnvelope({
      logicalKey,
      occurrenceId,
      kind,
      from: endpoints.from,
      to: endpoints.to,
      payload: args,
    }),
  });
  if (stored.created)
    await markState(path, stored.message.occurrence_id, "received", {
      transport: "mcp",
    });
  await enqueueWakeHint(path, {
    recipient: endpoints.to,
    occurrenceId: stored.message.occurrence_id,
  });
  return { path, route, message: stored.message, created: stored.created };
}

async function finishBridgeMessage(entry, output) {
  if (!entry) return;
  await updateMessage(entry.path, entry.message.occurrence_id, {
    result: output,
    delivery: { status: "resolved" },
  });
  await markState(entry.path, entry.message.occurrence_id, "acknowledged", {
    transport: "mcp",
  });
  await markState(entry.path, entry.message.occurrence_id, "resolved", {
    transport: "mcp",
  });
}

async function failBridgeMessage(entry, error, uncertain) {
  if (!entry) return;
  await markDelivery(
    entry.path,
    entry.message.occurrence_id,
    uncertain ? "uncertain" : "pending",
    { reason: error instanceof Error ? error.message : String(error) },
  );
}

function pendingToolResult(message, text) {
  return {
    content: [{ type: "text", text }],
    isError: true,
    details: { pending: true, occurrenceId: message.occurrence_id },
  };
}

async function answerPermissionFromBridge(args) {
  const route = await currentRoute();
  if (!route || route.role !== "root") return undefined;
  const path = bridgeStorePath(route);
  if (!path) return undefined;
  const existing = await findMessage(
    path,
    (message) =>
      message.occurrence_id === args.requestId &&
      message.envelope.message.type === "permission-request",
  );
  if (!existing) return undefined;
  const stored = await answerMessage(path, args.requestId, args.answer);
  return {
    content: [
      {
        type: "text",
        text: `Stored permission answer for ${args.requestId}; the child must re-present the request for release.`,
      },
    ],
    details: stored,
  };
}

async function permissionPrompt(args) {
  if (process.env.HERDR_ENV !== "1")
    throw new Error("Permission broker is available only inside a HERDR_ENV=1 session.");
  const route = await currentRoute();
  if (!route || route.role !== "lane")
    throw new Error("Permission broker requires a registered Herdr child lane.");
  // A runtime command that matches the acknowledged approvalPolicy for this
  // lane's own leases is answered here; anything else keeps the deny-by-default
  // broker path below.
  let policyAnswer;
  try {
    policyAnswer = await tools.get("herdr_request")?.execute(
      `permission-policy-${randomUUID()}`,
      { action: "open", kind: "permission", toolName: args.tool_name, input: args.input, policyOnly: true },
      undefined,
      undefined,
      ctx,
    );
  } catch {
    policyAnswer = undefined; // fall back to the broker; never allow on error
  }
  if (policyAnswer?.details?.kind === "request" && policyAnswer.details.request.status === "granted")
    return {
      content: [{ type: "text", text: JSON.stringify({ behavior: "allow", updatedInput: args.input }) }],
      details: { policy: true, request: policyAnswer.details.request },
    };
  const endpoints = bridgeMessageEndpoints(route);
  const path = bridgeStorePath(route);
  if (!endpoints || !path) throw new Error("Permission broker route is unavailable.");
  const logicalKey = `permission:${route.workflowId}/${route.laneId}:${digest({
    tool_name: args.tool_name,
    input: args.input,
  })}`;
  const stored = await putMessage(path, {
    envelope: makeEnvelope({
      logicalKey,
      kind: "permission-request",
      from: endpoints.from,
      to: endpoints.to,
      payload: { tool_name: args.tool_name, input: args.input },
    }),
  });
  await enqueueWakeHint(path, {
    recipient: endpoints.to,
    occurrenceId: stored.message.occurrence_id,
  });
  const released = await releasePermission(path, stored.message.occurrence_id);
  if (released.released || released.replay)
    return {
      content: [{ type: "text", text: JSON.stringify(released.decision) }],
      details: released,
    };
  return pendingToolResult(
    stored.message,
    JSON.stringify({
      behavior: "deny",
      message: `Permission request ${stored.message.occurrence_id} is pending parent approval.`,
    }),
  );
}

const permissionDefinition = {
  name: "herdr_permission_prompt",
  description:
    `Durably route a Claude permission prompt through ${permissionToolName}; it is deny-by-default until explicitly answered.`,
  parameters: Type.Object(
    {
      tool_name: Type.String({ minLength: 1 }),
      input: Type.Record(Type.String(), Type.Unknown()),
    },
    { additionalProperties: false },
  ),
  async execute(_id, args) {
    return permissionPrompt(args);
  },
};
tools.set(permissionDefinition.name, permissionDefinition);

const ctx = {
  get cwd() {
    return process.cwd();
  },
  mode: "json",
  hasUI: false,
  modelRegistry,
  ui: {
    // The JSON MCP bridge is intentionally headless. Chat-level user
    // questions are not a native TUI confirmation callback, so tools that
    // require confirmation must fail closed and tell the caller to ask the
    // user before using a TUI-capable or exact manual cleanup path.
    confirm: async () => false,
    notify: () => {},
  },
};

/** When spawned as a dispatched lane's MCP server, merge the live protocol
 * operations into the lane's startup attestation. The host harness's
 * SessionStart hook merges session identity into the same file; both merge
 * atomically, so write order does not matter. */
if (process.env.BAA_STARTUP_INTENT && process.env.HERDR_ENV === "1") {
  // node:module's native ESM loader rejects a raw Windows path ("C:\...") as
  // an import specifier -- it must be a file:// URL. jiti.import() below
  // tolerates raw paths (its own loader), but this native dynamic import
  // does not, and previously crashed every dispatched lane's MCP server at
  // startup on Windows before it could complete its protocol handshake.
  const { mergeAttestation } = await import(
    pathToFileURL(join(root, "attest-merge.mjs")).href
  );
  const { mapPiToolNamesToProtocolOperations } = await jiti.import(
    join(root, "pi-launch-adapter.ts"),
  );
  try {
    await mergeAttestation(process.env.BAA_STARTUP_INTENT, {
      operations: mapPiToolNamesToProtocolOperations([...tools.keys()]),
    });
  } catch (error) {
    console.error(
      `startup-attestation merge failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}
function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}
function isHerdrSession() {
  return process.env.HERDR_ENV === "1";
}
function toolDefinition(definition) {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.parameters,
  };
}

function toolError(text, details) {
  return {
    content: [{ type: "text", text }],
    ...(details === undefined ? {} : { structuredContent: details }),
    isError: true,
  };
}

function outputResult(output) {
  return {
    content: output?.content ?? [],
    ...(output?.details === undefined
      ? {}
      : { structuredContent: output.details }),
    ...(output?.isError ? { isError: true } : {}),
  };
}

function withRootBriefing(output) {
  const details =
    output?.details && isRecord(output.details)
      ? { ...output.details, rootBriefing: ROOT_BRIEFING }
      : { rootBriefing: ROOT_BRIEFING };
  const content = [...(output?.content ?? [])];
  if (content[0]?.type === "text")
    content[0] = {
      ...content[0],
      text: `${content[0].text}\n\n${ROOT_BRIEFING}`,
    };
  else content.unshift({ type: "text", text: ROOT_BRIEFING });
  return { ...output, content, details };
}

function requestTimeout(params) {
  const value = params.timeoutMs ?? params.timeout_ms;
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 86_400_000)
    throw new Error("timeoutMs must be a positive integer no greater than 86400000.");
  return value;
}

function requestKey(id) {
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

/**
 * The operator channel (docs/OPERATOR-MESSAGES.md) is for callers outside
 * Baa-ton too (an external assistant, a standalone agent): listed and
 * callable without a Herdr session, and with no root or lane identity.
 */
const OPERATOR_TOOLS = new Set(["herdr_operator_message", "herdr_operator_reply", "herdr_operator_inbox"]);

async function callOperatorTool(definition, args) {
  if (!Value.Check(definition.parameters, args)) {
    const issues = [...Value.Errors(definition.parameters, args)]
      .slice(0, 5)
      .map((issue) => `${issue.path || "(root)"} ${issue.message}`)
      .join("; ");
    return toolError(`Invalid arguments for ${definition.name}: ${issues || "schema validation failed"}`);
  }
  try {
    return outputResult(await definition.execute(randomUUID(), args, undefined, undefined, { cwd: process.cwd() }));
  } catch (caught) {
    return toolError(caught instanceof Error ? caught.message : String(caught));
  }
}

async function callTool(id, params) {
  if (isRecord(params) && OPERATOR_TOOLS.has(params.name) && tools.has(params.name))
    return callOperatorTool(tools.get(params.name), isRecord(params.arguments) ? params.arguments : {});
  if (!isHerdrSession())
    return toolError(
      "Herdr Orchestrator tools are available only inside a HERDR_ENV=1 session.",
    );
  if (!isRecord(params) || typeof params.name !== "string")
    throw new Error("tools/call requires a tool name.");
  const definition = tools.get(params.name);
  if (!definition) throw new Error(`Unknown tool: ${params.name}`);
  const args = params.arguments ?? {};
  if (!isRecord(args)) throw new Error(`Arguments for ${params.name} must be an object.`);
  // Every harness must see the same validated surface: reject arguments
  // outside the tool's declared schema before it reaches the shared execute
  // path, instead of letting the implementation's ad hoc checks decide.
  if (!Value.Check(definition.parameters, args)) {
    const issues = [...Value.Errors(definition.parameters, args)]
      .slice(0, 5)
      .map((issue) => `${issue.path || "(root)"} ${issue.message}`)
      .join("; ");
    return toolError(
      `Invalid arguments for ${params.name}: ${issues || "schema validation failed"}`,
    );
  }
  try {
    // Claude's project-scoped MCP registration may contain a stale pane
    // snapshot. Refresh the process environment from Claude's live session
    // id before any route, lifecycle, inbox, or extension root check runs.
    await refreshCurrentHerdrIdentity();
  } catch (error) {
    return toolError(
      `Unable to resolve the current Herdr identity: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // The extension's root checks intentionally use the live Herdr environment.
  // The bridge additionally resolves the workspace-qualified route so a
  // caller that merely reuses a pane ID from another workspace cannot act as
  // the parent through MCP.
  if (ROOT_EXECUTOR_TOOLS.has(params.name)) {
    const route = await currentRoute();
    if (route?.role !== "root") {
      clearAppliedHerdrIdentity();
      return toolError(
        "Only the verified controller-mapped root may perform this operation.",
      );
    }
  }

  const controller = new AbortController();
  const key = requestKey(id);
  if (key) activeRequests.set(key, { controller, name: params.name });
  let timedOut = false;
  let timer;
  let turn;
  let entry;
  try {
    const timeout = requestTimeout(params);
    if (timeout)
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeout);
    turn = await beginMcpTurn(id, controller);

    // A parent answer to a brokered permission request is already durable in
    // the inbox. It must not be routed through the legacy question ledger.
    if (params.name === "herdr_question_answer") {
      const permissionAnswer = await answerPermissionFromBridge(args);
      if (permissionAnswer) return outputResult(permissionAnswer);
    }

    entry = await persistBridgeMessage(params.name, args, id);
    if (entry && !entry.created) {
      if (entry.message.result !== undefined)
        return outputResult(entry.message.result);
      if (entry.message.delivery.status === "uncertain")
        return pendingToolResult(
          entry.message,
          `Tool call ${params.name} is pending review because its previous delivery was uncertain.`,
        );
    }
    let output = await definition.execute(
      "mcp",
      args,
      controller.signal,
      undefined,
      lifecycleContext(controller, "active"),
    );
    // Bootstrap is the explicit root handoff for a non-Pi harness. Include the
    // operating contract in both the MCP content and durable replay result so
    // a reconnecting client receives it without relying on Pi grounding.
    if (
      params.name === "herdr_bootstrap_root" &&
      output?.details?.root?.agent_kind !== "pi"
    ) {
      output = withRootBriefing(output);
    }
    await finishBridgeMessage(entry, output);
    return outputResult(output);
  } catch (caught) {
    const cause = caught instanceof Error ? caught : new Error(String(caught));
    const uncertain =
      timedOut ||
      controller.signal.aborted ||
      Boolean(caught?.sent) ||
      /pending|uncertain|timeout|cancel/i.test(cause.message);
    await failBridgeMessage(entry, cause, uncertain).catch(() => undefined);
    return toolError(
      timedOut
        ? `Tool call ${params.name} timed out and remains pending review.`
        : controller.signal.aborted
          ? `Tool call ${params.name} was cancelled and remains pending review.`
          : cause.message,
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (key) activeRequests.delete(key);
    if (turn) {
      try {
        await endMcpTurn(turn, controller);
      } catch (lifecycleError) {
        // Tool results are already durable; lifecycle failure invalidates the
        // root idle proof and is intentionally visible in the server log.
        console.error(
          `MCP lifecycle settlement failed: ${lifecycleError instanceof Error ? lifecycleError.message : String(lifecycleError)}`,
        );
      }
    }
    clearAppliedHerdrIdentity();
  }
}

async function handleRequest(request) {
  if (!isRecord(request)) {
    error(null, -32600, "Invalid JSON-RPC request.");
    return;
  }
  const { id, method, params = {} } = request;
  if (method === "initialize") {
    result(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, cancellation: {} },
      serverInfo: { name: "herdr-orchestrator", version: "0.1.0" },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "notifications/cancelled") {
    const key = requestKey(params?.requestId);
    const active = key ? activeRequests.get(key) : undefined;
    if (active) active.controller.abort();
    return;
  }
  if (method === "tools/list") {
    result(id, {
      tools: (isHerdrSession() ? [...tools.values()] : [...tools.values()].filter((definition) => OPERATOR_TOOLS.has(definition.name))).map(toolDefinition),
    });
    return;
  }
  if (method === "tools/call") {
    try {
      result(id, await callTool(id, params));
    } catch (caught) {
      error(id, -32602, caught instanceof Error ? caught.message : String(caught));
    }
    return;
  }
  error(id, -32601, `Unsupported method: ${method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      error(null, -32700, "Invalid JSON-RPC request.");
      continue;
    }
    void handleRequest(request);
  }
});
