/**
 * Run the spec driver on a timer inside the root's extension, independent of
 * the LLM turn. A root can stay in one long turn for many minutes, and the
 * driver used to run only when a turn settled, so finished lanes waited.
 * The driver opens no dialog and needs no LLM, so a pass is safe mid-turn.
 *
 * - A pass every `intervalMs`, and a debounced pass when the manifest
 *   changes (lane receipts and statuses land there).
 * - Never two passes at once: a tick or change during a pass sets a flag,
 *   and exactly one follow-up pass runs when it finishes.
 * - `minChangeGapMs`: a change (or follow-up) pass waits until that long
 *   after the last pass ended. The manifest changes all the time (the
 *   supervisor's own tick writes it), and back-to-back passes made the spec
 *   host start ~1,700 herdr calls a minute.
 * - A pass that throws backs the timer off (doubling, up to `maxDelayMs`);
 *   the driver's own capacity and shell-timeout backoff still apply inside it.
 */

export const SPEC_TIMER_INTERVAL_MS = 25_000;
export const SPEC_TIMER_DEBOUNCE_MS = 2_000;
export const SPEC_TIMER_MAX_DELAY_MS = 5 * 60_000;

/**
 * @param {object} options
 * @param {() => Promise<unknown>} options.run          one driver pass
 * @param {(result: unknown, reason: string) => void} [options.log]
 * @param {(error: unknown) => void} [options.onError]
 * @param {(callback: () => void, ms: number) => unknown} [options.schedule]
 * @param {(handle: unknown) => void} [options.cancel]
 * @param {(onChange: () => void) => (() => void) | undefined} [options.watch] start watching; returns a stop function
 */
export function specDriverTimer({
  run,
  log = () => {},
  onError = () => {},
  schedule = (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  cancel = (handle) => clearTimeout(handle),
  watch,
  intervalMs = SPEC_TIMER_INTERVAL_MS,
  debounceMs = SPEC_TIMER_DEBOUNCE_MS,
  maxDelayMs = SPEC_TIMER_MAX_DELAY_MS,
  minChangeGapMs = 0,
  now = () => Date.now(),
} = {}) {
  let lastPassEnd = -Infinity;
  const gapWait = (ms) => Math.max(ms, minChangeGapMs > 0 ? lastPassEnd + minChangeGapMs - now() : 0);
  let tickHandle;
  let debounceHandle;
  let stopWatching;
  let running = false;
  let again = false;
  let stopped = true;
  let delay = intervalMs;
  let passes = 0;

  const arm = () => {
    if (stopped) return;
    if (tickHandle !== undefined) cancel(tickHandle);
    tickHandle = schedule(() => {
      tickHandle = undefined;
      void pass("timer");
    }, delay);
  };

  async function pass(reason) {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      passes += 1;
      const result = await run();
      delay = intervalMs;
      log(result, reason);
    } catch (error) {
      delay = Math.min(delay * 2, maxDelayMs);
      onError(error);
    } finally {
      running = false;
      lastPassEnd = now();
    }
    if (again && !stopped) {
      again = false;
      if (minChangeGapMs > 0) {
        if (debounceHandle !== undefined) cancel(debounceHandle);
        debounceHandle = schedule(() => {
          debounceHandle = undefined;
          void pass("follow-up");
        }, gapWait(0));
        arm();
        return;
      }
      return pass("follow-up");
    }
    arm();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      delay = intervalMs;
      stopWatching = watch?.(() => {
        if (stopped) return;
        if (debounceHandle !== undefined) cancel(debounceHandle);
        debounceHandle = schedule(() => {
          debounceHandle = undefined;
          void pass("change");
        }, gapWait(debounceMs));
      });
      arm();
    },
    stop() {
      stopped = true;
      if (tickHandle !== undefined) cancel(tickHandle);
      if (debounceHandle !== undefined) cancel(debounceHandle);
      tickHandle = debounceHandle = undefined;
      stopWatching?.();
      stopWatching = undefined;
    },
    /** Run a pass now (still serialized). */
    kick: (reason = "kick") => pass(reason),
    get running() {
      return running;
    },
    get passes() {
      return passes;
    },
    get delay() {
      return delay;
    },
    get active() {
      return !stopped;
    },
  };
}
