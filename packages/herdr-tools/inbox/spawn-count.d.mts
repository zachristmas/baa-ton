type Env = Record<string, string | undefined>;
export const SPAWN_COUNT_FILE: string;
export function spawnCountPath(env?: Env): string;
export function spawnKey(file: unknown, args?: unknown[]): string;
export function installSpawnCounter(role: string, options?: { env?: Env; path?: string; clock?: () => number }): () => void;
export type SpawnCounts = { total: number; byRole: Record<string, Record<string, number>> };
export function createSpawnCountReader(options?: { path?: string }): { read(): SpawnCounts };
export function formatSpawnCounts(counts: SpawnCounts, extra?: Record<string, number>): string;
