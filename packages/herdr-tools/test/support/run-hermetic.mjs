#!/usr/bin/env node
/**
 * Run a test command isolated from the caller's live agent session.
 *
 * Baa-ton is usually developed from inside a Herdr pane running Claude Code,
 * Pi or Codex. Those sessions export identity variables (for example
 * CLAUDE_CODE_SESSION_ID or HERDR_PANE_ID) that production code reads on
 * purpose, so tests inherited them and took live-identity paths their fakes do
 * not model. They also inherited a PATH that reaches the live herdr, claude,
 * codex, opencode and pi installs.
 *
 * This runner removes session variables and puts stub binaries first on PATH,
 * so a test run behaves the same in a terminal, inside an agent session or in
 * CI. Tests that need a variable or a binary set or inject it themselves.
 */
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SESSION_VARIABLE =
  /^(HERDR_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$|PI_|BAA_|CODEX_|OPENCODE_)/;

export function hermeticEnvironment(env = process.env) {
  const stubs = join(dirname(fileURLToPath(import.meta.url)), "bin");
  const pathKey =
    Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const isolated = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SESSION_VARIABLE.test(key)) isolated[key] = value;
  }
  isolated[pathKey] = [stubs, env[pathKey]].filter(Boolean).join(delimiter);
  // Running pieces record their loaded code in the controller config dir,
  // which falls back to the user's real Herdr directory. Tests of the
  // recorder pass an explicit directory instead.
  isolated.BAA_TON_NO_RUNTIME_RECORDS = "1";
  return isolated;
}

const suites = {
  extension: [
    ["packages/herdr-tools/smoke-check.mjs"],
    // Bounded concurrency: every file compiles the ~10k-line extension (and
    // some spawn MCP bridges that compile it again), so one file per CPU can
    // exhaust memory on a busy machine and starve a bridge past its timeout.
    ["--test", "--test-concurrency=4", "packages/herdr-tools/test/*.test.mjs"],
  ],
  controller: [["--test", "packages/controller/test/controller.test.mjs", "packages/controller/test/lane-services.test.mjs", "packages/controller/test/blocked-lane.test.mjs"]],
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(suites);
  const env = hermeticEnvironment();
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
  for (const name of names) {
    if (!suites[name]) throw new Error(`Unknown test suite: ${name}`);
    for (const args of suites[name]) {
      // node --test expands the glob itself, so this also works under cmd.exe.
      const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  }
}
