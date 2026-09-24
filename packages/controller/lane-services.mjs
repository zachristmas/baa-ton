/**
 * Lane services: stacks a lane runs besides its agent (dev servers, a
 * database container, a browser-test runner) that must stop when the lane
 * retires. Services started through a granted runtime-launch template are
 * tracked by their lane request; anything started another way (by hand in a
 * separate Herdr pane, or as a background process) is registered with
 * herdr_service and recorded in `workflow.laneServices`:
 *
 *   { id, laneId, name, kind: "pane" | "process", paneId?, pid?, start?,
 *     command?, registeredBy: "lane" | "root", registeredAt,
 *     state: "active" | "stopped" | "released", stoppedAt?, stopNote? }
 *
 * A process is identified by pid plus its start time, so a reused pid is
 * never signalled. A pane service is stopped by signalling the pane's
 * foreground processes, read live at retire time; the shell stays.
 */

/** Commands that are agents or Baa-ton/Herdr itself, never a lane service. */
const HARNESS_COMMAND = /(^|[\s/])(claude|codex|opencode|pi|herdr)(\s|$)|mcp-server\.mjs|controller\.mjs|known-safe-hook\.mjs/;

export function isHarnessCommand(command) {
  return HARNESS_COMMAND.test(String(command ?? ""));
}

// The terminal lane statuses the extension and controller use.
const FINISHED_LANE_STATES = new Set([
  "completion-reported",
  "completed",
  "operator-closed",
  "superseded",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A lane whose work is over but which has not been retired yet. */
export function laneFinished(lane) {
  if (!isRecord(lane)) return false;
  if (lane.retirement && lane.retirement.status !== "partial") return false;
  return Boolean(lane.completionReceipt) || FINISHED_LANE_STATES.has(lane.status);
}

/**
 * Services still registered to finished, unretired lanes: registered
 * services that are active, and runtime-launch templates the lane started.
 * Names only; nothing here stops anything.
 */
export function idleLaneServices(workflows) {
  const idle = [];
  for (const workflow of Array.isArray(workflows) ? workflows : []) {
    if (!isRecord(workflow)) continue;
    const finished = new Map(
      (Array.isArray(workflow.lanes) ? workflow.lanes : []).filter(laneFinished).map((lane) => [lane.id, lane]),
    );
    if (!finished.size) continue;
    for (const service of Array.isArray(workflow.laneServices) ? workflow.laneServices : [])
      if (isRecord(service) && service.state === "active" && finished.has(service.laneId))
        idle.push({
          workflowId: workflow.id,
          laneId: service.laneId,
          name: service.name,
          kind: service.kind,
          where: service.kind === "pane" ? `pane ${service.paneId}` : `pid ${service.pid}`,
        });
    const templates = new Set();
    for (const request of Array.isArray(workflow.laneRequests) ? workflow.laneRequests : []) {
      if (!isRecord(request) || request.status !== "granted" || !finished.has(request.laneId)) continue;
      const [name, phase] = String(request.template ?? "").split(":");
      if (phase !== "start" || templates.has(`${request.laneId}:${name}`)) continue;
      templates.add(`${request.laneId}:${name}`);
      idle.push({ workflowId: workflow.id, laneId: request.laneId, name, kind: "template", where: "runtime template" });
    }
  }
  return idle;
}

export function describeIdleServices(idle, limit = 8) {
  if (!idle.length) return "";
  const shown = idle.slice(0, limit).map((item) => `${item.name} (${item.workflowId}/${item.laneId}, ${item.where})`);
  return `Services still held by finished lanes: ${shown.join("; ")}${idle.length > limit ? `; and ${idle.length - limit} more` : ""}. Retire those lanes (herdr_retire) to stop them.`;
}

/** Parse `ps -o lstart=,command= -p <pid>` output (lstart is 5 fields). */
export function parseProcessIdentity(stdout) {
  const line = String(stdout ?? "").split("\n").find((item) => item.trim());
  if (!line) return undefined;
  const match = /^\s*(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/.exec(line);
  return match ? { start: match[1].replace(/\s+/g, " "), command: match[2].trim() } : undefined;
}

/**
 * The processes a pane service stop would signal, from `herdr pane get`
 * process_info: the foreground processes, minus the shell and any agent.
 */
export function paneServiceProcesses(paneInfo) {
  const info = isRecord(paneInfo?.process_info) ? paneInfo.process_info : isRecord(paneInfo?.pane?.process_info) ? paneInfo.pane.process_info : undefined;
  if (!info) return [];
  const shell = info.shell_pid;
  return (Array.isArray(info.foreground_processes) ? info.foreground_processes : [])
    .filter((item) => isRecord(item) && Number.isSafeInteger(item.pid) && item.pid > 1 && item.pid !== shell)
    .filter((item) => !isHarnessCommand(item.name ?? item.command))
    .map((item) => ({ pid: item.pid, name: String(item.name ?? item.command ?? "") }));
}
