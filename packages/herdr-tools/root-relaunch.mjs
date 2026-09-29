#!/usr/bin/env node
/**
 * Evaluate whether this pane's agent already carries the Baa-ton root bridge,
 * and if not, relaunch the agent in the same pane with it attached.
 *
 * A session cannot swap its own MCP servers, and it cannot restart itself from
 * inside its own process. A detached worker can: it ends the agent, waits for
 * the pane's shell to come back, then types the relaunch command. It never
 * types into a pane that still runs the agent.
 */
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE_NAME = "mcp-server.mjs";
const RESUME_PROMPT =
  "Baa-ton relaunched this root with its tools attached. Call herdr_bootstrap_root, verify the pane identity, then continue the task you were on without waiting for input.";
// Flags a relaunch keeps from the running agent so it does not lose its
// permission mode or model. Everything else is dropped on purpose.
const CARRIED_CLAUDE_FLAGS = new Map([
  ["--dangerously-skip-permissions", 0],
  ["--permission-mode", 1],
  ["--model", 1],
  ["--effort", 1],
]);

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function herdrBinary(env = process.env) {
  return env.HERDR_BIN_PATH || "herdr";
}

export function paneProcesses(processInfo) {
  return processInfo?.result?.process_info?.foreground_processes ?? [];
}

/** True when a foreground process in the pane is the herdr-orchestrator bridge. */
export function bridgeAttached(processInfo) {
  return paneProcesses(processInfo).some((process) => String(process.cmdline ?? "").includes(BRIDGE_NAME));
}

export function carriedClaudeFlags(argv = []) {
  const kept = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arity = CARRIED_CLAUDE_FLAGS.get(argv[index]);
    if (arity === undefined) continue;
    kept.push(argv[index]);
    if (arity === 1 && index + 1 < argv.length) kept.push(argv[(index += 1)]);
  }
  return kept;
}

// Exit commands were confirmed live for Claude (/exit) and Pi (/quit; /exit does nothing there).
// Codex and OpenCode are assumed to accept /exit and are untested: Codex would not start here.
export const EXIT_COMMANDS = { claude: "/exit", pi: "/quit", codex: "/exit", opencode: "/exit" };

/**
 * The command that brings the same conversation back with the bridge loaded.
 * `session` is what Herdr reports for the pane's agent ({ kind, value }); it is the
 * only source trusted for Codex and OpenCode, because resuming with `--last` or
 * `--continue` can open another session in a shared folder. Pi needs no relaunch:
 * its bridge is the installed extension.
 */
export function relaunchCommand({ harness, mcpConfigPath, disallowedTools, session, carriedFlags = [], cwd, prompt = RESUME_PROMPT, sessionFromExitOutput = false }) {
  if (harness === "pi") return { error: "Pi loads the bridge as an installed extension; a relaunch does not attach it." };
  if (!EXIT_COMMANDS[harness]) return { error: `${harness} has no unattended relaunch.` };
  if (sessionFromExitOutput && RESUME_HINTS[harness]) session = { value: SESSION_PLACEHOLDER };
  if (!session?.value) return { error: `Herdr reports no session for this ${harness} agent; resuming without one could open the wrong conversation.` };
  const q = shellQuote;
  const resume = {
    claude: () => ["claude", "--mcp-config", q(mcpConfigPath), "--disallowedTools", disallowedTools, ...carriedFlags.map(q), "--resume", q(session.value), q(prompt)],
    codex: () => ["codex", "resume", q(session.value), q(prompt)],
    opencode: () => ["opencode", "--session", q(session.value), "--prompt", q(prompt)],
  }[harness]();
  return { command: `cd ${q(cwd)} && ${resume.join(" ")}` };
}

export const SESSION_PLACEHOLDER = "{{SESSION}}";
// What each harness prints when it exits. Codex prints it and Herdr reports no session for it, so this is its source.
const RESUME_HINTS = { codex: /codex resume ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi };

/** The last resume hint in the pane text, so an earlier session's hint in scrollback loses. */
export function sessionFromExit(harness, text) {
  const pattern = RESUME_HINTS[harness];
  if (!pattern) return undefined;
  const found = [...String(text).matchAll(pattern)];
  return found.length ? found[found.length - 1][1] : undefined;
}

/** Herdr's record of the agent in a pane: kind, session and working folder. */
export function paneAgent(paneId, { env = process.env, exec = execFileSync } = {}) {
  const list = JSON.parse(exec(herdrBinary(env), ["agent", "list"], { encoding: "utf8" }));
  return (list?.result?.agents ?? []).find((agent) => agent.pane_id === paneId);
}

/** Pi's bridge is an extension it loads at startup; installed is the closest check without a process. */
export function piExtensionInstalled(home = homedir(), exists = existsSync) {
  return exists(join(home, ".pi", "agent", "extensions", "herdr-orchestrator"));
}

export function paneProcessInfo(paneId, { env = process.env, exec = execFileSync } = {}) {
  return JSON.parse(exec(herdrBinary(env), ["pane", "process-info", "--pane", paneId], { encoding: "utf8" }));
}

export function agentArgv(processInfo, pid) {
  return paneProcesses(processInfo).find((process) => process.pid === pid)?.argv ?? [];
}

/** The agent's own working folder: sessions are keyed by it, so a resume must start there. */
export function agentCwd(processInfo, pid) {
  return paneProcesses(processInfo).find((process) => process.pid === pid)?.cwd;
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

/**
 * Runs inside the detached worker. Returns { ok, reason }. Aborts, typing
 * nothing, if the agent is still running after the wait.
 */
export async function runRelaunch({
  paneId,
  agentPid,
  harness = "claude",
  command,
  processInfo = (id) => paneProcessInfo(id),
  runInPane = (id, text) => execFileSync(herdrBinary(), ["pane", "run", id, text], { encoding: "utf8" }),
  sendKeys = (id, ...keys) => execFileSync(herdrBinary(), ["pane", "send-keys", id, ...keys], { encoding: "utf8" }),
  paneText = (id) => execFileSync(herdrBinary(), ["pane", "read", id, "--source", "recent-unwrapped"], { encoding: "utf8" }),
  exitCommand = EXIT_COMMANDS[harness],
  graceMs = 5_000,
  // With a pid, that process; without one (Herdr does not expose it), the agent leaving Herdr's list.
  isAlive = agentPid ? alive : () => Boolean(paneAgent(paneId)),
  kill = (pid, signal) => process.kill(pid, signal),
  sleep = sleepFor,
  timeoutMs = 30_000,
  pollMs = 250,
  log = () => {},
}) {
  const deadline = Date.now() + timeoutMs;
  const waitForExit = async (until) => {
    while (isAlive(agentPid) && Date.now() <= until) await sleep(pollMs);
    return !isAlive(agentPid);
  };
  // Graceful first: Escape drops any half-typed input or interrupts a running turn, then the exit command.
  // A dialog or a busy UI can swallow the keys, so SIGTERM follows if the agent is still there.
  let exited = false;
  if (exitCommand) {
    log(`asking the agent in ${paneId} to exit (${exitCommand})`);
    try {
      sendKeys(paneId, "esc");
      await sleep(pollMs);
      runInPane(paneId, exitCommand);
      exited = await waitForExit(Date.now() + graceMs);
    } catch (error) {
      log(`graceful exit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!exited && !agentPid) return { ok: false, reason: `the ${harness} agent in ${paneId} ignored ${exitCommand} and has no known pid to signal; nothing was typed` };
  if (!exited) {
    log(`sending SIGTERM to pid ${agentPid}`);
    try {
      kill(agentPid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") return { ok: false, reason: `could not signal pid ${agentPid}: ${error.message}` };
    }
    if (!(await waitForExit(deadline))) return { ok: false, reason: `pid ${agentPid} still running after ${timeoutMs} ms; nothing was typed into ${paneId}` };
  }
  // The bridge is a child of the agent; wait until nothing of it is left in the pane's foreground.
  while (bridgeAttached(processInfo(paneId))) {
    if (Date.now() > deadline) return { ok: false, reason: `the bridge is still in ${paneId}; nothing was typed` };
    await sleep(pollMs);
  }
  await sleep(pollMs);
  if (command.includes(SESSION_PLACEHOLDER)) {
    const session = sessionFromExit(harness, paneText(paneId));
    if (!session) return { ok: false, reason: `${harness} printed no resume hint on exit; nothing was typed into ${paneId}` };
    command = command.replaceAll(SESSION_PLACEHOLDER, session);
    log(`resuming ${harness} session ${session}`);
  }
  runInPane(paneId, command);
  log(`typed relaunch command into ${paneId}`);
  return { ok: true };
}

/** Detached so it survives the agent it is about to end. */
export function startDetachedRelaunch({ paneId, agentPid, harness, command, logPath, env = process.env }) {
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const payload = Buffer.from(JSON.stringify({ paneId, agentPid, harness, command, logPath })).toString("base64");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker", payload], { detached: true, stdio: "ignore", env });
  child.unref();
  return child.pid;
}

async function workerMain(payload) {
  const { paneId, agentPid, harness, command, logPath } = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  const log = (line) => appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  try {
    const result = await runRelaunch({ paneId, agentPid, harness, command, log });
    log(result.ok ? "done" : `aborted: ${result.reason}`);
  } catch (error) {
    log(`failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export function relaunchLogPath(configDir) {
  return join(configDir, "root-relaunch.log");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === "--worker") await workerMain(process.argv[3]);
