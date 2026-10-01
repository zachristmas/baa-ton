import { containsGhPrMutation, containsGitPush, containsUnsafeShellExecution, consumeExternalApproval, issueExternalApproval, parseApprovedExternalOperation } from "./external-approval.mjs";

/** The Pi tool_call pre-execution approval path. Dependencies keep UI, Git and execution out of this module. */
const stages = new Set(["parse", "resolve-before", "confirm", "resolve-after", "allow", "deny"]);
const denials = new Set(["none", "disabled", "non_root", "no_ui", "no_session", "no_confirm", "unsafe_command", "unsupported_command", "binding_mismatch", "declined", "binding_changed", "token_rejected", "resolver_error"]);
const resolverPhases = new Set(["local_identity", "repo_remote", "pr_arguments", "pr_metadata", "head_remote", "head_oid", "base_oid", "resolver"]);

export async function approveExternalGhCommand({ command, enabled, caller, mode = "unknown", hasUI, confirmAvailable = false, sessionFile, resolveBinding, confirm, now, diagnostic }) {
  const snapshot = (stage, denial = "none", failurePhase) => ({
    mode: typeof mode === "string" ? mode : "unknown",
    hasUI: Boolean(hasUI),
    confirmAvailable: Boolean(confirmAvailable),
    stage: stages.has(stage) ? stage : "deny",
    denial: denials.has(denial) ? denial : "resolver_error",
    ...(failurePhase ? { failurePhase: resolverPhases.has(failurePhase) ? failurePhase : "resolver" } : {}),
  });
  const record = (stage, denial = "none", failurePhase) => {
    const value = snapshot(stage, denial, failurePhase);
    try { diagnostic?.(value); } catch { /* diagnostics never affect authorization */ }
    return value;
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
  } catch (error) {
    record("deny", "resolver_error", error?.resolverPhase);
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
    let finalSnapshot;
    const approved = await approveExternalGhCommand({ ...resolved, mode: ctx?.mode ?? resolved?.mode, hasUI: ctx?.hasUI ?? resolved?.hasUI, confirmAvailable: resolved?.confirmAvailable ?? typeof resolved?.confirm === "function", command: event.input.command, diagnostic: (value) => { finalSnapshot = value; resolved?.diagnostic?.(value); } });
    if (!approved) {
      const state = finalSnapshot;
      return { block: true, reason: `External command was not explicitly approved (mode=${state.mode}, hasUI=${state.hasUI}, confirmAvailable=${state.confirmAvailable}, stage=${state.stage}, denial=${state.denial}${state.failurePhase ? `, resolverPhase=${state.failurePhase}` : ""}).` };
    }
    externalApprovalGranted.add(event);
  });
}
