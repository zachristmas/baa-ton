# Harness extension boundary

`dispatch-task.ts` owns shared task-workspace topology, effect intents, route-before-start ordering, all-lanes-before-assignment verification, and uncertain-effect fencing. It has no Pi SDK context or Pi command-line construction.

`harness-adapter.ts` defines the version-1 `HarnessLaunchAdapter` contract and registry. To add a harness, implement and register:

1. `preflight(profile)`: validate exact installed provider/model/thinking and the explicitly requested authentication policy. Never substitute a provider, model, or billing route.
2. `launchArguments(profile, source)`: harness-specific CLI/config arguments; no workspace creation or controller-state mutation.
3. `verifyStartup(nativeAgent, attestation)`: compare native identity and attestation and return a normalized `StartupProof`. Sessions may be native paths **or IDs**. Normalize harness tool aliases to the common protocol operations.
4. Optional `discoverCatalog(profile)`: return only live provider truth with the documented cache-key identity. If the harness exposes no authoritative discovery API at this boundary, omit the method and set `capabilities.supportsLiveCapabilityDiscovery: false` with the reason; never substitute a static registry snapshot.
5. Optional `startupHandshake`: an exact first prompt for harnesses that create a session lazily. Dispatch sends it once, after native agent start and before startup proof, with the same uncertain-terminal-input fence as assignment prompts. A harness that does not need a first turn declares `supportsStartupHandshake: false`.
6. Explicit capabilities: distinguish native session identity, native versus screen-derived lifecycle, verified startup attestation, and the optional operations above. Detection or a screen-derived idle state is not launch qualification.

The common dispatcher additionally enforces workspace/pane/agent identity, startup nonce, bridge source, exact profile, required operations, and stable session identity. Registry registration is trusted local code, not evidence by itself: adapters need conformance tests and live qualification.

## Native session-resume parity

`herdr_resume` keeps the legacy `/goal-resume` path for an observed paused Pi
*goal*. For a lane whose durable session-log status is `done` or `gone`, it
uses only the adapter's exact native resume operation. It verifies the recorded
worktree, creates a tab in the current root's task workspace, registers the
updated pane route, starts the provider with a fresh nonce, and records the
new incarnation only after startup proof and the persisted session identity
match. The original `sessionLog.startedAt` is retained; the current launch is
`sessionLog.incarnationStartedAt`.

| Harness | Parity | Exact native invocation (inside `herdr agent start ... --`) |
| --- | --- | --- |
| Pi | Implemented | `pi --session <path-or-id> --provider <provider> --model <exact-model> --thinking <level> --no-extensions -e <herdr-agent-state> -e <herdr-tools-source>` |
| Claude Code | Implemented | `claude --resume <session-id> --model <exact-model> --effort <level> --settings <generated-settings> --mcp-config <generated-mcp> --strict-mcp-config` |
| Codex | Implemented | `codex resume <session-id> --model <exact-model> -s workspace-write -c model_reasoning_effort=<level> -c 'notify=["node","<attest-helper>"]' -c 'mcp_servers.herdr-orchestrator.command="node"' -c 'mcp_servers.herdr-orchestrator.args=["<bridge>"]' -c 'mcp_servers.herdr-orchestrator.env.BAA_STARTUP_INTENT="<intent>"' -c 'mcp_servers.herdr-orchestrator.env.HERDR_ENV="1"'` (`codex exec resume` is non-interactive and is not used for a Herdr lane) |
| OpenCode | Implemented | `opencode --session <session-id> --model openai/<exact-model>` (before start, the adapter writes the generated attest plugin and MCP config used for startup proof) |

The four installed harnesses therefore have no silent resume gap. An adapter
that omits `supportsSessionResume`, `resumeSessionId`, or `resumeArguments` is
explicitly unsupported and the root executor fails closed before creating a
tab. No provider uses `--last`, most-recent, a picker, a transcript-path
substitution, or an inferred different worktree.

## Claude lanes: known-safe permission prompts

A Claude lane runs with the operator's own settings underneath the generated ones, so an operator `ask` rule such as `Bash(rm *)` or `Bash(git checkout *)` still prompts inside a lane, and nobody is at a dispatched lane to answer. The generated settings add a `PermissionRequest` hook (`known-safe-hook.mjs`) that answers those prompts for commands `known-safe.mjs` accepts: removing temp files the same command created, a `mktemp -d` directory, one file in a session scratchpad, a relative output directory the command recreates, self-test directories, and creating or detaching a feature branch at `origin/main`. Every other segment of the command must be inert (read-only, or confined to creating files in the working tree or a scratchpad), or the hook stays silent and the prompt stays up. Approvals are logged to `.baa-ton/herdr-orchestrator/known-safe-approvals.jsonl`.

Why PermissionRequest and not PreToolUse: per the Claude Code hooks and permission-mode docs, a PreToolUse `"allow"` only means "no objection" and ask rules are still evaluated after it, while a PermissionRequest decision answers the prompt an ask rule forces, in every mode that prompts (including auto). Deny rules win over both, so the lane's push, merge and PR denies are unchanged; the classifier's push and merge-by-branch rules exist for operator sessions and are off for lanes. No hook approves an `rm` of a critical path (such as `/` or `~`). Not verified live: whether a PermissionRequest decision also answers an ask-rule prompt in `bypassPermissions` mode, where the docs say ask rules still prompt.

## Current evidence

| Adapter | Source/local tests | Live qualification |
| --- | --- | --- |
| Pi / openai-codex subscription | Implemented in `pi-launch-adapter.ts`; maps Pi tool names to the neutral `plan`/`dispatch`/`complete` operations | Proven: `herdr-f3afd260` and `herdr-fc6d2a3e` dispatched with verified startup proof and durable completion receipts |
| Synthetic Codex fixture (test-only) | The dispatch regression uses an ID-session adapter with native tool names to prove normalized operations and shared sequencing without editing the core | Not production qualification; the registered Codex adapter is listed below |
| Missing-capability adapter | Registry regression rejects missing `supportsSessionPersistence` before topology mutation | Not launch-qualified |
| Codex / openai-codex subscription | Implemented in `codex-launch-adapter.ts` (+ `codex-startup-attest.mjs` notify hook with thread-id attestation, explicit `startupHandshake` proof turn, per-invocation `-c` config incl. MCP env wiring, workspace-write sandbox): effort ladder maps 1:1. Root planning accepts Herdr's verified native Codex session identity as either a path or an id; live catalog discovery is explicitly unsupported (`supportsLiveCapabilityDiscovery: false`): Codex exposes no stable authoritative catalog API at this adapter boundary, so static config is not used as a substitute | Qualified live (`herdr-44fa8053`, items 3+6+broker, 17/17 serial, committed d3816c8; re-verified live 2026-09-16 `herdr-9bbb9d23`: handshake, exact profile, and normalized operations confirmed, findings relayed via `herdr_message`). Known limitations: codex does not respawn dead MCP servers (a killed bridge orphans the lane tools for the session); the workspace-write sandbox cannot write linked worktree git metadata (parent-proxy commit + operator reconciliation apply); and a host `approval_policy = "never"` denies the lane's own mutating bridge tools (`herdr_complete`/`herdr_observe`/`herdr_doctor`) — non-mutating tools like `herdr_message` pass. codex-cli 0.154 has no per-server tool-approval knob (`--strict-config` rejects `tool_approval`), so unattended never-policy hosts cannot file codex receipts; attended lanes may run with `approval_policy = "on-request"` and approve at the pane |
| OpenCode / openai-codex subscription | Implemented in `opencode-launch-adapter.ts` (+ generated attest plugin and project `opencode.json`): model mapped `openai/gpt-5.6-luna`, reasoningEffort option, conservative bash permissions (push/merge/PR denied). The adapter declares the exact `Reply with exactly: READY` startup handshake so lazy session creation is automatic; the bridge merges operations independently. Live catalog discovery is explicitly unsupported (`supportsLiveCapabilityDiscovery: false`): the adapter has no authoritative live provider catalog API | Qualified live (`herdr-c5795503`): manual READY handshake previously matched native session/plugin attestation and delivered assignment; source-level follow-up now fences and dispatches that handshake automatically |
| Claude Code / claude-code subscription | Implemented in `claude-launch-adapter.ts` (+ `claude-startup-attest.mjs` SessionStart hook, `mcp-server.mjs` operations merge, `attest-merge.mjs`): exact model + `--effort` (identical ladder), generated settings/mcp config, conservative lane permissions (push/merge/PR denied), session attestation matched against native identity. SessionStart is the startup proof, so `supportsStartupHandshake: false`; live catalog discovery is explicitly unsupported (`supportsLiveCapabilityDiscovery: false`) because no stable authoritative catalog API is exposed at this adapter boundary | Qualified live with a durable receipt (2026-09-16 `herdr-27cde2e4`, read-only proof lane on claude-sonnet-5/high: env identity, native pane/tab/session match, exact profile across cmdline + intent + SessionStart sidecar, nonce-matched attestation declaring plan/dispatch/complete, doctor capability matrix confirmed). Earlier live lanes also receipted: durable-core batch (`herdr-092aa4f8`), cross-vendor review (`herdr-33ff206c`, including a post-completion focused re-review), README humanizer (`herdr-473dbe0a`) |

**Claude lane permissions.** A dispatched Claude lane runs in whatever permission mode the user's Claude settings default to; the adapter does not force one. Its generated `--settings` file:
- allows the lane's own Baa-ton MCP tools (`mcp__herdr-orchestrator__herdr_message`, `herdr_complete`, `herdr_lease`, `herdr_request`), so they never prompt;
- denies push, merge and PR creation;
- in **auto mode**, adds an `autoMode.allow` classifier rule (after `"$defaults"`) stating that reporting to the parent root through those tools is the lane's contract. The classifier had denied a lane's `herdr_complete`/`herdr_message` as "Auto-Mode Bypass", so the receipt never reached the root.

If a lane still loses a call to a classifier denial, the lane shows as done without a receipt. Reconnect it (`/mcp`) or rerun the call, or run lanes in the default permission mode. The classifier's handling of the rule has not been verified against a live auto-mode session.

Unregistered adapters fail before topology mutation. The synthetic Codex test is **not** a claim that real Codex startup is qualified.

`launch-profile.ts` validates common shape only; provider qualification belongs to the adapter. Subscription-only auth is the current policy, not an automatic fallback. The present workflow schema uses one profile per workflow; heterogeneous profiles require a versioned per-lane schema extension. Pi is the only adapter with live `discoverCatalog` evidence today. Codex, Claude, and OpenCode deliberately omit that optional method and declare `supportsLiveCapabilityDiscovery: false` with an adapter-level reason; qualification records that declaration rather than treating the omission as a silent gap.

## Live qualification procedure

The parent executes one bounded, single-lane run per harness from the verified
root. Do not run these dispatches from an adapter lane. Use a clean existing
checkout, set `readOnly: true`, and keep the objective limited to startup proof,
protocol-tool reachability, and a completion receipt; the lane must not edit,
commit, push, merge, create a PR, deploy, delegate, or close resources.

The checked-in Codex qualification evidence uses `openai-codex/gpt-5.6-luna`;
that is the qualified equivalent to `openai-codex/gpt-5.2-codex` when the latter
is not installed. Use `high` for this parity proof (the adapter maps it
one-to-one). Claude uses the exact `claude-code/claude-sonnet-5/high` profile.
OpenCode uses the same `openai-codex/gpt-5.6-luna/high` profile and maps it to
OpenCode's `openai/gpt-5.6-luna` model.

### Bounded proof objective

Use this template, replacing only `<harness>` and the returned workflow ID:

> Live-qualify the `<harness>` adapter only. Start this one read-only lane,
> verify native pane/workspace/session identity, exact launch profile, startup
> nonce/source, and all protocol operations plan/dispatch/complete; then report
> one completion receipt. Do not edit files, delegate, push, merge, create a
> PR, deploy, or close resources.

For each harness, the parent makes these exact tool calls (the `herdr_plan`
result's `details.workflow.id` is the `<workflow-id>` passed to dispatch):

```js
// Codex: provider/model/thinking/auth =
// openai-codex / gpt-5.6-luna / high / subscription
const plan = await herdr_plan({
  objective: "Live-qualify the codex adapter only: one read-only startup/protocol/receipt proof; no edits or resource closure.",
  worktreeCwd: "<existing-clean-checkout>",
  lanes: [{
    objective: "Verify native identity, exact profile, startup proof, plan/dispatch/complete, and report one receipt; do not edit or delegate.",
    readOnly: true,
    agentKind: "codex",
    launchProfile: {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinking: "high",
      auth: "subscription"
    }
  }]
});
await herdr_dispatch({ workflowId: plan.details.workflow.id, execute: true });
```

```js
// Claude: claude-code / claude-sonnet-5 / high / subscription
const plan = await herdr_plan({
  objective: "Live-qualify the claude adapter only: one read-only startup/protocol/receipt proof; no edits or resource closure.",
  worktreeCwd: "<existing-clean-checkout>",
  lanes: [{
    objective: "Verify native identity, exact profile, SessionStart proof, plan/dispatch/complete, and report one receipt; do not edit or delegate.",
    readOnly: true,
    agentKind: "claude",
    launchProfile: {
      provider: "claude-code",
      model: "claude-sonnet-5",
      thinking: "high",
      auth: "subscription"
    }
  }]
});
await herdr_dispatch({ workflowId: plan.details.workflow.id, execute: true });
```

```js
// OpenCode: openai-codex / gpt-5.6-luna / high / subscription;
// the adapter writes the OpenCode model as openai/gpt-5.6-luna.
const plan = await herdr_plan({
  objective: "Live-qualify the opencode adapter only: one read-only startup/protocol/receipt proof; no edits or resource closure.",
  worktreeCwd: "<existing-clean-checkout>",
  lanes: [{
    objective: "Verify native identity, automatic READY handshake, exact profile, startup proof, plan/dispatch/complete, and report one receipt; do not edit or delegate.",
    readOnly: true,
    agentKind: "opencode",
    launchProfile: {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinking: "high",
      auth: "subscription"
    }
  }]
});
await herdr_dispatch({ workflowId: plan.details.workflow.id, execute: true });
```

After dispatch, wait for the event-driven completion wake and call
`herdr_observe({ workflowId: plan.details.workflow.id })` once to record the
lane result. Capture all of the following in the parent receipt (without
credentials or token contents):

1. **Startup proof:** dispatch result, workflow/lane IDs, native `agent get`
   identity, `.ready` attestation, pane/workspace binding, incarnation nonce,
   source, exact profile, normalized `plan`/`dispatch`/`complete` operations,
   and the stable native session path/ID.
2. **Capability-discovery evidence:** Pi emits a live catalog and its
   `cacheKey`. Codex, Claude, and OpenCode must emit *no fabricated catalog*;
   record each adapter's `supportsLiveCapabilityDiscovery: false` and the
   source comment explaining why discovery is explicitly unsupported. This is
   the expected qualified result, not a missing evidence field.
3. **Completion:** the child's durable `completionReceipt` and the parent
   observation showing it delivered. If the harness limitation prevents a
   child receipt, do not retry terminal input; record the dispatch evidence and
   use the existing parent-proxy/operator-reconciliation procedure.
4. **Focused regression:** from this checkout run
   `env -u BAA_STARTUP_INTENT node --test packages/herdr-tools/test/<harness>-adapter.test.mjs`
   (`codex`, `claude`, or `opencode`) and retain the pass count, plus the
   source commit under test.

Only after all four evidence groups are present should the parent replace the
matrix cell with the corresponding wording below. A failed or incomplete run
stays `Source/local tests: implemented; live qualification: pending` and must
not be described as live-qualified.

**Codex cell wording after success:**

> Live qualified (`<workflow-id>`): exact `openai-codex/gpt-5.6-luna/high/subscription`
> startup proof matched native Codex thread/rollout identity, workspace/pane,
> nonce, source, and normalized protocol operations; automatic adapter
> `startupHandshake` completed and a durable receipt was observed. Live catalog
> discovery is explicitly unsupported (`supportsLiveCapabilityDiscovery: false`)
> because no stable authoritative Codex catalog API is available at this boundary.
> Preserve the existing no-MCP-respawn and workspace-write/git-metadata
> limitations.

**Claude cell wording after success:**

> Live qualified (`<workflow-id>`): exact
> `claude-code/claude-sonnet-5/high/subscription` startup proof from SessionStart
> matched native Claude session identity, workspace/pane, nonce, source, and
> normalized protocol operations; a durable receipt was observed. No startup
> handshake is sent (`supportsStartupHandshake: false`); live catalog discovery
> is explicitly unsupported (`supportsLiveCapabilityDiscovery: false`) because
> no stable authoritative Claude catalog API is available at this boundary.

**OpenCode cell wording after success:**

> Live qualified (`<workflow-id>`): exact
> `openai-codex/gpt-5.6-luna/high/subscription` startup proof matched native
> OpenCode session identity, workspace/pane, nonce, source, and normalized
> protocol operations; the adapter's automatic `Reply with exactly: READY`
> handshake materialized the session and a durable receipt was observed. Live
> catalog discovery is explicitly unsupported
> (`supportsLiveCapabilityDiscovery: false`) because no authoritative live
> provider catalog API is available at this boundary.

## Prior art: Paseo provider layer (design basis for contract evolution)

Surveyed 2026-09-15 from `getpaseo/paseo` (`packages/server/src/server/agent/agent-sdk-types.ts`, `providers/acp-agent.ts`, `agent/tools/types.ts`; local clone under `/tmp/pi-github-repos/`). Paseo orchestrates Claude Code, Codex, OpenCode, Copilot, and Pi behind one provider layer. Adoptable patterns, mapped to our gaps:

1. **Central injected tool catalog** (`PaseoToolCatalog`): orchestration tools are defined once and injected into every harness; MCP is one transport. They never depend on harness-native tool names — our core currently checks literal `herdr_*` strings and must move to protocol operations owned by the contract.
2. **Open capability map**: `[capability: string]: boolean` with required flags (`supportsStreaming`, `supportsSessionPersistence`, `supportsMcpServers`, `supportsReasoningStream`, `supportsToolInvocations`, `supportsDynamicModes`) plus optional/custom flags. Extensible without contract version bumps; covers the whole lifecycle, not just launch.
3. **Neutral contract module** (`agent-sdk-types.ts`): domain types live outside any harness entrypoint. Our `Workflow`/`Lane` still live in the Pi extension `index.ts` and must move to a neutral core module.
4. **Live capability discovery** (`fetchCatalog`): models + modes + `thinkingOptions[]` are discovered from the live provider runtime with documented cache-key identity, not trusted from a static registry. Matches our Luna-at-`high` finding: the catalog map is a UI enumeration, not a support boundary.
5. **Normalized event seam**: timeline items (`prompt`/`text`/`thinking`/`tool-execution`/`failure`) and a normalized permission request/response flow. This is the seam our question routing and completion still lack.
6. **ACP tier**: any harness speaking Agent Client Protocol (agentclientprotocol.com) works through one generic adapter — the long tail for free; native adapters only where depth is needed.
7. **Generalized persistence handle**: `{provider, sessionId, nativeHandle?, metadata?}` — a superset of our `NativeSessionRef {kind, value}`.

Deliberately NOT copied: Paseo's daemon owns process spawning and transports. We run inside Herdr's native agent management; our adapters stay thin (launch arguments + startup attestation). Borrow the contract shapes, not the runtime.

Near-term (this contract): items 1–2. Medium-term: 3–4. The event seam (5) is the bulk of remaining durable-core work; ACP (6) is a future harness tier.

## Remaining core work

This is the dispatch boundary, not a completed multi-harness product. Domain types still live in the Pi entrypoint and need moving to a neutral core module. Goal/decision/completion adapters, durable inbox recovery, MCP/CLI validation, and real Codex/Claude qualification remain delegated-core work. New adapters must reuse those shared state transitions rather than implement independent persistence, retry, or routing engines.

Acceptance for each adapter: exact-profile/auth failure before assignment; native-session replacement rejection; different-cwd routing; same-workspace retry/restart; explicit missing capabilities; decision/pause/completion round trips; timeout ambiguity without duplicate terminal input; and process-separated contract tests plus native live evidence.
