export const SPEC_TIMER_INTERVAL_MS: number;
export const SPEC_TIMER_DEBOUNCE_MS: number;
export const SPEC_TIMER_MAX_DELAY_MS: number;
export function specDriverTimer(options: {
  run: () => Promise<unknown>;
  log?: (result: unknown, reason: string) => void;
  onError?: (error: unknown) => void;
  schedule?: (callback: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  watch?: (onChange: () => void) => (() => void) | undefined;
  intervalMs?: number;
  debounceMs?: number;
  maxDelayMs?: number;
}): {
  start(): void;
  stop(): void;
  kick(reason?: string): Promise<void>;
  readonly running: boolean;
  readonly passes: number;
  readonly delay: number;
  readonly active: boolean;
};
