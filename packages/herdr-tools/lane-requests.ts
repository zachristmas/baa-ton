import type { ApprovalPolicy, RuntimeLaunchTemplate } from "./approval-policy.js";
import type { Lease } from "./leases.js";

/** Formal lane requests: leases, runtime launches, approvals and Claude
 * permission prompts a lane owes the root an answer on. Each is a durable
 * record in its workflow's `laneRequests`; policy-matching ones are answered
 * immediately, the rest reach the root digest and stay open until answered. */
export const LANE_REQUEST_KINDS = ["lease", "runtime-launch", "approval", "permission"] as const;
export type LaneRequestKind = (typeof LANE_REQUEST_KINDS)[number];

export type LaneRequestPayload =
  | { resource: string; label?: string }
  | { command: string }
  | { text: string }
  | { toolName: string; input: Record<string, unknown> };

export type LaneRequest = {
  id: string;
  workflowId: string;
  laneId: string;
  kind: LaneRequestKind;
  payload: LaneRequestPayload;
  /** One line for the digest and tool output. */
  summary: string;
  status: "open" | "granted" | "denied";
  requestedAt: string;
  answeredAt?: string;
  answeredBy?: "policy" | "root";
  note?: string;
  leaseId?: string;
  template?: string;
  /** Root digest delivery; only open requests are delivered. */
  delivery?: {
    status: "pending" | "sending" | "delivered" | "uncertain";
    attempts?: number;
    updatedAt: string;
    reason?: string;
  };
  /** Delivery of the root's answer back to the lane pane. */
  answerDelivery?: { status: "delivered" | "uncertain"; updatedAt: string; reason?: string };
};

const TEXT_MAX = 2000;
const COMMAND_MAX = 500;
const SAFE_TOKEN = /^[A-Za-z0-9_./:=@,+%-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Normalize and bound one request's payload; throws on a malformed one. */
export function requestPayload(
  kind: LaneRequestKind,
  input: {
    resource?: unknown;
    label?: unknown;
    command?: unknown;
    text?: unknown;
    toolName?: unknown;
    input?: unknown;
  },
): LaneRequestPayload {
  if (kind === "lease") {
    if (typeof input.resource !== "string" || !input.resource)
      throw new Error("A lease request needs resource.");
    return {
      resource: input.resource,
      ...(typeof input.label === "string" && input.label ? { label: input.label } : {}),
    };
  }
  if (kind === "runtime-launch") {
    if (typeof input.command !== "string" || !input.command.trim())
      throw new Error("A runtime-launch request needs the exact command.");
    if (input.command.length > COMMAND_MAX)
      throw new Error(`command must be at most ${COMMAND_MAX} characters.`);
    return { command: input.command.trim() };
  }
  if (kind === "approval") {
    if (typeof input.text !== "string" || !input.text.trim())
      throw new Error("An approval request needs text describing what to approve.");
    if (input.text.length > TEXT_MAX)
      throw new Error(`text must be at most ${TEXT_MAX} characters.`);
    return { text: input.text.trim() };
  }
  if (typeof input.toolName !== "string" || !input.toolName || !isRecord(input.input))
    throw new Error("A permission request needs toolName and input.");
  return { toolName: input.toolName, input: input.input };
}

export function requestSummary(kind: LaneRequestKind, payload: LaneRequestPayload): string {
  if ("resource" in payload)
    return `lease ${payload.resource}${payload.label ? `:${payload.label}` : ""}`;
  if ("command" in payload) return `runtime launch: ${oneLine(payload.command, 200)}`;
  if ("text" in payload) return `approval: ${oneLine(payload.text, 300)}`;
  const command = typeof payload.input.command === "string" ? `: ${oneLine(payload.input.command, 200)}` : "";
  return `permission ${payload.toolName}${command}`;
}

/** Stable identity for de-duplicating an identical open request. */
export function requestKey(kind: LaneRequestKind, payload: LaneRequestPayload): string {
  return `${kind}:${JSON.stringify(payload)}`;
}

export type TemplateContext = {
  workflowId: string;
  laneId: string;
  /** This lane's active leases. */
  leases: Lease[];
};

const PLACEHOLDER = /\{([^{}]+)\}/g;

function resolvePlaceholder(key: string, context: TemplateContext): string | undefined {
  if (key === "lane") return context.laneId;
  if (key === "workflow") return context.workflowId;
  const match = /^lease\.([a-z][a-z0-9-]*)(?::([a-z][a-z0-9-]*))?(?:\[(\d+)\])?$/.exec(key);
  if (!match) return undefined;
  const [, resource, label = "default", index] = match;
  const lease = context.leases.find(
    (item) => item.state === "active" && item.resource === resource && item.label === label,
  );
  if (!lease) return undefined;
  if (lease.name !== undefined) return index === undefined ? lease.name : undefined;
  const port = lease.ports?.[index === undefined ? 0 : Number(index)];
  return port === undefined ? undefined : String(port);
}

/** A template with every placeholder resolved, or undefined when the lane
 * lacks a lease it names. */
export function expandTemplate(template: string, context: TemplateContext): string | undefined {
  let missing = false;
  const expanded = template.replace(PLACEHOLDER, (_, key: string) => {
    const value = resolvePlaceholder(key, context);
    if (value === undefined) missing = true;
    return value ?? "";
  });
  return missing ? undefined : expanded;
}

/** Tokens of a command with no shell syntax, or undefined when it has any. */
export function plainCommandTokens(command: string): string[] | undefined {
  const tokens = command.trim().split(/\s+/);
  return tokens.length && tokens.every((token) => SAFE_TOKEN.test(token)) ? tokens : undefined;
}

/** The runtime template (start or stop) this exact command matches, with
 * every lease placeholder resolved against this lane's own leases. */
export function matchRuntimeCommand(
  policy: ApprovalPolicy,
  command: string,
  context: TemplateContext,
): { template: RuntimeLaunchTemplate; phase: "start" | "stop" } | undefined {
  if (!policy.grants.includes("runtime-launch")) return undefined;
  const tokens = plainCommandTokens(command);
  if (!tokens) return undefined;
  for (const template of policy.runtimeLaunch?.commands ?? [])
    for (const phase of ["start", "stop"] as const) {
      const text = template[phase];
      if (!text) continue;
      const expanded = expandTemplate(text, context);
      if (expanded !== undefined && expanded.split(" ").join("\u0000") === tokens.join("\u0000"))
        return { template, phase };
    }
  return undefined;
}

/** Open requests in the order a root should read them. */
export function openRequests(requests: LaneRequest[] | undefined): LaneRequest[] {
  return (requests ?? [])
    .filter((request) => request.status === "open")
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

/** The stop commands a retiring lane should run: the `stop` of every runtime
 * template this lane was granted a `start` for, expanded with its current
 * leases, de-duplicated, as plain argv tokens. */
export function retireStopCommands(
  policy: ApprovalPolicy | undefined,
  requests: LaneRequest[] | undefined,
  context: TemplateContext,
): string[][] {
  if (!policy?.runtimeLaunch) return [];
  const seen = new Set<string>();
  const commands: string[][] = [];
  for (const request of requests ?? []) {
    if (request.laneId !== context.laneId || request.status !== "granted") continue;
    const [name, phase] = (request.template ?? "").split(":");
    if (phase !== "start") continue;
    const template = policy.runtimeLaunch.commands.find((item) => item.name === name);
    if (!template?.stop) continue;
    const expanded = expandTemplate(template.stop, context);
    const tokens = expanded === undefined ? undefined : plainCommandTokens(expanded);
    if (!tokens || seen.has(tokens.join(" "))) continue;
    seen.add(tokens.join(" "));
    commands.push(tokens);
  }
  return commands;
}
