#!/usr/bin/env node
/**
 * PermissionRequest hook for dispatched Claude lanes.
 *
 * Claude Code runs this when it is about to show the lane a permission
 * prompt, including prompts forced by an `ask` rule in the operator's own
 * settings. A PreToolUse "allow" cannot answer those (ask rules are evaluated
 * after it); a PermissionRequest decision can. Deny rules still win.
 *
 * 1. For a Bash command that known-safe.mjs accepts, the hook answers
 *    "allow".
 * 2. Anything else, with --bridge and --intent, is routed to the root as a
 *    lane request (permission-route.mjs): policy answers it where it
 *    matches, otherwise the hook waits up to --wait-seconds for the root's
 *    grant (allow) or deny (deny, with the root's note).
 * 3. Otherwise, or on any failure, it prints nothing and Claude shows the
 *    normal prompt.
 * Every decision appends one audit line to the log named by --log.
 *
 * Usage: node known-safe-hook.mjs [--log <file>] [--options <json>]
 *          [--bridge <mcp-server.mjs> --intent <startup intent>] [--wait-seconds <n>] [--poll-ms <n>]
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyCommand, laneConfinedVerdict } from "./known-safe.mjs";
import { bridgeClient, DEFAULT_WAIT_MS, routePermission } from "./permission-route.mjs";

/** Permission modes in which only ask-rule segments can force a prompt. */
export const SCOPED_MODES = new Set(["bypassPermissions", "auto"]);

export function decide(input, options = {}) {
  if (input?.hook_event_name && input.hook_event_name !== "PermissionRequest") return undefined;
  if (input?.tool_name !== "Bash") return undefined;
  const command = input.tool_input?.command;
  const result = classifyCommand(command, { ...options, cwd: options.cwd ?? input.cwd });
  if (result.decision !== "allow") return { result };
  return { result, output: output({ behavior: "allow" }) };
}

const INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/**
 * Facts the classifier needs about the session's own worktree, read with
 * git only for git and gh commands: its current branch (the one it may push
 * and open PRs for), its origin repository, whether tracked files are clean,
 * and the state of any branch a `checkout -B` would reset.
 */
export function worktreeFacts(cwd, command, git = (args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] })) {
  if (!cwd || !/(^|[\s;&|(])(git|gh)\s/.test(String(command))) return {};
  const facts = {};
  const quiet = (args) => {
    try {
      return git(args).trim();
    } catch {
      return undefined;
    }
  };
  const branch = quiet(["branch", "--show-current"]);
  if (branch && !["main", "master"].includes(branch)) facts.ownBranch = branch;
  const url = quiet(["remote", "get-url", "origin"]);
  const repo = url && /[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)?.[1];
  if (repo) facts.mergeRepo = repo;
  const status = quiet(["status", "--porcelain", "--untracked-files=no"]);
  if (status !== undefined) facts.worktreeClean = status === "";
  const states = {};
  for (const match of String(command).matchAll(/checkout (?:-q )?-B (\S+) origin\/main/g)) {
    const name = match[1];
    if (quiet(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]) === undefined) states[name] = "missing";
    else {
      try {
        git(["merge-base", "--is-ancestor", `refs/heads/${name}`, "origin/main"]);
        states[name] = "merged";
      } catch {
        states[name] = "unmerged";
      }
    }
  }
  if (Object.keys(states).length) facts.branchStates = states;
  return facts;
}

/**
 * The Bash `ask` rules Claude Code applies in this session: the user's
 * settings and the project's (shared and local), from `cwd`.
 */
export function loadAskRules(cwd, files = [join(homedir(), ".claude", "settings.json"), ...(cwd ? [join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")] : [])]) {
  const rules = [];
  for (const file of files) {
    try {
      const ask = JSON.parse(readFileSync(file, "utf8"))?.permissions?.ask;
      if (Array.isArray(ask)) rules.push(...ask.filter((rule) => typeof rule === "string" && rule.startsWith("Bash(")));
    } catch {
      // A missing or unreadable settings file contributes no rules.
    }
  }
  return [...new Set(rules)];
}

/** The unattended default once nobody answered: allow inside the lane, deny outside. */
export function policyDefault(input, waitedSeconds) {
  const verdict = laneConfinedVerdict(input.tool_name, isRecord(input.tool_input) ? input.tool_input : {}, { cwd: input.cwd });
  if (verdict.allow) return { behavior: "allow" };
  return {
    behavior: "deny",
    message: `Denied by the unattended policy (no answer within ${waitedSeconds} s): ${verdict.reason}. Stay inside your worktree and scratch, or ask the root with herdr_request and continue with other work meanwhile.`,
  };
}

function argument(name) {
  const index = process.argv.lastIndexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

function output(decision) {
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}

function audit(entry) {
  const log = argument("--log");
  if (!log) return;
  try {
    appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    // The audit line is best effort; the decision stands.
  }
}

async function main() {
  let input;
  let options;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
    options = JSON.parse(argument("--options") ?? "{}");
  } catch {
    return;
  }
  if (input?.hook_event_name && input.hook_event_name !== "PermissionRequest") return;
  // Explicit options win over what the worktree says.
  if (input?.tool_name === "Bash") options = { ...worktreeFacts(input.cwd, input.tool_input?.command), ...options };
  // In bypassPermissions and auto mode, a command matching an ask rule is
  // what forces this prompt, so only its ask-rule segments must be
  // known-safe; the rest would run without a prompt in that mode (a command
  // with no ask-rule segment defers: the prompt has another cause). Other
  // modes classify the whole command.
  if (input?.tool_name === "Bash" && SCOPED_MODES.has(input.permission_mode) && options.scopeToAskRules !== false) {
    const askRules = options.askRules ?? loadAskRules(input.cwd);
    if (askRules.length) options = { ...options, askRules, scopeToAskRules: true };
  }
  const known = decide(input, options);
  if (known?.output) {
    audit({ sessionId: input.session_id, decision: "allow", rules: known.result.rules, command: input.tool_input.command });
    process.stdout.write(JSON.stringify(known.output));
    return;
  }
  const bridge = argument("--bridge");
  const intent = argument("--intent");
  if (!bridge || !intent || typeof input?.tool_name !== "string") return;
  // Tools that need the person's own answer are never routed.
  if (INTERACTIVE_TOOLS.has(input.tool_name)) return;
  const seconds = Number(argument("--wait-seconds"));
  const waitedSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_WAIT_MS / 1000;
  // A lane never sits on a pane prompt: with no answer (or no route), the
  // unattended policy decides.
  const fallBack = (reason) => {
    const decision = policyDefault(input, waitedSeconds);
    audit({ sessionId: input.session_id, decision: `policy-${decision.behavior}`, reason, tool: input.tool_name, ...(input.tool_name === "Bash" ? { command: input.tool_input?.command } : {}) });
    process.stdout.write(JSON.stringify(output(decision)));
  };
  let client;
  try {
    client = bridgeClient({
    bridge,
    env: { ...process.env, HERDR_ENV: "1", BAA_STARTUP_INTENT: intent, BAA_TON_NO_RUNTIME_RECORDS: "1" },
    });
  } catch (error) {
    return fallBack(`no route to the root: ${error?.message ?? error}`);
  }
  try {
    const routed = await routePermission({
      call: client.call,
      toolName: input.tool_name,
      input: isRecord(input.tool_input) ? input.tool_input : {},
      waitMs: waitedSeconds * 1000,
      ...(Number(argument("--poll-ms")) > 0 ? { pollMs: Number(argument("--poll-ms")) } : {}),
    });
    if (!routed.decision) return fallBack(routed.reason ?? "no answer");
    audit({
      sessionId: input.session_id,
      decision: routed.decision.behavior,
      requestId: routed.request?.id,
      answeredBy: routed.request?.answeredBy,
      ...(routed.reason ? { reason: routed.reason } : {}),
      tool: input.tool_name,
      ...(input.tool_name === "Bash" ? { command: input.tool_input?.command } : {}),
    });
    process.stdout.write(JSON.stringify(output(routed.decision)));
  } catch (error) {
    return fallBack(`routing failed: ${error?.message ?? error}`);
  } finally {
    client.close();
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function launchedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (launchedDirectly()) {
  // Fall through to the normal permission prompt on any failure.
  main()
    .catch(() => undefined)
    .finally(() => process.exit(0));
}
