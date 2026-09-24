# Lane admin in code: leases and a standing approval policy

Status: design approved by Zach on 2026-09-23, with the proposal taken on all four open questions (see Decisions). Covers goals 1 and 2 of the lane-admin brief; goal 3 is sketched where it shapes 1 and 2.

## Problem

Lanes stall waiting on the root for routine things: ports, database names, permission to start local services, and every dispatch's native confirmation. Ports were negotiated by message and collided (D13 3600-3603 and Azurite 10070-10072 overlapped D18). Two parallel `herdr_dispatch` calls deadlocked on confirmation.

## Constraints kept

- State stays in the existing JSON manifest (`.baa-ton/herdr-orchestrator/manifest.json`) and `.baa-ton/config.json`, mutated only under `acquireManifestLock`. No SQLite.
- Invariant 3 (root-only authority) is narrowed, not dropped: a lane may take only what a root-acknowledged policy already grants. Everything else still goes to the root.
- Push, merge, deploy, production, external messages, reparent and destructive cleanup (`herdr_close` with worktree removal, `herdr_sweep execute`) are never grantable. The validator rejects them, so no policy can include them.

## 1. Leases

### Config (`.baa-ton/config.json`, new `runtime` section)

```json
"runtime": {
  "leases": {
    "app":      { "kind": "port-block", "size": 4, "range": [3600, 3999] },
    "azurite":  { "kind": "port-block", "size": 3, "range": [10000, 10999] },
    "redis":    { "kind": "port",       "range": [6400, 6499] },
    "postgres": { "kind": "name", "prefix": "cic", "maxLength": 63 }
  },
  "dispatchLeases": ["app", "postgres"],
  "maxPerLane": { "app": 1, "azurite": 1, "redis": 1, "postgres": 2 }
}
```

- `port` is one port. `port-block` is `size` contiguous ports, aligned to `size` inside the range, so a block never straddles two leases.
- `name` produces `<prefix>_<workflow8>_<lane>`, lowercased to `[a-z0-9_]` and truncated to `maxLength` with a hash suffix. It only reserves the name. Creating the database is still the lane's job.

### Ledger (manifest top level, `leases: Lease[]`)

```ts
type Lease = {
  id: string;                       // lease-xxxxxxxx
  resource: string;                 // config key, e.g. "azurite"
  kind: "port" | "port-block" | "name";
  ports?: number[]; name?: string;
  workflowId: string; laneId: string;
  state: "active" | "released";
  grantedBy: "dispatch" | "lane-policy" | "root";
  grantedAt: string; releasedAt?: string; releaseReason?: string;
};
```

- Top level rather than per workflow, so the uniqueness check is a single scan across every workflow in the project. That scan is what would have caught D13 vs D18.
- **Uniqueness:** an allocation runs inside one manifest-lock transaction.
  - It reloads the manifest and picks the lowest free slot in the range. Free means no active lease holds any of the slot's ports or the name.
  - A TCP bind probe on `127.0.0.1` skips slots that something outside Baa-ton is already listening on. Then the manifest is saved.
  - Overlapping port ranges between two resources are rejected at config validation.
- **Hand edits (as built, PR 3):** a ledger in which two active leases overlap does not make `loadManifest` throw, since that would stop every tool. Instead, `herdr_lease list` shows each overlap as `CONFLICT: ...`, and every allocation refuses until it is resolved.
- **Labels (as built):** a lease is keyed by workflow, lane, resource and label (default `default`).
  - Asking again for the same key returns the existing lease.
  - `maxPerLane` (default 1) limits how many labels a lane may hold per resource, e.g. `postgres` plus `postgres:test`.
- **Allocation points:**
  - Dispatch: each writer lane gets `dispatchLeases`, allocated before launch, and the values go into the lane brief and the Claude SessionStart assignment from PR #18.
  - On request: `herdr_lease request`.
  - Read-only lanes get no automatic leases.
- **Release:**
  - `herdr_close`, and the completion of lane-tab retirement, release the workflow's leases in the same manifest write.
  - `herdr_sweep` releases leases whose root-owned workflow is terminal (or all of its lanes are), or whose workflow is gone from the manifest.
  - Auto-retire (PR 5) will release per lane. Its dry-run lists them, and executing the sweep still requires confirmation. There is no time-based expiry, because nothing polls.
- **Idempotent:** asking again for a resource a lane already holds returns the existing lease.

### Tool: `herdr_lease` (extension and MCP bridge)

| action | root | lane |
| --- | --- | --- |
| `list` | all leases in its manifest | its own workflow's leases |
| `request {resource, label?}` | for any lane it owns (`workflowId`, `laneId` required) | for itself. Granted at once if the resource is configured, the lane is under `maxPerLane`, and the acknowledged policy grants `lease`. Otherwise it returns `parentApprovalRequired`; PR 4 turns that into a tracked root request. |
| `release {leaseId}` | any | its own |

The lane's identity comes from the existing route resolution (pane/workspace env matched against the controller config, the same path `herdr_message` uses). Lanes never pass it as an argument.

## 2. Standing approval policy

### Shape (`.baa-ton/config.json`, new `approvalPolicy`)

As built in PR 2 (`packages/herdr-tools/approval-policy.ts`):

```json
"approvalPolicy": {
  "version": 2,
  "grants": ["dispatch", "retry", "resume", "retire", "lease", "runtime-launch"],
  "runtimeLaunch": {
    "commands": [
      { "name": "compose", "start": "docker compose -p {lane} up -d", "stop": "docker compose -p {lane} down" },
      { "name": "web", "start": "npm run dev -- --port {lease.app[0]}" }
    ]
  }
}
```

- `grants` accepts only `dispatch | retry | resume | retire | lease | runtime-launch`.
  - `retire` covers closing a finished lane's session and stopping its leased services. It never removes a worktree.
  - Push, merge, deploy, production, close, sweep, reparent and external messages are rejected by name.
  - Any invalid field makes the whole policy count as absent (fail closed).
- The task-profile and clean-worktree rules are fixed, not configurable.
- `runtimeLaunch` requires the `runtime-launch` grant.
  - Templates are single-space-separated tokens with no shell metacharacters.
  - Placeholders are `{lane}`, `{workflow}` and `{lease.<resource>...}`.
  - `stop` is the command auto-retire runs (PR 5).
- **Within policy** means:
  - **dispatch/retry:** every lane resolves to a named `taskProfile` (its own or the workflow's). No lane has an ad-hoc `launchProfile` or extra `mcpServers`. The worktree, if any, is clean.
  - **resume:** a clean worktree.
  - **runtime-launch:** the command matches a template token for token, and every `{lease.*}` placeholder resolves to one of this lane's active leases (PR 4).

### Recording it once, safely

The policy file is plain JSON in the repo, and a lane could edit it by accident. To guard against that, the root acknowledges it:

- **Hash:** the policy hash is SHA-256 over the validated, canonicalized policy. Reformatting the file keeps the acknowledgement, but any change to what it grants needs a new one.
- **Stored acknowledgement:** the manifest records `approvalPolicyAck { hash, grants, ackedAt, rootPaneId }`. `loadManifest` carries it through, and the smoke check guards against later writes dropping it.
- **Acknowledging on a TUI root:** the first routine operation after the policy appears or changes shows one dialog. It lists the grants and says what always asks, then "Record this policy and dispatch X?". Declining falls back to the ordinary one-off dialog.
- **Acknowledging on a headless root:** there is never an implicit acknowledgement. `herdr_policy action=ack confirm=true` is allowed only after the user approves the exact policy shown by `herdr_policy action=show`. Until then, headless dispatch keeps the existing `confirm=true` one-off path.
- **Evidence:** each standing decision adds workflow evidence: `authorization-policy-granted`, `approval-policy-not-applied` (with the reason) or `approval-policy-acknowledged`. Standing grants don't wake the root.

### BB-029 legacy

- `authorizationDecision` keeps honouring an already recorded per-workflow `authorizationPolicy`, and it is checked first.
- **Deviation from the first draft:** `herdr_plan` still accepts a BB-029 policy, now documented as legacy. Removing it would have rewritten most of the smoke check for no gain. It can be removed once nothing uses it.

### Parallel-confirm deadlock

- **Cause (read from the installed Pi source; `test/confirm-queue.test.mjs` reproduces it with a fake that models this behavior, not against a live Pi TUI):** `showExtensionSelector` in `pi-coding-agent/dist/modes/interactive/interactive-mode.js:1953` replaces the current selector without resolving the earlier promise. With two concurrent `ctx.ui.confirm` calls, one promise can never settle.
- **Fix: serialize.**
  - Every native confirm in the extension goes through one module-level queue (`confirmExecution`, plus the direct `ctx.ui.confirm` calls at index.ts ~4097 and ~6903).
  - Each call waits for the one before it to settle, and its title shows how many callers were already waiting when it opened.
  - The tool's `AbortSignal` is passed through, so a cancelled call leaves the queue instead of blocking it.
- Serializing is better than failing fast here: two parallel dispatches each get their own dialog in turn, with no retry needed. With the policy in place, routine dispatches don't reach the queue at all.

## PR plan

Updated 2026-09-23 with Zach's five additions (items 1-5 in his note), each from a stall in the live cic run.

1. **Confirmation queue + deadlock test.** Merged as #20.
2. **`approvalPolicy` v2**: the validator, hash acknowledgement, `herdr_policy` (show/ack), standing grants for dispatch/retry/resume, BB-029 legacy path and docs.
3. **Leases**: config validation, ledger, allocator, bind probe, dispatch allocation for writer lanes, release on close, retire and sweep, `herdr_lease` in the extension and bridge.
4. **Formal lane requests (goal 3 + item 5)**: a `herdr_request` tool (lease, runtime-launch, approval, permission), tracked in `workflow.laneRequests` until answered. As built:
   - **Answered by policy**, once the policy is acknowledged:
     - `lease`: needs the `lease` grant and a free slot.
     - `runtime-launch`: needs the `runtime-launch` grant, and the exact command must match a template's `start` or `stop` token for token, with every `{lease.*}` placeholder resolved from this lane's own leases.
     - `approval` requests always go to the root.
   - **Open requests** are one urgent digest item each, skipping the window. Every later digest lists them in a footer until answered, without waking the root again.
     - Identical open requests from a lane are not duplicated.
     - The root answers with `action=answer decision=grant|deny`. Granting a lease allocates it. The answer is delivered to the lane pane with one non-waiting prompt, recorded as `answerDelivery`, and never retyped.
   - **`herdr_permission_prompt`** first asks `herdr_request` in policy-only mode. A matching Bash command is allowed and recorded; anything else keeps the existing deny-by-default broker path, with no second record.
5. **Auto-retire (item 2)**: when a lane's completion is accepted and the policy grants `retire`, close its session, run its runtime `stop` commands and release its leases. The worktree stays. As built:
   - **"Accepted"** means the lane's `herdr_complete` receipt was delivered to the root and the lane agent is not `working` or `blocked`. There was no explicit acceptance step to hook.
   - **Who runs it:** the extension on the root side, not the controller, which by its invariants never closes resources. It runs on every `agent_settled` of a Pi root, which includes the turn that ends in a question to Zach. `herdr_retire` is the explicit path for any root, dry-run by default, with a confirmation unless `retire` is granted.
   - **Stop commands** are the `stop` of every runtime template the lane was granted a `start` for (from `laneRequests`), run as plain argv (no shell) in the workflow's worktree or cwd with a 120 s timeout. `pi.exec` in the MCP bridge now honours `cwd`.
   - **Closing the lane's tab** ends the agent session and its child processes. A tab shared with an unfinished lane is left alone.
   - **Leases** are released only when every stop command exits 0. Otherwise the retirement is `partial` and the leases are kept, so the still-running service's ports can't be handed out again. The sweep releases them once the workflow is terminal.
   - **The session log** records the lane as `retired`. As with any completed lane, `herdr_resume` does not resume it.
6. **Directives with ack (item 4)**: directives to the root are stored in the manifest and delivered as urgent digest items.
   - They stay open until the root runs `herdr_directive ack`.
   - If the root finishes a turn without acking, the directive is re-sent once. If it is still unacked, Zach gets a `herdr notification show`.
   - **As built:**
     - Directives are posted with `packages/controller/directive.mjs post` (or `postDirective`) into the parent manifest's `directives`, keyed by orchestrator id.
     - A re-send happens after the first settled root turn whose timestamp is later than the send. Without a turn record, it happens after 5 minutes.
     - Escalation comes after the ignored re-send, or `program.directive_escalate_minutes` (default 15) after posting, whichever is first. It covers a directive never delivered because the root stayed busy or blocked.
     - It fires once per directive and is recorded in `escalation`. The notifier is injectable for tests.
7. **Capacity gate + no-progress watchdog (items 1 and 3)**: two monitors on the existing supervisor tick.
   - **Capacity gate:** when the root's recorded capacity gate clears, "capacity available" goes into the digest. If capacity stays blocked for more than `program.capacity_escalate_minutes` (default 15), Zach gets a notification naming the top memory users.
   - **Watchdog:** if no lane has been `working` for `program.watchdog_minutes` (default 30) while the parent goal isn't terminal, Zach gets a notification and the root a nudge. Each alert fires once per episode.
   - These are the controller's first wall-clock thresholds, so the controller README text about "no stall timer" changes with this PR.

Each PR adds unit tests using fakes (a fake bind probe, a fake `ui.confirm`, the stub `herdr` for notifications) and keeps `npm test` green.

## Decisions (2026-09-23)

1. **Uniqueness scope:** per project manifest, plus a live bind probe. There is no machine-wide ledger.
2. **Policy location:** `.baa-ton/config.json`, with the hash acknowledgement stored in the manifest.
3. **Dispatch-time leases:** writer lanes only.
4. **Auto-grants:** recorded as evidence only. They don't wake the root or add a digest line.
