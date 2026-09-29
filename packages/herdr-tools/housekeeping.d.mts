export const HOUSEKEEPING_DEFAULTS: { archiveMinAgeMs: number; keepRecent: number; scratchMinAgeMs: number };
export function mentionedWorkflowIds(...values: unknown[]): Set<string>;
export function liveSpecWorkflowIds(specState: unknown): Set<string>;
export function archivableWorkflows(
  manifest: { workflows?: Array<Record<string, any>> } | undefined,
  options?: { now?: number; protectedIds?: Set<string>; archiveMinAgeMs?: number; keepRecent?: number },
): Set<string>;
export function workflowFiles(workflow: unknown, stateDir: string): string[];
export function staleScratch(input: {
  names: string[];
  now?: number;
  mtimeOf: (name: string) => number;
  liveCommandLines?: string[];
  scratchMinAgeMs?: number;
}): string[];
export function writeArchive(stateDir: string, workflows: unknown[], now?: number): string | undefined;
export function removeFiles(paths: string[]): number;
export function scratchNames(stateDir: string): string[];
export function mtimeIn(stateDir: string): (name: string) => number;
export function capList<T>(items: T[] | undefined, limit?: number): { items: T[]; total: number; omitted: number };
export function groupBy<T>(items: T[] | undefined, key: (item: T) => string): Array<{ text: string; count: number }>;
