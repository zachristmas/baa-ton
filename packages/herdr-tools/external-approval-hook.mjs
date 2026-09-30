import { containsGhPrMutation, containsGitPush, containsUnsafeShellExecution, consumeExternalApproval, issueExternalApproval, parseApprovedExternalOperation } from "./external-approval.mjs";

/** The Pi tool_call pre-execution approval path. Dependencies keep UI, Git and execution out of this module. */
export async function approveExternalGhCommand({ command, enabled, caller, hasUI, sessionFile, resolveBinding, confirm, now }) {
  if (!enabled || caller !== "root" || !hasUI || !sessionFile || typeof confirm !== "function") return false;
  if (!containsGhPrMutation(command) && !containsGitPush(command) && !containsUnsafeShellExecution(command)) return false;
  if (containsUnsafeShellExecution(command)) return false;
  const operation = parseApprovedExternalOperation(command);
  if (!operation || !(operation.operation === "push" || /^\s*gh\s+pr\s+(?:create|merge)(?:\s|$)/.test(command))) return false;
  try {
    const binding = await resolveBinding(operation);
    if (!binding || binding.caller !== "root" || (operation.operation === "push" ? binding.remoteName !== operation.remoteName || binding.branch !== operation.branch || binding.destinationRef !== operation.destinationRef : binding.targetRepo?.toLowerCase() !== operation.repo.toLowerCase())) return false;
    const approved = await confirm(operation, binding);
    if (!approved) return false;
    const current = await resolveBinding(operation);
    if (!current || JSON.stringify(current) !== JSON.stringify(binding)) return false;
    const token = issueExternalApproval(command, binding, now === undefined ? undefined : { now });
    return Boolean(token && consumeExternalApproval(token, command, current, now === undefined ? undefined : { now }));
  } catch {
    return false;
  }
}

export const externalApprovalChecked = new WeakSet();
export const externalApprovalGranted = new WeakSet();

/** Register the production Pi tool_call pre-execution gate. Dependencies may be resolved per Pi context. */
export function registerExternalApprovalBeforeToolCall(pi, dependencies) {
  pi.on("tool_call", async (event, ctx) => {
    if (event?.toolName !== "bash" || typeof event.input?.command !== "string") return;
    if (!containsGhPrMutation(event.input.command) && !containsGitPush(event.input.command) && !containsUnsafeShellExecution(event.input.command)) return;
    externalApprovalChecked.add(event);
    const resolved = typeof dependencies === "function" ? await dependencies(event, ctx) : dependencies;
    const approved = await approveExternalGhCommand({ ...resolved, command: event.input.command });
    if (!approved) return { block: true, reason: "External command was not explicitly approved." };
    externalApprovalGranted.add(event);
  });
}
