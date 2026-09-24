export function recoveryHash(value: string): string;

export type RootRecoveryPlan = {
  oldRootId: string;
  newRootId: string;
  oldRoot: Record<string, unknown>;
  root: Record<string, unknown>;
  workflowIds: string[];
  config: Record<string, unknown>;
  manifest: Record<string, unknown>;
};

export function rootRecoveryPlan(input: {
  config: any;
  manifest: any;
  cwd: string;
  oldRootId: string;
  root: any;
  session: any;
  liveWorkspaceIds: string[];
}): RootRecoveryPlan;

export function readRecoveryFiles(
  configPath: string,
  manifestPath: string,
): Promise<{ config: string; manifest: string }>;

export function assertNoPendingRecovery(directory: string): Promise<void>;

export function commitRootRecovery(input: {
  configPath: string;
  manifestPath: string;
  auditDir: string;
  before: { config: string; manifest: string };
  plan: RootRecoveryPlan;
  evidence: string;
  write?: (path: string, text: string) => Promise<void>;
}): Promise<Record<string, unknown>>;
