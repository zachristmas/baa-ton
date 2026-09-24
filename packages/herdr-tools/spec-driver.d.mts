import type { Spec, SpecItem, SpecState } from "./spec.mjs";

export const ACTIVE_STATES: Set<string>;
export function globsOverlap(left: string, right: string): boolean;
export function reviewVerdict(summary: unknown): "pass" | "fail" | undefined;
export type SpecAction = { kind: "build" | "review"; itemId: string; attempt: number; findings?: string };
export function advanceSpec(input: {
  spec: Spec;
  state: SpecState | undefined;
  lane: (ref: { workflowId: string; laneId: string }) => { status?: string; receipt?: { summary: string } } | undefined;
  capacityWaiting?: boolean;
  now: string;
}): {
  state: SpecState;
  actions: SpecAction[];
  rootAsks: Array<{ itemId: string; reason: string }>;
  waits: Record<string, string>;
};
export function buildObjective(spec: Spec, item: SpecItem, options: { branch: string; findings?: string }): string;
export function reviewObjective(spec: Spec, item: SpecItem, options: { branch: string; buildSummary?: string }): string;
