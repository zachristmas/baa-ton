import type { ApprovedGhOperation, ExternalApprovalBinding } from "./external-approval-hook.mjs";
export interface ApprovedPushOperation {
  operation: "push";
  argv: string[];
  remoteName: string;
  branch: string;
  sourceRef: string;
  destinationRef: string;
}
export type ApprovedExternalOperation = ApprovedGhOperation | ApprovedPushOperation;
export interface ExternalApprovalResolvedBinding extends ExternalApprovalBinding {
  headRef: string;
  headRefOid: string;
  baseRefOid: string;
  remoteUrl: string;
  remoteRepo: string;
  destinationRef?: string;
  destinationOid?: string;
  pr?: {
    number: number;
    state: string;
    headRepo: string;
    headOid: string;
    headBranch: string;
    baseRepo: string;
    baseBranch: string;
    baseOid: string;
  };
}
export function createExternalApprovalResolver(options: {
  cwd: string;
  execFile: (program: string, args: string[], options: Record<string, unknown>) => Promise<{ stdout: string }>;
  sessionFile: string;
  paneId?: string;
}): (operation: ApprovedExternalOperation) => Promise<ExternalApprovalResolvedBinding>;
export function assertExternalApprovalBindingCurrent(operation: ApprovedExternalOperation, approved: ExternalApprovalResolvedBinding, resolveBinding: (operation: ApprovedExternalOperation) => Promise<ExternalApprovalResolvedBinding>): Promise<ExternalApprovalResolvedBinding>;
