import type { Spec, SpecItem, SpecState } from "./spec.mjs";

export const ACTIVE_STATES: Set<string>;
export function globsOverlap(left: string, right: string): boolean;
export function reviewVerdict(summary: unknown): "pass" | "fail" | undefined;
export type SpecAction = {
  kind: "decide" | "build" | "review" | "integrate" | "verify" | "ask-receipt";
  itemId: string;
  attempt: number;
  findings?: string;
  /** ask-receipt: the stage, the idle lane and the receipt format to ask for. */
  stage?: string;
  lane?: { workflowId: string; laneId: string };
  format?: string;
};
export const RECEIPT_ASK_TIMEOUT_MS: number;
export const RECEIPT_REASK_BASE_MS: number;
export function advanceSpec(input: {
  spec: Spec;
  state: SpecState | undefined;
  lane: (ref: { workflowId: string; laneId: string }) =>
    | { status?: string; workflowStatus?: string; agentStatus?: string; specStage?: string; lastMessageAt?: string; receipt?: { summary: string } }
    | undefined;
  /** true, or the reason dispatch must wait for capacity. */
  capacityWaiting?: boolean | string;
  pushed?: Set<string>;
  released?: Map<string, string>;
  dirty?: Set<string>;
  integrationLive?: string;
  contained?: Map<string, string>;
  now: string;
}): {
  state: SpecState;
  actions: SpecAction[];
  rootAsks: Array<{ itemId: string; reason: string; kind?: "push" | "decisions"; items?: string[]; sha?: string; questions?: string[] }>;
  waits: Record<string, string>;
};
export function buildObjective(
  spec: Spec,
  item: SpecItem,
  options: { branch: string; findings?: string; decided?: { summary?: string }; answers?: Array<{ text: string }> },
): string;
export function decideObjective(spec: Spec, item: SpecItem): string;
export function decideResult(summary: unknown): { questions: string[]; owns?: string[]; migrations?: number };
export function reviewObjective(spec: Spec, item: SpecItem, options: { branch: string; buildSummary?: string }): string;
export function integrationResult(summary: unknown): { sha?: string; suite?: "pass" | "fail" };
export function integrateObjective(
  spec: Spec,
  item: SpecItem,
  options: {
    integrationBranch: string;
    itemBranch: string;
    commitFirst?: { worktree: string; paths: string[]; secrets: string[]; untracked?: string[] };
  },
): string;
export function verifyResult(summary: unknown): { previews: Array<{ spec: string; result: string }>; report?: string };
export function verifyObjective(spec: Spec, item: SpecItem, options: { releaseSha?: string; reportPath: string }): string;
export function specCommitMessage(itemId: string, subject: string): string;
