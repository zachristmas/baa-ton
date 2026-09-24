#!/usr/bin/env node
/**
 * PermissionRequest hook for dispatched Claude lanes.
 *
 * Claude Code runs this when it is about to show the lane a permission
 * prompt, including prompts forced by an `ask` rule in the operator's own
 * settings. A PreToolUse "allow" cannot answer those (ask rules are evaluated
 * after it); a PermissionRequest decision can. Deny rules still win.
 *
 * For a Bash command that known-safe.mjs accepts, the hook answers "allow" and
 * appends one audit line to the log named by --log. For anything else it
 * prints nothing, so the prompt stays up and reaches the root as before. It
 * never denies, and any failure falls through to the normal prompt.
 *
 * Usage: node known-safe-hook.mjs [--log <file>] [--options <json>]
 */
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyCommand } from "./known-safe.mjs";

export function decide(input, options = {}) {
  if (input?.hook_event_name && input.hook_event_name !== "PermissionRequest") return undefined;
  if (input?.tool_name !== "Bash") return undefined;
  const command = input.tool_input?.command;
  const result = classifyCommand(command, { ...options, cwd: options.cwd ?? input.cwd });
  if (result.decision !== "allow") return { result };
  return {
    result,
    output: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } },
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  let options = {};
  try {
    options = JSON.parse(argument("--options") ?? "{}");
  } catch {
    return;
  }
  const decision = decide(input, options);
  if (!decision?.output) return;
  const log = argument("--log");
  if (log) {
    try {
      appendFileSync(
        log,
        `${JSON.stringify({ at: new Date().toISOString(), sessionId: input.session_id, rules: decision.result.rules, command: input.tool_input.command })}\n`,
        { mode: 0o600 },
      );
    } catch {
      // The audit line is best effort; the approval stands.
    }
  }
  process.stdout.write(JSON.stringify(decision.output));
}

function launchedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (launchedDirectly()) {
  try {
    main();
  } catch {
    // Fall through to the normal permission prompt.
  }
}
