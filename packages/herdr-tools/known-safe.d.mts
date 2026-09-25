export type KnownSafeOptions = {
  cwd?: string;
  branchPattern?: RegExp;
  ownBranch?: string;
  allowOwnBranchPush?: boolean;
  allowMergeByBranch?: boolean;
  mergeRepo?: string;
};

export function commandSegments(command: string): {
  segments: string[];
  heredocTargets: string[];
  body: string;
  expandingBody: boolean;
};

export function classifyCommand(
  command: string,
  options?: KnownSafeOptions,
): { decision: "allow"; rules: string[] } | { decision: "defer"; reason: string };

export function classifyLocalValidation(
  command: string,
  options?: { cwd?: string; leasedPorts?: number[] },
): { matched: true; classes: string[] } | { matched: false; reason: string };

export function laneConfinedVerdict(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  options?: { cwd?: string },
): { allow: boolean; reason: string };
