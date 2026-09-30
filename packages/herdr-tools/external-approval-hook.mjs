import { containsGhPrMutation, consumeExternalApproval, issueExternalApproval, parseApprovedGhOperation } from "./external-approval.mjs";

/** The before_tool_call approval path. Dependencies keep UI, Git and execution out of this module. */
export async function approveExternalGhCommand({ command, enabled, caller, hasUI, sessionFile, resolveBinding, confirm, now }) {
  if (!enabled || caller !== "root" || !hasUI || !sessionFile || typeof confirm !== "function") return false;
  if (!containsGhPrMutation(command)) return false;
  const operation = parseApprovedGhOperation(command);
  if (!operation || command !== operation.argv.join(" ")) return false;
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
