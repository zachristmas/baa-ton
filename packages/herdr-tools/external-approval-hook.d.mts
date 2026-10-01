export type ExternalApprovalStage = "parse" | "resolve-before" | "confirm" | "resolve-after" | "allow" | "deny";
export type ExternalApprovalDenial = "none" | "disabled" | "non_root" | "no_ui" | "no_session" | "no_confirm" | "unsafe_command" | "unsupported_command" | "binding_mismatch" | "declined" | "binding_changed" | "token_rejected" | "resolver_error";
export interface ExternalApprovalDiagnostic {
  mode: string;
  hasUI: boolean;
  confirmAvailable: boolean;
  stage: ExternalApprovalStage;
  denial: ExternalApprovalDenial;
}
export interface ApprovedGhOperation {
  operation: "create" | "merge";
  argv: string[];
  repo: string;
}
export interface ApprovedPushOperation {
  operation: "push";
  argv: string[];
  remoteName: string;
  branch: string;
  sourceRef: string;
  destinationRef: string;
}
export type ApprovedExternalOperation = ApprovedGhOperation | ApprovedPushOperation;
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
  headRefOid?: string;
  baseRefOid?: string;
  remoteRepo?: string;
  remoteUrl?: string;
  destinationRef?: string;
  destinationOid?: string;
  pr?: Record<string, unknown>;
}
export function approveExternalGhCommand(options: {
  command: string;
  enabled: boolean;
  caller: "root" | "child";
  hasUI: boolean;
  mode?: string;
  confirmAvailable?: boolean;
  diagnostic?: (record: ExternalApprovalDiagnostic) => void;
  sessionFile?: string;
  resolveBinding: (operation: ApprovedExternalOperation) => Promise<ExternalApprovalBinding | undefined>;
  confirm: (operation: ApprovedExternalOperation, binding: ExternalApprovalBinding) => Promise<boolean>;
  now?: number;
}): Promise<boolean>;
