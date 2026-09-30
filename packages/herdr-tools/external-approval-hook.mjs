import { containsGhPrMutation, containsUnsafeShellExecution, consumeExternalApproval, issueExternalApproval, parseApprovedGhOperation } from "./external-approval.mjs";

/** The before_tool_call approval path. Dependencies keep UI, Git and execution out of this module. */
export async function approveExternalGhCommand({ command, enabled, caller, hasUI, sessionFile, resolveBinding, confirm, now }) {
  if (!enabled || caller !== "root" || !hasUI || !sessionFile || typeof confirm !== "function") return false;
  if (!containsGhPrMutation(command) && !containsUnsafeShellExecution(command)) return false;
  if (containsUnsafeShellExecution(command)) return false;
  const operation = parseApprovedGhOperation(command);
  if (!operation || !/^\s*gh\s+pr\s+(?:create|merge)(?:\s|$)/.test(command)) return false;
  try {
    const binding = await resolveBinding(operation);
    if (!binding || binding.caller !== "root" || binding.targetRepo?.toLowerCase() !== operation.repo.toLowerCase()) return false;
    const approved = await confirm(operation, binding);
    const token = approved ? issueExternalApproval(command, binding, now === undefined ? undefined : { now }) : undefined;
    return Boolean(token && consumeExternalApproval(token, command, binding, now === undefined ? undefined : { now }));
  } catch {
    return false;
  }
}

/** Register the approval gate as a before-tool-call listener; executor is injected for hermetic integration tests. */
export function registerExternalApprovalBeforeToolCall(pi, dependencies) {
  pi.on("tool_call", async (event) => {
    if (event?.toolName !== "bash" || typeof event.input?.command !== "string") return;
    const approved = await approveExternalGhCommand({ ...dependencies, command: event.input.command });
    if (!approved) return { block: true, reason: "External PR command was not explicitly approved." };
    return undefined;
  });
}
