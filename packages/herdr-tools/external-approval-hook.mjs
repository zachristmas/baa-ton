import { containsGhPrMutation, containsGitPush, containsUnsafeShellExecution, consumeExternalApproval, issueExternalApproval, parseApprovedExternalOperation } from "./external-approval.mjs";

/** The Pi tool_call pre-execution approval path. Dependencies keep UI, Git and execution out of this module. */
export async function approveExternalGhCommand({ command, enabled, caller, mode = "unknown", hasUI, confirmAvailable = false, sessionFile, resolveBinding, confirm, now, diagnostic }) {
  const record = (stage, denial = "none") => {
    try { diagnostic?.({ mode: typeof mode === "string" ? mode : "unknown", hasUI: Boolean(hasUI), confirmAvailable: Boolean(confirmAvailable), stage, denial }); } catch { /* diagnostics never affect authorization */ }
  };
  const deny = (category, stage = "deny") => { record(stage, category); return false; };
  if (!enabled) return deny("disabled");
  if (caller !== "root") return deny("non_root");
  if (!hasUI) return deny("no_ui");
  if (!sessionFile) return deny("no_session");
  if (typeof confirm !== "function" || !confirmAvailable) return deny("no_confirm");
  if (containsUnsafeShellExecution(command)) return deny("unsafe_command", "parse");
  const operation = parseApprovedExternalOperation(command);
  if (!operation || !(operation.operation === "push" || /^\s*gh\s+pr\s+(?:create|merge)(?:\s|$)/.test(command))) return deny("unsupported_command", "parse");
  record("parse");
  try {
    record("resolve-before");
    const binding = await resolveBinding(operation);
    if (!binding || binding.caller !== "root" || (operation.operation === "push" ? binding.remoteName !== operation.remoteName || binding.branch !== operation.branch || binding.destinationRef !== operation.destinationRef : binding.targetRepo?.toLowerCase() !== operation.repo.toLowerCase())) return deny("binding_mismatch", "deny");
    record("confirm");
    const approved = await confirm(operation, binding);
    if (!approved) return deny("declined");
    record("resolve-after");
    const current = await resolveBinding(operation);
    if (!current || JSON.stringify(current) !== JSON.stringify(binding)) return deny("binding_changed");
    const token = issueExternalApproval(command, binding, now === undefined ? undefined : { now });
    if (!token || !consumeExternalApproval(token, command, current, now === undefined ? undefined : { now })) return deny("token_rejected");
    record("allow");
    return true;
  } catch {
    return deny("resolver_error");
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
    const approved = await approveExternalGhCommand({ ...resolved, mode: ctx?.mode ?? resolved?.mode, hasUI: ctx?.hasUI ?? resolved?.hasUI, confirmAvailable: resolved?.confirmAvailable ?? typeof resolved?.confirm === "function", command: event.input.command });
    if (!approved) return { block: true, reason: "External command was not explicitly approved." };
    externalApprovalGranted.add(event);
  });
}
