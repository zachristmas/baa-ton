import { createHash } from "node:crypto";

/** Standing approval policy (`approvalPolicy` in .baa-ton/config.json).
 *
 * The user records it once; the root acknowledges its hash with one native
 * confirmation, and afterwards routine local operations inside it need no
 * dialog. Only the grants below exist. Push, merge, deploy, production,
 * external messages, reparent, close and sweep are not grantable: the
 * validator rejects them, and an invalid policy is treated as absent. */
export const STANDING_GRANTS = [
  "dispatch",
  "retry",
  "resume",
  "retire",
  "lease",
  "runtime-launch",
  // Last, so adding it never reorders (and re-hashes) an existing policy.
  "local-validation",
] as const;
export type StandingGrant = (typeof STANDING_GRANTS)[number];
export type StandingOperation = "dispatch" | "retry" | "resume";

const NEVER_GRANTABLE = [
  "push",
  "merge",
  "deploy",
  "production",
  "close",
  "sweep",
  "reparent",
  "external-message",
];

export type RuntimeLaunchTemplate = { name: string; start: string; stop?: string };
export type ApprovalPolicy = {
  version: 2;
  grants: StandingGrant[];
  runtimeLaunch?: { commands: RuntimeLaunchTemplate[] };
};
export type ApprovalPolicyAck = {
  hash: string;
  grants: StandingGrant[];
  ackedAt: string;
  rootPaneId: string;
};

export type PolicyLane = {
  id: string;
  taskProfile?: string;
  launchProfile?: unknown;
  mcpServers?: Record<string, unknown>;
};
export type PolicyWorkflow = {
  taskProfile?: string;
  lanes: PolicyLane[];
};

export type StandingDecision =
  | { kind: "none"; reason: string }
  | { kind: "outside"; reason: string; policy: ApprovalPolicy; hash: string }
  | { kind: "needs-ack"; policy: ApprovalPolicy; hash: string }
  | { kind: "granted"; policy: ApprovalPolicy; hash: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length)
    throw new Error(`${label} has unsupported keys: ${extra.join(", ")}.`);
}

// Token-for-token templates; placeholders are {lane}, {workflow} and
// {lease.<resource>[:<label>][[<index>]]}. No quoting, expansion,
// redirection or chaining.
const TEMPLATE = /^(?:[A-Za-z0-9_./:=@,+%-]|\{[A-Za-z0-9_.:[\]-]+\})+(?: (?:[A-Za-z0-9_./:=@,+%-]|\{[A-Za-z0-9_.:[\]-]+\})+)*$/;

function template(value: unknown, label: string): string {
  if (typeof value !== "string" || !TEMPLATE.test(value))
    throw new Error(
      `${label} must be a single-space-separated command with no shell metacharacters.`,
    );
  return value;
}

export function validateApprovalPolicy(input: unknown): ApprovalPolicy {
  if (!isRecord(input)) throw new Error("approvalPolicy must be an object.");
  onlyKeys(input, ["version", "grants", "runtimeLaunch"], "approvalPolicy");
  if (input.version !== 2) throw new Error("approvalPolicy.version must be 2.");
  if (!Array.isArray(input.grants) || input.grants.length === 0)
    throw new Error("approvalPolicy.grants must be a non-empty array.");
  const grants = input.grants.map((grant) => {
    if (typeof grant === "string" && NEVER_GRANTABLE.includes(grant))
      throw new Error(
        `approvalPolicy cannot grant ${grant}; it always requires explicit confirmation.`,
      );
    if (!STANDING_GRANTS.includes(grant as StandingGrant))
      throw new Error(`approvalPolicy cannot grant ${String(grant)}.`);
    return grant as StandingGrant;
  });
  if (new Set(grants).size !== grants.length)
    throw new Error("approvalPolicy.grants must not contain duplicates.");
  const policy: ApprovalPolicy = {
    version: 2,
    grants: STANDING_GRANTS.filter((grant) => grants.includes(grant)),
  };
  if (input.runtimeLaunch !== undefined) {
    if (!isRecord(input.runtimeLaunch))
      throw new Error("approvalPolicy.runtimeLaunch must be an object.");
    onlyKeys(input.runtimeLaunch, ["commands"], "approvalPolicy.runtimeLaunch");
    const commands = input.runtimeLaunch.commands;
    if (!Array.isArray(commands) || commands.length === 0)
      throw new Error("approvalPolicy.runtimeLaunch.commands must be a non-empty array.");
    const names = new Set<string>();
    policy.runtimeLaunch = {
      commands: commands.map((command, index) => {
        const label = `approvalPolicy.runtimeLaunch.commands[${index}]`;
        if (!isRecord(command)) throw new Error(`${label} must be an object.`);
        onlyKeys(command, ["name", "start", "stop"], label);
        if (typeof command.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(command.name))
          throw new Error(`${label}.name must be a short lowercase identifier.`);
        if (names.has(command.name))
          throw new Error(`${label}.name ${command.name} is duplicated.`);
        names.add(command.name);
        return {
          name: command.name,
          start: template(command.start, `${label}.start`),
          ...(command.stop !== undefined
            ? { stop: template(command.stop, `${label}.stop`) }
            : {}),
        };
      }),
    };
  }
  if (policy.runtimeLaunch && !policy.grants.includes("runtime-launch"))
    throw new Error("approvalPolicy.runtimeLaunch requires the runtime-launch grant.");
  return policy;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Hash of the validated policy, so formatting edits keep the acknowledgement
 * but any change to what is granted needs a new one. */
export function approvalPolicyHash(policy: ApprovalPolicy): string {
  return createHash("sha256").update(canonical(policy)).digest("hex");
}

/** Why an operation falls outside the standing policy, or undefined when it
 * is inside. Worktree cleanliness is checked by the caller (it needs git). */
export function outsidePolicyReason(
  policy: ApprovalPolicy,
  workflow: PolicyWorkflow,
  operation: StandingOperation,
): string | undefined {
  if (!policy.grants.includes(operation))
    return `approvalPolicy does not grant ${operation}`;
  if (operation === "resume") return undefined;
  for (const lane of workflow.lanes) {
    if (lane.mcpServers && Object.keys(lane.mcpServers).length)
      return `lane ${lane.id} requests extra MCP servers`;
    if (!lane.taskProfile && lane.launchProfile !== undefined)
      return `lane ${lane.id} uses an ad-hoc launchProfile`;
    if (!lane.taskProfile && !workflow.taskProfile)
      return `lane ${lane.id} has no configured taskProfile`;
  }
  return undefined;
}

/** Decide one operation against the configured policy and its recorded
 * acknowledgement. `raw` is the config's approvalPolicy value (undefined when
 * the project has none). */
export function standingDecision(
  raw: unknown,
  ack: ApprovalPolicyAck | undefined,
  workflow: PolicyWorkflow,
  operation: StandingOperation,
): StandingDecision {
  if (raw === undefined)
    return { kind: "none", reason: "no approvalPolicy is configured" };
  let policy: ApprovalPolicy;
  try {
    policy = validateApprovalPolicy(raw);
  } catch (error) {
    return {
      kind: "none",
      reason: `configured approvalPolicy is invalid: ${(error as Error).message}`,
    };
  }
  const hash = approvalPolicyHash(policy);
  const outside = outsidePolicyReason(policy, workflow, operation);
  if (outside) return { kind: "outside", reason: outside, policy, hash };
  if (ack?.hash !== hash) return { kind: "needs-ack", policy, hash };
  return { kind: "granted", policy, hash };
}

export type LedgerEntry = { at: string; kind: string; text: string };
export type StandingResult = {
  granted: boolean;
  evidence: LedgerEntry[];
  ack?: ApprovalPolicyAck;
};
export type StandingPorts = {
  /** The config's approvalPolicy value; may throw when the file is unreadable. */
  policy(): unknown;
  ack(): Promise<ApprovalPolicyAck | undefined>;
  /** False on a headless bridge: an unacknowledged policy then never applies. */
  interactive: boolean;
  confirm(title: string, message: string): Promise<boolean>;
  /** Throws when the workflow's worktree is not clean; omitted without one. */
  cleanWorktree?: () => Promise<void>;
  now(): string;
  rootPaneId: string;
};

export function approvalPolicySummary(policy: ApprovalPolicy, hash: string): string {
  const lines = [
    `Policy ${hash.slice(0, 12)} from .baa-ton/config.json.`,
    `Runs without a dialog: ${policy.grants.join(", ")}.`,
    "Only inside policy: configured task profiles, no extra MCP servers, clean worktree.",
  ];
  for (const command of policy.runtimeLaunch?.commands ?? [])
    lines.push(
      `Runtime ${command.name}: ${command.start}${command.stop ? ` (stop: ${command.stop})` : ""}`,
    );
  if (policy.grants.includes("local-validation"))
    lines.push(
      "Local validation: a lane's frozen install, build, codegen, typecheck, lint and tests (headed browser tests too) in its own worktree and leased ports.",
    );
  lines.push(
    policy.grants.includes("local-validation")
      ? "Always asks: package or lockfile edits, shared databases or services, push, merge, deploy, production, close, sweep, reparent."
      : "Always asks: push, merge, deploy, production, close, sweep, reparent.",
  );
  return lines.join("\n");
}

/** The standing-policy path for one routine operation. The caller persists
 * the result; `granted: false` falls back to the one-off confirmation. */
export async function authorizeStanding(
  ports: StandingPorts,
  workflow: PolicyWorkflow,
  operation: StandingOperation,
  label: string,
): Promise<StandingResult> {
  const entry = (granted: boolean, text: string): LedgerEntry => ({
    at: ports.now(),
    kind: granted ? "authorization-policy-granted" : "approval-policy-not-applied",
    text: `Standing ${operation}: ${text}`,
  });
  let raw: unknown;
  try {
    raw = ports.policy();
  } catch (error) {
    return {
      granted: false,
      evidence: [entry(false, `cannot read approvalPolicy: ${(error as Error).message}`)],
    };
  }
  if (raw === undefined) return { granted: false, evidence: [] };
  const decision = standingDecision(raw, await ports.ack(), workflow, operation);
  if (decision.kind === "none" || decision.kind === "outside")
    return { granted: false, evidence: [entry(false, decision.reason)] };
  const short = decision.hash.slice(0, 12);
  let ack: ApprovalPolicyAck | undefined;
  if (decision.kind === "needs-ack") {
    if (!ports.interactive)
      return {
        granted: false,
        evidence: [entry(false, `approvalPolicy ${short} is not acknowledged; run herdr_policy action=ack`)],
      };
    const approved = await ports.confirm(
      "Herdr standing approval policy",
      `${approvalPolicySummary(decision.policy, decision.hash)}\n\nRecord this policy and ${label}?`,
    );
    if (!approved)
      return {
        granted: false,
        evidence: [entry(false, `approvalPolicy ${short} acknowledgement declined`)],
      };
    ack = {
      hash: decision.hash,
      grants: decision.policy.grants,
      ackedAt: ports.now(),
      rootPaneId: ports.rootPaneId,
    };
  }
  const evidence: LedgerEntry[] = ack
    ? [{
        at: ports.now(),
        kind: "approval-policy-acknowledged",
        text: `approvalPolicy ${short} acknowledged: grants=${ack.grants.join(",")}`,
      }]
    : [];
  if (ports.cleanWorktree) {
    try {
      await ports.cleanWorktree();
    } catch (error) {
      evidence.push(entry(false, (error as Error).message));
      return { granted: false, evidence, ack };
    }
  }
  evidence.push(entry(true, `approvalPolicy ${short}`));
  return { granted: true, evidence, ack };
}
