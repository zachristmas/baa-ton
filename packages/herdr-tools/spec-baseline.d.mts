export type SuiteFailure = { package: string; task: string };
export const BASELINES_KEPT: number;
export function failureKey(failure: SuiteFailure): string;
export function suiteFailures(text: unknown): SuiteFailure[];
export function knownFailures(baseline: unknown): SuiteFailure[] | undefined;
export function compareToBaseline(failures: SuiteFailure[], known: SuiteFailure[]): { pass: boolean; fresh: SuiteFailure[]; known: SuiteFailure[] };
export function formatFailures(failures: SuiteFailure[]): string;
export function baselineResult(summary: unknown): { sha?: string; suite?: "pass" | "fail"; failures: SuiteFailure[] };
export function baselineObjective(spec: { target: { remote: string; branch: string; suite: string[] } }, options: { sha: string }): string;
export function fixBaselineObjective(
  spec: { target: { remote: string; branch: string; suite: string[] } },
  options: { sha: string; failures: SuiteFailure[]; integrationBranch: string },
): string;
export function baselineNote(known: SuiteFailure[] | undefined, sha: string): string;
