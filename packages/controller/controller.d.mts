export type ChildMessageHerdrClient = {
  request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
};

export function routeChildMessage(options: {
  configDir?: string;
  stateDir?: string;
  workflowId: string;
  laneId: string;
  messageId: string;
  herdr?: ChildMessageHerdrClient;
}): Promise<{
  accepted: boolean;
  delivery: "pending" | "delivered" | "uncertain";
  request: { id: string; delivery: { status: string } };
}>;

export type CapacitySample = {
  freeMemoryGb?: number;
  swapUsedGb?: number;
  load1PerCpu?: number;
};

export function sampleCapacity(): Promise<CapacitySample>;

export type LoadedCode = {
  checkout: string;
  fingerprint: string;
  commit?: string;
  stamp: string;
};
export type RuntimeRecord = {
  role: string;
  pid: number;
  startedAt: string;
  checkout?: string;
  fingerprint?: string;
  commit?: string;
  paneId?: string;
  workspaceId?: string;
  sessionPath?: string;
  agentKind?: string;
};
export const checkoutRoot: string;
export function loadedCode(root?: string): LoadedCode;
export function codeFingerprint(root?: string): string;
export function gitCommit(root?: string): string | undefined;
export function recordRuntime(configDir: string | undefined, record: Record<string, unknown>): () => void;
export function listRuntime(configDir: string | undefined): RuntimeRecord[];

export type IdleLaneService = { workflowId: string; laneId: string; name: string; kind: string; where: string };
export function idleLaneServices(workflows: unknown): IdleLaneService[];
export function describeIdleServices(idle: IdleLaneService[], limit?: number): string;
export function isHarnessCommand(command: unknown): boolean;
export function laneFinished(lane: unknown): boolean;
export function parseProcessIdentity(stdout: string): { start: string; command: string } | undefined;
export function paneServiceProcesses(paneInfo: unknown): Array<{ pid: number; name: string }>;
export function liveAgentReady(
  result: unknown,
  expected: { pane_id?: string; workspace_id?: string; name?: string; agent_kind?: string },
): { ok: true; agent: Record<string, unknown> } | { ok: false; reason: string };
