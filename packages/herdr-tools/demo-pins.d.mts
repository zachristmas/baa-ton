export type DemoPins = { dirs: string[]; ports: number[]; databases: string[] };
export function findDemoPins(worktree: string | undefined, itemId: string | undefined): DemoPins | undefined;
export function demoPinLines(pins: DemoPins | undefined): string[];
