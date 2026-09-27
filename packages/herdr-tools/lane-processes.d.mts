export const LANE_MARKER: string;
export const ORPHAN_SHELL_AGE_MS: number;
export type ProcessRow = { pid: number; ppid: number; ageMs?: number; line: string };
export function elapsedMs(etime: string): number | undefined;
export function parseProcessTable(text: string): ProcessRow[];
export function readProcessTable(run?: (args: string[]) => Promise<{ stdout: string }>): Promise<ProcessRow[]>;
export function laneProcesses(rows: ProcessRow[], intentPath: string | undefined, options?: { self?: number }): ProcessRow[];
export function killLaneProcesses(input: {
  intentPath?: string;
  table?: () => Promise<ProcessRow[]>;
  kill?: (pid: number, signal: string) => unknown;
  graceMs?: number;
  delay?: (ms: number) => Promise<unknown>;
}): Promise<{ signalled: Array<{ pid: number; command: string }>; killed?: number[]; survivors: number[] }>;
export function portListening(port: number, options?: { timeoutMs?: number }): Promise<boolean>;
export function busyPorts(ports: number[] | undefined, listening?: (port: number) => Promise<boolean>): Promise<number[]>;
export function orphanShells(rows: ProcessRow[], options?: { minAgeMs?: number }): Array<{ pid: number; ageMs?: number; command: string }>;
