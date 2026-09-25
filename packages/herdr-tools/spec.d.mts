export const SPEC_PATH: string;
export const SPEC_STATE_PATH: string;
export const STAGES: string[];
export const ITEM_STATES: string[];

export type SpecItem = {
  adopt?: { worktree?: string; branch?: string; report?: string; workflow?: string; review?: string; accepted?: boolean; resolved?: string };
  id: string;
  title: string;
  dependsOn: string[];
  owns: string[];
  sharedTouch: string[];
  migrations: number;
  decisions: string[];
  acceptance: {
    text: string;
    tests: string[];
    preview: string[];
    evidence?: { report: string; minImages: number };
  };
};
export type Spec = {
  version: 1;
  target: { repo: string; remote: string; branch: string; suite: string[]; preview?: { url: string; releaseCheck?: string } };
  defaults: {
    maxParallel: number;
    maxBuildAttempts: number;
    pushGate: "round" | "item";
    finalReport: "alongside" | "replace";
    minFreeMemoryGb?: number;
    maxSwapUsedGb?: number;
  };
  stages: Record<string, { profile: string; differentFrom?: string }>;
  items: SpecItem[];
};
export type SpecAdopt = { worktree?: string; branch?: string; report?: string; workflow?: string; review?: string; accepted?: boolean };
export type SpecState = { version: 1; items: Record<string, any> };
export type ItemVerification = {
  id: string;
  done: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  failing?: { name: string; ok: boolean; detail: string };
};
export type SpecVerification = {
  done: number;
  total: number;
  byDecision?: number;
  deferred?: number;
  results: Array<ItemVerification & { deferred?: boolean; resolved?: boolean }>;
};

export function validateSpec(input: unknown): Spec;
export function validateSpecState(input: unknown): SpecState;
export function targetRepo(spec: Spec, cwd: string): string;
export function loadSpec(cwd: string): Promise<Spec | undefined>;
export function loadSpecState(cwd: string): Promise<SpecState>;
export function docxImageCount(buffer: Buffer): number | undefined;
export function reportImageCount(path: string, buffer: Buffer): number | undefined;
export function verifyItem(
  spec: Spec,
  state: SpecState,
  item: SpecItem,
  options: { repo: string; ancestor?: (repo: string, ancestor: string, descendant: string) => Promise<boolean> },
): Promise<ItemVerification>;
export function verifySpec(
  spec: Spec,
  state: SpecState,
  options: { repo: string; ancestor?: (repo: string, ancestor: string, descendant: string) => Promise<boolean> },
): Promise<SpecVerification>;
export function itemStage(state: SpecState, id: string, verified?: ItemVerification): string;
export function specSummaryLine(spec: Spec, state: SpecState, verification: SpecVerification): string;
export function specStatusTable(spec: Spec, state: SpecState, verification: SpecVerification, now?: number): string;
export function gitAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean>;
/** A report's path for the final evidence (the .final sibling unless replace). */
export function finalReportPath(spec: Spec, report: string): string;
/** The deployed SHA from a release-check response body (JSON or text). */
export function releaseShaFrom(body: string): string | undefined;
