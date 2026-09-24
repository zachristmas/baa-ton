export const SPEC_PATH: string;
export const SPEC_STATE_PATH: string;
export const STAGES: string[];
export const ITEM_STATES: string[];

export type SpecItem = {
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
  defaults: { maxParallel: number; maxBuildAttempts: number; pushGate: "round" | "item" };
  stages: Record<string, { profile: string; differentFrom?: string }>;
  items: SpecItem[];
};
export type SpecState = { version: 1; items: Record<string, any> };
export type ItemVerification = {
  id: string;
  done: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  failing?: { name: string; ok: boolean; detail: string };
};
export type SpecVerification = { done: number; total: number; results: ItemVerification[] };

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
