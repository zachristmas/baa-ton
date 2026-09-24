import assert from "node:assert/strict";
import test from "node:test";
import {
  describeIdleServices,
  idleLaneServices,
  isHarnessCommand,
  laneFinished,
  paneServiceProcesses,
  parseProcessIdentity,
} from "../lane-services.mjs";

test("finished lanes are those with a receipt or terminal status and no completed retirement", () => {
  assert.equal(laneFinished({ status: "running" }), false);
  assert.equal(laneFinished({ status: "running", completionReceipt: { id: "r" } }), true);
  assert.equal(laneFinished({ status: "operator-closed" }), true);
  assert.equal(laneFinished({ status: "completed", retirement: { status: "retired" } }), false);
  assert.equal(laneFinished({ status: "completed", retirement: { status: "partial" } }), true, "a partial retirement still holds services");
});

test("idle services list registered and template services of finished lanes once each", () => {
  const idle = idleLaneServices([{
    id: "w1",
    lanes: [{ id: "a", status: "completed" }, { id: "b", status: "running" }],
    laneServices: [
      { id: "s1", laneId: "a", name: "web", kind: "pane", paneId: "p9", state: "active" },
      { id: "s2", laneId: "b", name: "api", kind: "process", pid: 5, state: "active" },
    ],
    laneRequests: [
      { laneId: "a", status: "granted", template: "compose:start" },
      { laneId: "a", status: "granted", template: "compose:start" },
      { laneId: "a", status: "granted", template: "compose:stop" },
      { laneId: "a", status: "denied", template: "web:start" },
    ],
  }]);
  assert.deepEqual(idle.map((item) => [item.name, item.where]), [["web", "pane p9"], ["compose", "runtime template"]]);
  assert.equal(describeIdleServices([]), "");
  assert.match(describeIdleServices(idle), /^Services still held by finished lanes: web \(w1\/a, pane p9\); compose \(w1\/a, runtime template\)\./);
});

test("process identity parses ps lstart and command; agents are never services", () => {
  assert.deepEqual(parseProcessIdentity("Thu Sep 24 10:01:02 2026     node server.js --port 47200\n"), {
    start: "Thu Sep 24 10:01:02 2026",
    command: "node server.js --port 47200",
  });
  assert.equal(parseProcessIdentity(""), undefined);
  for (const command of ["claude --model x", "/usr/local/bin/codex", "node /x/packages/herdr-tools/mcp-server.mjs", "herdr server", "pi"])
    assert.equal(isHarnessCommand(command), true, command);
  for (const command of ["node server.js", "postgres -D data", "next-server (v15)", "pnpm dev"])
    assert.equal(isHarnessCommand(command), false, command);
});

test("a pane service stops its foreground processes, never the shell or an agent", () => {
  const info = {
    process_info: {
      shell_pid: 100,
      foreground_processes: [
        { pid: 100, name: "zsh" },
        { pid: 101, name: "pnpm" },
        { pid: 102, name: "node" },
        { pid: 103, name: "claude" },
        { pid: 1, name: "launchd" },
      ],
    },
  };
  assert.deepEqual(paneServiceProcesses(info).map((item) => item.pid), [101, 102]);
  assert.deepEqual(paneServiceProcesses({}), []);
});
