export type ExternalApprovalBinding = { repo: string; head: string; branch: string; target: string; targetRepo: string; host: string; remoteName: string; baseRef?: string; headRef?: string; paneId: string; sessionId: string; caller: "root" };
export type ExternalApproval = { id: string; digest: string; argv: string[]; operation: "create" | "merge"; binding: ExternalApprovalBinding; expiresAt: number; used: boolean };
export function parseApprovedGhOperation(command: string): { operation: "create" | "merge"; argv: string[]; repo: string } | undefined;
export function containsGhPrMutation(command: string): boolean;
export function issueExternalApproval(command: string, binding: ExternalApprovalBinding, options?: { now?: number; ttlMs?: number }): ExternalApproval | undefined;
export function consumeExternalApproval(token: ExternalApproval | undefined, command: string, binding: ExternalApprovalBinding, options?: { now?: number }): boolean;
