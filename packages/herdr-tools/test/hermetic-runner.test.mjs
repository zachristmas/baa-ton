import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hermeticEnvironment } from "./support/run-hermetic.mjs";

const stubs = join(fileURLToPath(new URL(".", import.meta.url)), "support", "bin");

test("hermetic environment drops agent-session identity and keeps the rest", () => {
  const env = hermeticEnvironment({
    PATH: "/usr/bin",
    HOME: "/home/tester",
    CLAUDE_CODE_SESSION_ID: "b72360d3-8ed5-4b21-80ec-244153f3e3d2",
    CLAUDECODE: "1",
    CLAUDE_PID: "123",
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w22:p1",
    HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    PI_SESSION_FILE: "/tmp/session.jsonl",
    BAA_STARTUP_INTENT: "/tmp/intent.json",
    CODEX_HOME: "/home/tester/.codex",
    OPENCODE_CONFIG: "/tmp/opencode.json",
    CLAUDE_CONFIG_DIR: "/home/tester/.claude",
  });
  assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CONFIG_DIR", "HOME", "PATH"]);
  assert.equal(env.PATH, [stubs, "/usr/bin"].join(delimiter));
});

test("hermetic environment keeps a Windows-style Path key", () => {
  const env = hermeticEnvironment({ Path: "C:\\Windows" });
  assert.equal(env.Path, [stubs, "C:\\Windows"].join(delimiter));
  assert.equal(env.PATH, undefined);
});

test("stub binaries block live installs", { skip: process.platform === "win32" }, () => {
  for (const binary of ["herdr", "claude", "codex", "opencode", "pi"]) {
    const result = spawnSync(join(stubs, binary), ["agent", "list"], { encoding: "utf8" });
    assert.equal(result.status, 97, binary);
    assert.match(result.stderr, /blocked during tests/);
  }
});
