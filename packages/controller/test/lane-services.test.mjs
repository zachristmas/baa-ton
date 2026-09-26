import assert from "node:assert/strict";
import test from "node:test";
import {
  describeIdleServices,
  idleLaneServices,
  isHarnessCommand,
  laneBackgroundWork,
  laneFinished,
  paneServiceProcesses,
  parseProcessIdentity,
  parseProcessTable,
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

test("background work is a non-helper descendant of the pane's agent", () => {
  const table = parseProcessTable([
    "  100     1 -zsh",
    "  200   100 claude --session-id x",
    "  210   200 node /opt/tools/mcp-server.mjs",
    "  220   200 caffeinate -i",
    "  230   200 /bin/zsh -c node --test packages/a.test.mjs",
    "  231   230 node --test packages/a.test.mjs",
    "  300     1 node --test elsewhere.test.mjs",
  ].join("\n"));
  assert.deepEqual(table[1], { pid: 200, ppid: 100, command: "claude --session-id x" });
  assert.equal(laneBackgroundWork(100, table), "node --test packages/a.test.mjs", "shell wrappers are skipped, their children counted");
  assert.equal(laneBackgroundWork(100, table.filter((item) => item.pid < 230)), undefined, "helpers only");
  assert.equal(laneBackgroundWork(999, table), undefined, "another pane's shell");
});

test("a done lane whose only descendants are its language server and MCP bridge has no background work (a live stall)", () => {
  // A lane's process tree, as it stood for hours after the lane finished:
  // an LSP proxy started through npx, the TypeScript language server, its
  // tsserver processes and the tsserver's typings installer, plus the
  // MCP bridge. All of that is the agent's tooling, not its work, so the
  // lane must count as idle and get its receipt asked for.
  const table = parseProcessTable([
    " 6936  6048 -zsh",
    " 9778  6936 claude --model m --effort high --settings /work/lane/.claude/settings.json --mcp-config /work/lane/mcp.json",
    " 9923  9778 node /home/u/.pi/agent/extensions/herdr-orchestrator/mcp-server.mjs",
    " 9924  9923 node /home/u/.pi/agent/extensions/herdr-orchestrator/mcp-server.mjs",
    "83238  9778 npx -y stay-fresh-lsp-proxy typescript-language-server --stdio",
    "83239 83238 npm exec stay-fresh-lsp-proxy typescript-language-server --stdio",
    "85423 83239 node /home/u/.npm/_npx/abc/node_modules/.bin/stay-fresh-lsp-proxy typescript-language-server --stdio",
    "85449 85423 typescript-language-server --stdio",
    "85454 85449 node /home/u/.volta/tools/image/packages/typescript-language-server/bin/typescript-language-server --stdio",
    "85521 85454 /home/u/.volta/tools/image/node/20.10.0/bin/node /work/lane/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/tsserver.js --serverMode partialSemantic",
    "85522 85454 /home/u/.volta/tools/image/node/20.10.0/bin/node /work/lane/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/tsserver.js --useInferredProjectPerProjectRoot",
    "85536 85522 /home/u/.volta/tools/image/node/20.10.0/bin/node /work/lane/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/typingsInstaller.js --globalTypingsCacheLocation /home/u/Library/Caches/typescript/5.9",
  ].join("\n"));
  assert.equal(laneBackgroundWork(6936, table), undefined);
  // A real test run under the same agent still counts, even next to them.
  const busy = [...table, { pid: 90000, ppid: 9778, command: "/bin/zsh -c pnpm turbo run test" }, { pid: 90001, ppid: 90000, command: "node /usr/local/bin/pnpm turbo run test" }];
  assert.equal(laneBackgroundWork(6936, busy), "node /usr/local/bin/pnpm turbo run test");
  // Anything a helper starts belongs to the helper, whatever its name.
  const helperChild = [...table, { pid: 90002, ppid: 85449, command: "node /work/lane/some-plugin-worker.js" }];
  assert.equal(laneBackgroundWork(6936, helperChild), undefined);
});
