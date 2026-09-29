import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeRootLaunchCommand, claudeRootMcpConfig, claudeRootMcpConfigPath, removeFromMcpJson } from "../root-setup.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "root-setup.mjs");
const identity = (configDir) => ({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1", HERDR_PLUGIN_CONFIG_DIR: configDir });

test("a Claude root's MCP servers come from a per-pane file passed with --mcp-config, not project scope", () => {
  const id = identity("/cfg");
  assert.equal(claudeRootMcpConfigPath(id), "/cfg/root-mcp/w1-w1_p1.json");
  assert.deepEqual(Object.keys(claudeRootMcpConfig(id).mcpServers), ["herdr-orchestrator"]);
  assert.equal(claudeRootMcpConfig(id).mcpServers["herdr-orchestrator"].env.HERDR_PANE_ID, "w1:p1");
  const command = claudeRootLaunchCommand(id);
  assert.match(command, /^claude --mcp-config '\/cfg\/root-mcp\/w1-w1_p1\.json' --disallowedTools Artifact,ArtifactComments,ArtifactData$/);
  assert.doesNotMatch(command, /strict-mcp-config/, "a root may need claude.ai connectors");
});

test("root-setup for Claude prints the file launch path and never the project-scope `claude mcp add`", async () => {
  const dir = await mkdtemp(join(tmpdir(), "root-setup-"));
  try {
    const env = { ...process.env, HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1", HERDR_PLUGIN_CONFIG_DIR: join(dir, "cfg") };
    const printed = spawnSync(process.execPath, [script, "--harness", "claude"], { cwd: dir, env, encoding: "utf8" });
    assert.equal(printed.status, 0, printed.stderr);
    assert.doesNotMatch(printed.stdout, /claude mcp add/);
    assert.match(printed.stdout, /claude --mcp-config /);
    const written = spawnSync(process.execPath, [script, "--harness", "claude", "--write"], { cwd: dir, env, encoding: "utf8" });
    assert.equal(written.status, 0, written.stderr);
    const file = JSON.parse(await readFile(join(dir, "cfg", "root-mcp", "w1-w1_p1.json"), "utf8"));
    assert.ok(file.mcpServers["herdr-orchestrator"]);
    await assert.rejects(readFile(join(dir, ".mcp.json"), "utf8"), /ENOENT/, "no project-scope .mcp.json is written");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("removing the project-scope entries needs --verified-live and the new launch file, and removes only the two servers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "root-setup-"));
  try {
    const cfg = join(dir, "cfg");
    const env = { ...process.env, HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1", HERDR_PLUGIN_CONFIG_DIR: cfg, PATH: dir };
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { "herdr-orchestrator": { command: "node" }, playwright: { command: "npx" }, other: { command: "x" } } }));
    const run = (...extra) => spawnSync(process.execPath, [script, "--harness", "claude", "--remove-project-scope", ...extra], { cwd: dir, env, encoding: "utf8" });
    assert.notEqual(run().status, 0, "refuses without --verified-live");
    assert.notEqual(run("--verified-live").status, 0, "refuses without the new launch file");
    await mkdir(join(cfg, "root-mcp"), { recursive: true });
    await writeFile(claudeRootMcpConfigPath(identity(cfg)), "{}");
    const done = run("--verified-live");
    assert.equal(done.status, 0, done.stderr);
    const after = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(after.mcpServers), ["other"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("removeFromMcpJson reports what it removed", () => {
  const config = { mcpServers: { playwright: {}, keep: {} } };
  assert.deepEqual(removeFromMcpJson(config), ["playwright"]);
  assert.deepEqual(Object.keys(config.mcpServers), ["keep"]);
  assert.deepEqual(removeFromMcpJson({}), []);
});

import { EXIT_COMMANDS, piExtensionInstalled, agentArgv, agentCwd, bridgeAttached, carriedClaudeFlags, relaunchCommand, runRelaunch } from "../root-relaunch.mjs";

const info = (...cmdlines) => ({ result: { process_info: { foreground_processes: cmdlines.map((cmdline, index) => ({ pid: 100 + index, cmdline, argv: cmdline.split(" ") })) } } });

test("the bridge counts as attached only when its server runs in the pane", () => {
  assert.equal(bridgeAttached(info("claude --x", "node /x/herdr-tools/mcp-server.mjs")), true);
  assert.equal(bridgeAttached(info("claude --x", "node playwright-mcp")), false);
  assert.equal(bridgeAttached({}), false);
});

test("a Claude relaunch resumes the same session with the bridge config and keeps permission flags only", () => {
  const argv = ["claude", "--disallowedTools", "Artifact", "--dangerously-skip-permissions", "--model", "opus", "--resume", "old"];
  assert.deepEqual(carriedClaudeFlags(argv), ["--dangerously-skip-permissions", "--model", "opus"]);
  assert.deepEqual(agentArgv(info("claude a"), 100), ["claude", "a"]);
  assert.equal(agentCwd({ result: { process_info: { foreground_processes: [{ pid: 7, cwd: "/agent/here" }] } } }, 7), "/agent/here");
  const { command } = relaunchCommand({ harness: "claude", mcpConfigPath: "/cfg/w1.json", disallowedTools: "Artifact", session: { kind: "id", value: "s-1" }, carriedFlags: carriedClaudeFlags(argv), cwd: "/proj dir" });
  assert.match(command, /^cd '\/proj dir' && claude --mcp-config '\/cfg\/w1\.json' --disallowedTools Artifact '--dangerously-skip-permissions' '--model' 'opus' --resume 's-1' 'Baa-ton relaunched/);
  assert.doesNotMatch(command, /old/);
});

test("relaunch refuses rather than guess a session or a harness", () => {
  assert.match(relaunchCommand({ harness: "claude", mcpConfigPath: "/c", disallowedTools: "A", cwd: "/p" }).error, /no session/);
  assert.match(relaunchCommand({ harness: "codex", cwd: "/p" }).error, /no session/);
  assert.match(relaunchCommand({ harness: "pi", session: { value: "x" }, cwd: "/p" }).error, /installed extension/);
  assert.match(relaunchCommand({ harness: "gemini", session: { value: "x" }, cwd: "/p" }).error, /no unattended relaunch/);
  assert.match(relaunchCommand({ harness: "codex", session: { value: "abc" }, cwd: "/p" }).command, /^cd '\/p' && codex resume 'abc' 'Baa-ton relaunched/);
  assert.match(relaunchCommand({ harness: "opencode", session: { value: "abc" }, cwd: "/p" }).command, /opencode --session 'abc' --prompt /);
});

test("the worker types the command only after the agent and its bridge are gone", async () => {
  const events = [];
  let polls = 0;
  const result = await runRelaunch({
    paneId: "w1:p1", agentPid: 42, command: "claude again",
    kill: (pid, signal) => events.push(`kill ${pid} ${signal}`),
    sendKeys: (pane, ...keys) => events.push(`keys ${pane} ${keys}`),
    exitCommand: null,
    isAlive: () => ++polls < 3,
    processInfo: () => (polls < 5 ? info("node mcp-server.mjs") : info()),
    runInPane: (pane, text) => events.push(`run ${pane} ${text}`),
    sleep: async () => { polls += 1; }, pollMs: 0,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(events, ["kill 42 SIGTERM", "run w1:p1 claude again"]);
});

test("the worker asks for a graceful exit first and skips SIGTERM when the agent leaves", async () => {
  const events = [];
  let gone = false;
  const result = await runRelaunch({
    paneId: "w1:p1", agentPid: 42, command: "claude again",
    sendKeys: (pane, ...keys) => events.push(`keys ${keys}`),
    kill: () => events.push("kill"),
    isAlive: () => !gone,
    processInfo: () => info(),
    runInPane: (pane, text) => { events.push(`run ${text}`); if (text === "/exit") gone = true; },
    sleep: async () => {}, pollMs: 0,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(events, ["keys esc", "run /exit", "run claude again"]);
});

test("the worker falls back to SIGTERM when the graceful exit is ignored", async () => {
  const events = [];
  let gone = false;
  const result = await runRelaunch({
    paneId: "w1:p1", agentPid: 42, command: "claude again",
    sendKeys: () => events.push("esc"),
    kill: (pid, signal) => { events.push(signal); gone = true; },
    isAlive: () => !gone,
    processInfo: () => info(),
    runInPane: (pane, text) => events.push(text),
    sleep: async () => {}, pollMs: 0, graceMs: -1,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(events, ["esc", "/exit", "SIGTERM", "claude again"]);
});

test("the worker types nothing when the agent will not exit", async () => {
  const events = [];
  const result = await runRelaunch({
    paneId: "w1:p1", agentPid: 42, command: "claude again", kill: () => {}, isAlive: () => true, sendKeys: () => {}, exitCommand: null,
    processInfo: () => info(), runInPane: (pane, text) => events.push(text), sleep: async () => {}, timeoutMs: -1, pollMs: 0,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /still running/);
  assert.deepEqual(events, []);
});

test("--check exits 3 with no herdr on the pane and --relaunch off a Herdr pane errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "root-setup-"));
  try {
    const env = { ...process.env, HERDR_ENV: "", HERDR_PANE_ID: "", HERDR_WORKSPACE_ID: "" };
    for (const flag of ["--check", "--relaunch"]) {
      const run = spawnSync(process.execPath, [script, "--harness", "claude", flag], { cwd: dir, env, encoding: "utf8" });
      assert.equal(run.status, 2, `${flag}: ${run.stderr}`);
      assert.match(run.stderr, /HERDR_ENV=1 pane/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("exit commands are per harness, Pi's is /quit, and Pi counts as attached only with its extension", () => {
  assert.equal(EXIT_COMMANDS.pi, "/quit");
  assert.equal(EXIT_COMMANDS.claude, "/exit");
  assert.equal(piExtensionInstalled("/home/x", (path) => path === "/home/x/.pi/agent/extensions/herdr-orchestrator"), true);
  assert.equal(piExtensionInstalled("/home/x", () => false), false);
});

test("without a pid the worker waits for the agent to leave Herdr and refuses to type if it never does", async () => {
  const events = [];
  const result = await runRelaunch({
    paneId: "w1:p1", harness: "pi", command: "again", isAlive: () => true, sendKeys: () => events.push("esc"),
    runInPane: (pane, text) => events.push(text), processInfo: () => info(), sleep: async () => {}, pollMs: 0, graceMs: -1,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no known pid/);
  assert.deepEqual(events, ["esc", "/quit"]);
});

import { sessionFromExit, SESSION_PLACEHOLDER } from "../root-relaunch.mjs";

test("Codex's session comes from its exit hint, taking the last one in the pane", () => {
  const text = "codex resume 01a0ee14-d212-7ab2-8a41-c429f041baed\nlater\nTo continue this session, run:\n  codex resume 01A0EE99-0000-7000-8000-000000000001\n";
  assert.equal(sessionFromExit("codex", text), "01A0EE99-0000-7000-8000-000000000001");
  assert.equal(sessionFromExit("codex", "nothing here"), undefined);
  assert.equal(sessionFromExit("claude", text), undefined);
});

test("a Codex relaunch with no session from Herdr defers it to the exit hint, and the worker fills it in", async () => {
  const planned = relaunchCommand({ harness: "codex", cwd: "/p", sessionFromExitOutput: true });
  assert.match(planned.command, new RegExp(`codex resume '${SESSION_PLACEHOLDER.replace(/[{}]/g, "\\$&")}'`));
  const typed = [];
  let gone = false;
  const ok = await runRelaunch({
    paneId: "w1:p1", harness: "codex", command: planned.command, isAlive: () => !gone, sendKeys: () => {},
    runInPane: (pane, text) => { if (text === "/exit") gone = true; else typed.push(text); },
    processInfo: () => info(), sleep: async () => {}, pollMs: 0,
    paneText: () => "To continue this session, run:\n  codex resume 01a0ee14-d212-7ab2-8a41-c429f041baed\n",
  });
  assert.deepEqual(ok, { ok: true });
  assert.match(typed[0], /codex resume '01a0ee14-d212-7ab2-8a41-c429f041baed'/);
  gone = false;
  const missing = await runRelaunch({
    paneId: "w1:p1", harness: "codex", command: planned.command, isAlive: () => !gone, sendKeys: () => {},
    runInPane: (pane, text) => { if (text === "/exit") gone = true; else typed.push("BAD"); },
    processInfo: () => info(), sleep: async () => {}, pollMs: 0, paneText: () => "no hint",
  });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /no resume hint/);
  assert.equal(typed.includes("BAD"), false);
});
