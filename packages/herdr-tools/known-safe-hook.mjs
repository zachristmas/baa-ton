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
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyCommand } from "./known-safe.mjs";
import { bridgeClient, DEFAULT_WAIT_MS, routePermission } from "./permission-route.mjs";

export function decide(input, options = {}) {
  if (input?.hook_event_name && input.hook_event_name !== "PermissionRequest") return undefined;
  if (input?.tool_name !== "Bash") return undefined;
  const command = input.tool_input?.command;
  const result = classifyCommand(command, { ...options, cwd: options.cwd ?? input.cwd });
  if (result.decision !== "allow") return { result };
  return { result, output: output({ behavior: "allow" }) };
}

const INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

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
  const client = bridgeClient({
    bridge,
    env: { ...process.env, HERDR_ENV: "1", BAA_STARTUP_INTENT: intent, BAA_TON_NO_RUNTIME_RECORDS: "1" },
  });
  try {
    const routed = await routePermission({
      call: client.call,
      toolName: input.tool_name,
      input: isRecord(input.tool_input) ? input.tool_input : {},
      waitMs: Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : DEFAULT_WAIT_MS,
      ...(Number(argument("--poll-ms")) > 0 ? { pollMs: Number(argument("--poll-ms")) } : {}),
    });
    audit({
      sessionId: input.session_id,
      decision: routed.decision?.behavior ?? "prompt",
      requestId: routed.request?.id,
      answeredBy: routed.request?.answeredBy,
      ...(routed.reason ? { reason: routed.reason } : {}),
      tool: input.tool_name,
      ...(input.tool_name === "Bash" ? { command: input.tool_input?.command } : {}),
    });
    if (routed.decision) process.stdout.write(JSON.stringify(output(routed.decision)));
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
