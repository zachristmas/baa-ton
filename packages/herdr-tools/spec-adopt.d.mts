import type { Spec, SpecState } from "./spec.mjs";

export type AdoptionDecision = { at: string; itemId: string; decision: "resolved"; reason: string; by: string };
export type AdoptionRow = { id: string; state: string; reason: string; warnings: string[] };
export function isSecretPath(path: string): boolean;
export function globToRegExp(glob: string): RegExp;
export function itemOwnedChanges(
  porcelain: string,
  owns?: string[],
  sharedTouch?: string[],
): { paths: string[]; secrets: string[]; outside: string[]; untracked: string[] };
export function specCommitMessage(itemId: string, subject: string): string;
export function failureOutput(error: unknown, lines?: number): string;
export function itemDeferred(item: Spec["items"][number]): boolean;
export function proposeAdoption(input: {
  spec: Spec;
  manifest: unknown;
  repo: string;
  now: string;
  readReport?: (path: string) => Promise<Buffer | undefined>;
}): Promise<{ state: SpecState; rows: AdoptionRow[]; resolved: AdoptionDecision[] }>;
export function adoptionTable(rows: AdoptionRow[]): string;
export function adoptSpec(input: {
  cwd: string;
  dryRun?: boolean;
  force?: boolean;
  now?: string;
  readReport?: (path: string) => Promise<Buffer | undefined>;
}): Promise<{ state: SpecState; rows: AdoptionRow[]; resolved: AdoptionDecision[]; written: boolean }>;
