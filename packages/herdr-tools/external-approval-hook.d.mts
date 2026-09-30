export interface ApprovedGhOperation {
  operation: "create" | "merge";
  argv: string[];
  repo: string;
}
export interface ExternalApprovalBinding {
  repo: string;
  head: string;
  branch: string;
  target: string;
  baseRef: string;
  headRef: string;
  targetRepo: string;
  host: string;
  remoteName: string;
  paneId: string;
  sessionId: string;
  caller: "root";
}
export function approveExternalGhCommand(options: {
  command: string;
  enabled: boolean;
  caller: "root" | "child";
  hasUI: boolean;
  sessionFile?: string;
  resolveBinding: (operation: ApprovedGhOperation) => Promise<ExternalApprovalBinding | undefined>;
  confirm: (operation: ApprovedGhOperation, binding: ExternalApprovalBinding) => Promise<boolean>;
  now?: number;
}): Promise<boolean>;
