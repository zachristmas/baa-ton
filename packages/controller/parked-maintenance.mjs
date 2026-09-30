import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { busyPorts, killLaneProcesses, readProcessTable } from "../herdr-tools/inbox/lane-processes.mjs";
import { archivableWorkflows, liveSpecWorkflowIds, mentionedWorkflowIds, removeFiles, workflowFiles, writeArchive } from "../herdr-tools/housekeeping.mjs";
import { parseProcessIdentity, paneServiceProcesses } from "./lane-services.mjs";
import { ROOT_PARK_ARCHIVE_DELAY_MS } from "./root-watch.mjs";

const execFileAsync = promisify(execFile);
const OWNER = "herdr-orchestrator";
const STANDING_GRANTS = ["dispatch", "retry", "resume", "retire", "lease", "runtime-launch", "local-validation", "integrate", "spec-push"];
const FINISHED_LANES = new Set(["completion-reported", "completed", "operator-closed", "superseded"]);
const FINISHED_WORKFLOWS = new Set(["completed", "superseded", "operator-closed", "dispatch-failed"]);
const SPEC_ITEM_STATES = new Set(["pending", "deciding", "ready", "building", "reviewing", "integrating", "awaiting-push", "verifying", "done", "blocked", "failed", "deferred", "resolved"]);
const LANE_MARKER = "BAA_STARTUP_INTENT";
const CANONICAL_ISO_TIMESTAMP = /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SAFE_TEMPLATE = /^(?:[A-Za-z0-9_./:=@,+%-]|\{[A-Za-z0-9_.:[\]-]+\})+(?: (?:[A-Za-z0-9_./:=@,+%-]|\{[A-Za-z0-9_.:[\]-]+\})+)*$/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function canonicalIsoTimestamp(value) {
  if (typeof value !== "string" || !CANONICAL_ISO_TIMESTAMP.test(value)) return Number.NaN;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return Number.NaN;
  try {
    return new Date(milliseconds).toISOString() === value ? milliseconds : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

function parseSpecWorkflowIds(source) {
  const state = JSON.parse(source);
  if (!isRecord(state) || state.version !== 1 || !isRecord(state.items)) throw new Error("invalid spec-state shape");
  for (const item of Object.values(state.items))
    if (!isRecord(item) || (item.state !== undefined && !SPEC_ITEM_STATES.has(item.state))) throw new Error("invalid spec-state item");
  return [...liveSpecWorkflowIds(state)];
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function approvalPolicy(manifest, cwd, rootPaneId) {
  let file;
  try {
    file = JSON.parse(readFileSync(join(cwd, ".baa-ton", "config.json"), "utf8"));
  } catch {
    return { allowed: false };
  }
  if (!isRecord(file) || !Object.hasOwn(file, "approvalPolicy")) return { allowed: false };
  const input = file.approvalPolicy;
  if (!isRecord(input) || Object.keys(input).some((key) => !["version", "grants", "runtimeLaunch"].includes(key)) || input.version !== 2 || !Array.isArray(input.grants) || !input.grants.length) return { allowed: false };
  if (input.grants.some((grant) => typeof grant !== "string" || !STANDING_GRANTS.includes(grant)) || new Set(input.grants).size !== input.grants.length) return { allowed: false };
  const policy = { version: 2, grants: STANDING_GRANTS.filter((grant) => input.grants.includes(grant)) };
  if (!policy.grants.includes("retire")) return { allowed: false };
  if (input.runtimeLaunch !== undefined) {
    if (!isRecord(input.runtimeLaunch) || !Array.isArray(input.runtimeLaunch.commands) || !input.runtimeLaunch.commands.length || !policy.grants.includes("runtime-launch")) return { allowed: false };
    const names = new Set();
    for (const command of input.runtimeLaunch.commands) {
      if (!isRecord(command) || Object.keys(command).some((key) => !["name", "start", "stop"].includes(key)) || typeof command.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(command.name) || names.has(command.name) || typeof command.start !== "string" || !SAFE_TEMPLATE.test(command.start) || (command.stop !== undefined && (typeof command.stop !== "string" || !SAFE_TEMPLATE.test(command.stop)))) return { allowed: false };
      names.add(command.name);
    }
    policy.runtimeLaunch = { commands: input.runtimeLaunch.commands.map(({ name, start, stop }) => ({ name, start, ...(stop !== undefined ? { stop } : {}) })) };
  }
  const ack = manifest.approvalPolicyAck;
  if (!isRecord(ack) || ack.rootPaneId !== rootPaneId) return { allowed: false };
  const hash = (value) => createHash("sha256").update(canonical(value)).digest("hex");
  const acknowledged = ack.hash === hash(policy) || (policy.grants.includes("spec-push") && ack.hash === hash({ ...policy, grants: policy.grants.filter((grant) => grant !== "spec-push") }));
  return acknowledged ? { allowed: true, policy } : { allowed: false };
}

function leaseValue(lease) {
  if (typeof lease.name === "string") return lease.name;
  if (lease.number !== undefined) return String(lease.number).padStart(lease.digits ?? 1, "0");
  const ports = Array.isArray(lease.ports) ? lease.ports : [];
  return ports.length > 1 ? `${ports[0]}-${ports.at(-1)}` : String(ports[0] ?? "");
}

function stopCommands(policy, workflow, lane, leases) {
  if (!policy?.runtimeLaunch) return [];
  const output = [];
  const seen = new Set();
  for (const request of workflow.laneRequests ?? []) {
    if (request?.laneId !== lane.id || request.status !== "granted") continue;
    const [name, phase] = String(request.template ?? "").split(":");
    if (phase !== "start") continue;
    const template = policy.runtimeLaunch.commands.find((item) => item?.name === name);
    if (!template?.stop) continue;
    if (typeof template.stop !== "string" || !SAFE_TEMPLATE.test(template.stop)) throw new Error(`unsafe runtime stop template ${name}`);
    const expanded = template.stop.replace(/\{([^}]+)\}/g, (_match, key) => {
      if (key === "lane") return lane.id;
      if (key === "workflow") return workflow.id;
      const parsed = /^lease\.([a-z][a-z0-9-]{0,31})(?::([a-z][a-z0-9-]{0,15}))?(?:\[(\d+)\])?$/.exec(key);
      if (!parsed) throw new Error(`unsupported runtime stop placeholder {${key}}`);
      const [, resource, label = "default", indexText] = parsed;
      const found = leases.filter((lease) => lease.resource === resource && (lease.label ?? "default") === label);
      const index = indexText === undefined ? 0 : Number(indexText);
      if (!found[index]) throw new Error(`runtime stop placeholder {${key}} has no matching lease`);
      return leaseValue(found[index]);
    });
    const tokens = expanded.split(" ");
    if (tokens.some((token) => !token || !/^[A-Za-z0-9_./:=@,+%-]+$/.test(token))) throw new Error(`runtime stop template ${name} did not expand to safe argv`);
    const identity = tokens.join(" ");
    if (!seen.has(identity)) {
      seen.add(identity);
      output.push(tokens);
    }
  }
  return output;
}

function rootWorkflowIds(manifest, orchestrator) {
  const routed = new Set((orchestrator.workflows ?? []).map((route) => route.workflow_id).filter((id) => typeof id === "string"));
  const ids = new Set();
  for (const workflow of manifest.workflows ?? []) {
    if (workflow?.ownership?.createdBy !== OWNER) continue;
    const bound = workflow.taskBinding?.rootPaneId === orchestrator.root.pane_id && workflow.taskBinding?.workspaceId === orchestrator.root.workspace_id;
    if (routed.has(workflow.id) || bound) ids.add(workflow.id);
  }
  return ids;
}

export function parkedFinishedLanes(manifest, orchestrator) {
  const ids = rootWorkflowIds(manifest, orchestrator);
  const candidates = [];
  for (const workflow of manifest.workflows ?? []) {
    if (!ids.has(workflow?.id) || !isRecord(workflow)) continue;
    for (const lane of workflow.lanes ?? []) {
      if (!isRecord(lane) || (!lane.completionReceipt && !FINISHED_LANES.has(lane.status))) continue;
      if (lane.retirement && lane.retirement.status !== "partial") continue;
      candidates.push({ workflow, lane });
    }
  }
  return candidates;
}

async function liveLaneStatus(herdr, lane) {
  if (!lane.paneId || !lane.workspaceId) return undefined;
  try {
    const raw = await herdr.request("agent.get", { target: lane.paneId });
    const info = isRecord(raw?.result) ? raw.result : raw;
    const agent = isRecord(info?.agent) ? info.agent : undefined;
    if (!agent || agent.pane_id !== lane.paneId || agent.workspace_id !== lane.workspaceId) return undefined;
    return typeof agent.agent_status === "string" ? agent.agent_status : undefined;
  } catch (error) {
    if (["agent_not_found", "agent_not_running", "agent_pane_not_found", "pane_not_found"].includes(error?.code)) return "gone";
    return undefined;
  }
}

async function stopRegisteredService(service, herdr) {
  if (service.kind === "process") {
    if (!Number.isSafeInteger(service.pid) || typeof service.start !== "string") return { ok: false, note: "service process identity is incomplete" };
    let identity;
    try {
      const result = await execFileAsync("ps", ["-o", "lstart=", "-o", "command=", "-p", String(service.pid)], { timeout: 5_000 });
      identity = parseProcessIdentity(result.stdout);
    } catch {
      return { ok: true, note: "already stopped" };
    }
    if (!identity) return { ok: true, note: "already stopped" };
    if (identity.start !== service.start) return { ok: true, note: `pid ${service.pid} now belongs to another process; not signalled` };
    try {
      process.kill(service.pid, "SIGTERM");
      return { ok: true, note: `SIGTERM pid ${service.pid}` };
    } catch (error) {
      return error?.code === "ESRCH" ? { ok: true, note: "already stopped" } : { ok: false, note: `could not signal pid ${service.pid}` };
    }
  }
  if (service.kind !== "pane" || !service.paneId) return { ok: false, note: "service identity is incomplete" };
  let info;
  try {
    info = typeof herdr.processInfo === "function" ? await herdr.processInfo(service.paneId) : JSON.parse((await execFileAsync("herdr", ["pane", "process-info", "--pane", service.paneId], { timeout: 5_000 })).stdout);
  } catch (error) {
    return /not[ _-]?found|no such pane|unknown pane/i.test(String(error)) ? { ok: true, note: "pane is gone" } : { ok: false, note: `pane process-info failed: ${String(error).slice(0, 200)}` };
  }
  const processes = paneServiceProcesses(info);
  const failed = [];
  for (const item of processes) {
    try { process.kill(item.pid, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") failed.push(item.pid); }
  }
  return failed.length ? { ok: false, note: `could not signal ${failed.join(", ")}` } : { ok: true, note: processes.length ? `SIGTERM ${processes.map((item) => `${item.name} (${item.pid})`).join(", ")}` : `nothing running in pane ${service.paneId}` };
}

async function shareTabWithLiveLane(manifest, workflowId, lane, herdr) {
  if (!lane.tabId) return false;
  for (const workflow of manifest.workflows ?? [])
    for (const other of workflow.lanes ?? []) {
      if (workflow.id === workflowId && other.id === lane.id) continue;
      if (other.tabId !== lane.tabId || other.retirement?.status === "retired") continue;
      if (!other.completionReceipt && !FINISHED_LANES.has(other.status)) return true;
      if (!["idle", "done", "gone"].includes(await liveLaneStatus(herdr, other))) return true;
    }
  return false;
}

/** Retire only receipt-backed/terminal lanes owned by this parked root. */
export async function retireParkedFinishedLanes({ manifest, orchestrator, herdr, timestamp, persist = async () => {}, closeTab = (tabId) => execFileAsync("herdr", ["tab", "close", tabId], { timeout: 10_000 }), runCommand = (tokens, cwd) => execFileAsync(tokens[0], tokens.slice(1), { cwd, timeout: 120_000 }), processSweep = killLaneProcesses, portProbe = busyPorts } = {}) {
  const retired = [];
  const sweepEnabled = process.env.BAA_TON_NO_PROCESS_SWEEP !== "1" || processSweep !== killLaneProcesses;
  for (const { workflow, lane } of parkedFinishedLanes(manifest, orchestrator)) {
    if (await shareTabWithLiveLane(manifest, workflow.id, lane, herdr)) continue;
    const status = await liveLaneStatus(herdr, lane);
    if (!["idle", "done", "gone"].includes(status)) continue;
    const policyResult = approvalPolicy(manifest, orchestrator.program.id, orchestrator.root.pane_id);
    if (!policyResult.allowed) continue;
    const workflowLeases = (manifest.leases ?? []).filter((lease) => lease.state === "active" && lease.workflowId === workflow.id && lease.laneId === lane.id);
    let stops;
    try { stops = stopCommands(policyResult.policy, workflow, lane, workflowLeases); } catch { continue; }
    const services = (workflow.laneServices ?? []).filter((service) => service.laneId === lane.id && service.state === "active");
    const cwd = workflow.worktree ?? workflow.cwd ?? orchestrator.program.id;
    lane.retirement = { status: "retiring", reason: "parked root: finished lane", startedAt: lane.retirement?.startedAt ?? timestamp };
    await persist();
    const stopResults = [];
    for (const tokens of stops) {
      try {
        const result = await runCommand(tokens, cwd);
        stopResults.push({ command: tokens.join(" "), code: result.code ?? 0, ...((result.stderr || result.stdout) ? { output: String(result.stderr || result.stdout).trim().slice(0, 500) } : {}) });
      } catch (error) {
        stopResults.push({ command: tokens.join(" "), code: Number.isInteger(error?.code) ? error.code : null, output: String(error?.stderr || error?.message || error).slice(0, 500) });
      }
    }
    const serviceResults = [];
    for (const service of services) {
      const result = await stopRegisteredService(service, herdr);
      serviceResults.push({ id: service.id, ...result });
      stopResults.push({ command: `service ${service.name} (${service.id}): ${result.note}`, code: result.ok ? 0 : 1 });
    }
    let tabClosed = false;
    let closeError;
    if (!lane.tabId) closeError = "lane has no recorded tab";
    else {
      try { await closeTab(lane.tabId); tabClosed = true; }
      catch (error) {
        const message = String(error?.stderr || error?.message || error);
        if (/not[ _-]?found|no such tab|unknown tab/i.test(message)) tabClosed = true;
        else closeError = `tab close failed: ${message.slice(0, 500)}`;
      }
    }
    if (closeError) stopResults.push({ command: "lane tab", code: 1, output: closeError });
    if (sweepEnabled && lane.startupIntentPath) {
      try {
        const swept = await processSweep({ intentPath: lane.startupIntentPath });
        stopResults.push({ command: "lane process tree", code: swept.survivors.length ? 1 : 0, output: `signalled ${swept.signalled.length}; survivors ${swept.survivors.join(",") || "none"}` });
      } catch (error) {
        stopResults.push({ command: "lane process tree", code: null, output: String(error?.message || error).slice(0, 500) });
      }
    }
    const ports = workflowLeases.flatMap((lease) => lease.ports ?? []);
    if (sweepEnabled && ports.length) {
      const busy = await portProbe(ports).catch(() => ports);
      if (busy.length) stopResults.push({ command: "ports free", code: 1, output: `still listening: ${busy.join(", ")}` });
    }
    const stopsOk = stopResults.every((result) => result.code === 0);
    const released = [];
    if (stopsOk) for (const lease of manifest.leases ?? [])
      if (lease.state === "active" && lease.workflowId === workflow.id && lease.laneId === lane.id && lease.kind !== "sequence") {
        lease.state = "released";
        lease.releasedAt = timestamp;
        lease.releaseReason = "lane retired while root parked";
        released.push(lease.id);
      }
    for (const result of serviceResults) {
      const service = (workflow.laneServices ?? []).find((item) => item.id === result.id);
      if (service && service.state === "active" && result.ok) {
        service.state = "stopped";
        service.stoppedAt = timestamp;
        service.stopNote = result.note;
      }
    }
    const record = {
      status: tabClosed && stopsOk ? "retired" : "partial",
      reason: "parked root: finished lane",
      startedAt: lane.retirement?.startedAt ?? timestamp,
      completedAt: timestamp,
      tabClosed,
      stops: stopResults,
      releasedLeaseIds: released,
      ...(!tabClosed || !stopsOk ? { error: closeError ?? "a stop command failed; leases are kept until services stop" } : {}),
    };
    lane.retirement = record;
    if (tabClosed && lane.sessionLog) lane.sessionLog = { ...lane.sessionLog, status: "retired" };
    workflow.evidence ??= [];
    workflow.evidence.push({ at: timestamp, kind: record.status === "retired" ? "lane-retired" : "lane-retirement-partial", text: `${lane.id}: parked-root retirement; tab ${tabClosed ? "closed" : "kept"}; leases released ${released.length}${record.error ? `; ${record.error}` : ""}` });
    workflow.updatedAt = timestamp;
    await persist();
    if (record.status === "retired") retired.push(`${workflow.id}/${lane.id}`);
  }
  return retired;
}

function hasOwnedProcess(workflow, processRows) {
  return (workflow.lanes ?? []).some((lane) => {
    if (typeof lane.startupIntentPath !== "string" || !lane.startupIntentPath) return false;
    const token = ` ${LANE_MARKER}=${lane.startupIntentPath}`;
    return processRows.some((row) => {
      const index = row.line.indexOf(token);
      return index >= 0 && (row.line[index + token.length] === undefined || /\s/.test(row.line[index + token.length]));
    });
  });
}

/** Archive only this root's unreferenced, settled workflows after the parked grace. */
export async function archiveParkedWorkflows({ manifest, orchestrator, manifestPath, parkedAt, timestamp, persist = async () => {}, processTable = readProcessTable, keepRecent = 100 } = {}) {
  const parkedAtMs = canonicalIsoTimestamp(parkedAt);
  const timestampMs = canonicalIsoTimestamp(timestamp);
  if (!Number.isFinite(parkedAtMs) || !Number.isFinite(timestampMs) || timestampMs < parkedAtMs || timestampMs - parkedAtMs < ROOT_PARK_ARCHIVE_DELAY_MS) return [];
  const ids = rootWorkflowIds(manifest, orchestrator);
  const scope = { ...manifest, workflows: (manifest.workflows ?? []).filter((workflow) => ids.has(workflow.id)) };
  const stateDir = dirname(manifestPath);
  const specCandidates = [join(stateDir, "spec-state.json"), join(dirname(stateDir), "spec-state.json")];
  const specWorkflowIds = [];
  for (const path of specCandidates) {
    let source;
    try { source = await readFile(path, "utf8"); }
    catch (error) {
      if (error?.code === "ENOENT") continue;
      return [];
    }
    try {
      specWorkflowIds.push(...parseSpecWorkflowIds(source));
    } catch {
      return [];
    }
  }
  const protectedIds = mentionedWorkflowIds(
    specWorkflowIds,
    manifest.queue,
    manifest.directives,
    manifest.rootSupervision,
    (manifest.leases ?? []).filter((lease) => lease.state === "active"),
  );
  let rows = [];
  try { rows = await processTable(); } catch { return []; }
  const candidates = archivableWorkflows(scope, { now: timestampMs, protectedIds, keepRecent });
  const archiveable = new Set([...candidates].filter((id) => {
    const workflow = scope.workflows.find((item) => item.id === id);
    return workflow && FINISHED_WORKFLOWS.has(workflow.status) && !hasOwnedProcess(workflow, rows);
  }));
  if (!archiveable.size) return [];
  const leaving = (manifest.workflows ?? []).filter((workflow) => archiveable.has(workflow.id));
  writeArchive(stateDir, leaving, timestampMs);
  manifest.workflows = (manifest.workflows ?? []).filter((workflow) => !archiveable.has(workflow.id));
  await persist();
  removeFiles(leaving.flatMap((workflow) => workflowFiles(workflow, stateDir)));
  return leaving.map((workflow) => workflow.id);
}
