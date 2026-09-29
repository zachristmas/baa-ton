export const HOST_LEASE_FILE: string;
export const DEFER_FILE: string;
export const HEARTBEAT_MS: number;
export const FRESH_MS: number;
export const RESTART_GRACE_MS: number;

export type HostLease = {
  pid: number;
  startedAt?: string;
  at: string;
  commit?: string;
  rootGone?: true;
  rootSession?: { file?: string; [key: string]: unknown };
};

export function pidAlive(pid: number): boolean;
export function renewHostLease(
  stateDir: string,
  options?: {
    startedAt?: string;
    now?: number;
    pid?: number;
    commit?: string;
    rootGone?: boolean;
    rootSession?: { file?: string; [key: string]: unknown };
  },
): void;
export function readHostLease(stateDir: string): HostLease | undefined;
export function specHandover(
  stateDir: string,
  options?: {
    host?: boolean;
    now?: number;
    pid?: number;
    alive?: (pid: number) => boolean;
  },
): string | undefined;
