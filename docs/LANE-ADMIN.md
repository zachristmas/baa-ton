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
- **Uniqueness:** an allocation runs inside one manifest-lock transaction: reload, then pick the lowest free slot in the range, where free means no active lease holds any of its ports or the name. After picking, a TCP bind probe on `127.0.0.1` skips slots that something outside Baa-ton is already listening on. Then save. `loadManifest` also fails closed if two active leases overlap, so hand edits can't create a silent collision.
- **Allocation points:**
  - Dispatch: each writer lane gets `dispatchLeases`, allocated before launch, and the values go into the lane brief and the Claude SessionStart assignment from PR #18.
  - On request: `herdr_lease request`.
  - Read-only lanes get no automatic leases.
- **Release:** closing a lane or workflow releases its leases in the same transaction. `herdr_sweep` releases leases whose workflow is closed or whose lane is gone. Its dry-run lists them, and executing the sweep still requires confirmation. There is no time-based expiry, because nothing polls.
- **Idempotent:** asking again for a resource a lane already holds returns the existing lease.

### Tool: `herdr_lease` (extension and MCP bridge)

| action | root | lane |
| --- | --- | --- |
| `list` | all leases in its manifest | its own workflow's leases |
| `request {resource}` | for any lane it owns | for itself. Granted at once if the resource is configured, the lane is under `maxPerLane`, and the policy includes `lease` (see 2). Otherwise it becomes a root request (goal 3, digest). |
| `release {leaseId}` | any | its own |

The lane's identity comes from the existing route resolution (pane/workspace env matched against the controller config, the same path `herdr_message` uses). Lanes never pass it as an argument.

## 2. Standing approval policy

### Shape (`.baa-ton/config.json`, new `approvalPolicy`)

```json
"approvalPolicy": {
  "version": 2,
  "grants": ["dispatch", "retry", "resume", "lease", "runtime-launch"],
  "dispatch": { "taskProfilesOnly": true, "cleanWorktreeRequired": true },
  "runtimeLaunch": { "commands": ["docker compose -p {lane} up -d", "npm run dev -- --port {lease.app[0]}"] }
}
```

- `grants` accepts only `dispatch | retry | resume | lease | runtime-launch`. Any other value, including push, merge, deploy, close or sweep, fails validation, and the whole policy is then treated as absent (fail closed).
- **Within policy** means:
  - **dispatch/retry:** the workflow is local to its bound task workspace and uses a configured `taskProfile`, not an ad-hoc `launchProfile`. A worktree must be clean. Retry stays within the existing retry state machine.
  - **runtime-launch:** the command matches a template token for token, with no shell metacharacters (the same approach as `isReadOnlyPiDiagnostic`), and every `{lease.*}` placeholder resolves to one of this lane's active leases. This is what goal 3's permission auto-answer checks.

### Recording it once, safely

The policy file is plain JSON in the repo, and a lane could edit it by accident. To guard against that, the root acknowledges it:

- On the first dispatch after the policy appears or changes, the root shows one native confirmation listing the grants.
- The accepted SHA-256 is saved in the manifest as `approvalPolicyAck { hash, grants, ackedAt, rootPaneId }`.
- After that, `authorizationDecision` grants silently only while the file's hash still equals the acknowledged hash. A changed file means one new confirmation, never a silent widening.

On a headless root, the existing `confirm=true` bar applies to the acknowledgement: only after Zach says so in that conversation.

Each auto-grant adds an `authorization-policy-granted` evidence entry naming the operation and policy hash, as today. Auto-grants don't wake the root.

### BB-029 legacy

- `authorizationDecision` keeps honouring an already recorded per-workflow `authorizationPolicy`, so existing manifests behave the same.
- `herdr_plan` stops accepting new ones and points to `approvalPolicy`.
- The BB-029 regex and `validateAuthorizationPolicy` stay only on the legacy read path.

### Parallel-confirm deadlock

- **Cause (read from the installed Pi source; `test/confirm-queue.test.mjs` reproduces it with a fake that models this behavior, not against a live Pi TUI):** `showExtensionSelector` in `pi-coding-agent/dist/modes/interactive/interactive-mode.js:1953` replaces the current selector without resolving the earlier promise. With two concurrent `ctx.ui.confirm` calls, one promise can never settle.
- **Fix: serialize.**
  - Every native confirm in the extension goes through one module-level queue (`confirmExecution`, plus the direct `ctx.ui.confirm` calls at index.ts ~4097 and ~6903).
  - Each call waits for the one before it to settle, and its title shows how many callers were already waiting when it opened.
  - The tool's `AbortSignal` is passed through, so a cancelled call leaves the queue instead of blocking it.
- Serializing is better than failing fast here: two parallel dispatches each get their own dialog in turn, with no retry needed. With the policy in place, routine dispatches don't reach the queue at all.

## PR plan

1. **Confirmation queue + deadlock test.** Small; ships first.
2. **`approvalPolicy` v2**: the validator, hash acknowledgement, `authorizationDecision` rewrite, BB-029 legacy path and docs (BAA.md, tool descriptions).
3. **Leases**: config validation, ledger, allocator, bind probe, dispatch allocation, release on close and sweep, `herdr_lease` in the extension and bridge.
4. **Goal 3**: `herdr_permission_prompt` and lease requests answered against the policy on the lane side; anything outside policy becomes a root digest item.

Each PR adds unit tests using fakes (a fake bind probe, a fake `ui.confirm`) and keeps `npm test` green.

## Decisions (2026-09-23)

1. **Uniqueness scope:** per project manifest, plus a live bind probe. There is no machine-wide ledger.
2. **Policy location:** `.baa-ton/config.json`, with the hash acknowledgement stored in the manifest.
3. **Dispatch-time leases:** writer lanes only.
4. **Auto-grants:** recorded as evidence only. They don't wake the root or add a digest line.
