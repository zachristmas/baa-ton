import assert from "node:assert/strict";
import { test } from "node:test";
import { baselineResult, compareToBaseline, knownFailures, suiteFailures } from "../spec-baseline.mjs";

test("failures are read per package and task from receipts and common runner outputs", () => {
  assert.deepEqual(suiteFailures("SUITE: fail\nFAILED: @gsd/ticket-service lint\nFAILED: @gsd/web test\nFAILED: @gsd/web test"), [
    { package: "@gsd/ticket-service", task: "lint" },
    { package: "@gsd/web", task: "test" },
  ]);
  const turbo = [
    "\x1b[31m@gsd/ticket-service#lint: command (/r/apps/ticket) /bin/pnpm run lint exited (1)\x1b[0m",
    " Tasks:    40 successful, 42 total",
    "Failed:    @gsd/ticket-service#lint, @gsd/api-clients#typecheck",
  ].join("\n");
  assert.deepEqual(suiteFailures(turbo).map((failure) => `${failure.package} ${failure.task}`), ["@gsd/ticket-service lint", "@gsd/api-clients typecheck"]);
  assert.deepEqual(suiteFailures(" ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @gsd/web@1.0.0 test: `vitest run`"), [{ package: "@gsd/web", task: "test" }]);
  assert.deepEqual(suiteFailures("✖  nx run ticket-service:lint\n\nFailed tasks:\n\n- ticket-service:lint\n- web:test"), [
    { package: "ticket-service", task: "lint" },
    { package: "web", task: "test" },
  ]);
  assert.deepEqual(suiteFailures("All 42 tasks passed.\n1. Build\n- note: fine"), []);
});

test("an integration passes only when every failure is already failing at the baseline", () => {
  const known = [{ package: "@gsd/ticket-service", task: "lint" }];
  assert.equal(compareToBaseline([{ package: "@GSD/ticket-service", task: "LINT" }], known).pass, true, "case-insensitive");
  const mixed = compareToBaseline([{ package: "@gsd/ticket-service", task: "lint" }, { package: "@gsd/web", task: "test" }], known);
  assert.equal(mixed.pass, false);
  assert.deepEqual(mixed.fresh, [{ package: "@gsd/web", task: "test" }]);
  assert.equal(compareToBaseline([{ package: "@gsd/ticket-service", task: "test" }], known).pass, false, "same package, other task");
  assert.equal(compareToBaseline([], known).pass, false, "no parsed failures: nothing to compare");
});

test("baseline receipts and what a fix leaves", () => {
  const sha = "4".repeat(40);
  assert.deepEqual(baselineResult(`BASELINE: ${sha}\nSUITE: fail\nFAILED: a lint`), { sha, suite: "fail", failures: [{ package: "a", task: "lint" }] });
  assert.deepEqual(knownFailures({ failures: [{ package: "a", task: "lint" }] }), [{ package: "a", task: "lint" }]);
  assert.deepEqual(knownFailures({ failures: [{ package: "a", task: "lint" }], fix: { remaining: [] } }), []);
  assert.deepEqual(knownFailures({ failures: [{ package: "a", task: "lint" }], fix: { gaveUp: true } }), [{ package: "a", task: "lint" }]);
  assert.equal(knownFailures({ unknown: true }), undefined);
});
