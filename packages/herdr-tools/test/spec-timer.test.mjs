import assert from "node:assert/strict";
import { test } from "node:test";
import { specDriverTimer } from "../spec-timer.mjs";

/** A fake clock: schedule() records timers; advance(ms) fires the due ones in order. */
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    schedule(callback, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = until;
      await new Promise((resolve) => setImmediate(resolve));
    },
    get pending() {
      return timers.size;
    },
  };
}

test("passes run on the timer, with no turn involved, and back off when a pass throws", async () => {
  const clock = fakeClock();
  const reasons = [];
  let failing = false;
  const errors = [];
  const timer = specDriverTimer({
    run: async () => {
      if (failing) throw new Error("manifest locked");
      return { actions: [] };
    },
    log: (_result, reason) => reasons.push(reason),
    onError: (error) => errors.push(error.message),
    schedule: clock.schedule,
    cancel: clock.cancel,
    intervalMs: 25_000,
    maxDelayMs: 100_000,
  });
  timer.start();
  await clock.advance(24_999);
  assert.equal(timer.passes, 0);
  await clock.advance(1);
  await clock.advance(25_000);
  assert.deepEqual(reasons, ["timer", "timer"]);

  failing = true;
  await clock.advance(25_000);
  assert.equal(timer.delay, 50_000, "a failed pass doubles the delay");
  await clock.advance(50_000);
  await clock.advance(100_000);
  assert.equal(timer.delay, 100_000, "capped");
  assert.deepEqual(errors, ["manifest locked", "manifest locked", "manifest locked"]);
  failing = false;
  await clock.advance(100_000);
  assert.equal(timer.delay, 25_000, "a good pass resets it");

  timer.stop();
  assert.equal(clock.pending, 0, "stop cancels every timer");
  const before = timer.passes;
  await clock.advance(200_000);
  assert.equal(timer.passes, before);
});

test("passes never overlap: a tick or change during a pass leaves exactly one follow-up", async () => {
  const clock = fakeClock();
  let release;
  let concurrent = 0;
  let maxConcurrent = 0;
  const reasons = [];
  let changed;
  const timer = specDriverTimer({
    run: async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => (release = resolve));
      concurrent -= 1;
      return {};
    },
    log: (_result, reason) => reasons.push(reason),
    schedule: clock.schedule,
    cancel: clock.cancel,
    watch: (onChange) => {
      changed = onChange;
      return () => (changed = undefined);
    },
    intervalMs: 25_000,
    debounceMs: 2_000,
  });
  timer.start();
  await clock.advance(25_000);
  assert.equal(timer.running, true, "the first pass is still running (a slow dispatch)");
  const second = timer.kick("settled");
  changed();
  changed();
  await clock.advance(2_000);
  await second;
  assert.equal(timer.passes, 1, "nothing started while the pass ran");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timer.passes, 2, "one follow-up pass for everything that arrived meanwhile");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxConcurrent, 1);
  assert.deepEqual(reasons, ["timer", "follow-up"]);

  // A manifest change is debounced into one pass.
  changed();
  changed();
  await clock.advance(1_999);
  assert.equal(timer.passes, 2);
  await clock.advance(1);
  assert.equal(timer.passes, 3);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reasons.at(-1), "change");
  timer.stop();
  assert.equal(changed, undefined, "stop closes the watcher");
});
