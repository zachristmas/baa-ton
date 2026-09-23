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
4. **Formal lane requests (goal 3 + item 5)**: a `herdr_request` tool (lease, runtime-launch, approval, permission), tracked in the manifest until answered.
   - Policy-matching requests are answered automatically.
   - Other requests appear in every root digest until they are answered.
   - `herdr_permission_prompt` uses the same path.
5. **Auto-retire (item 2)**: when a lane's completion is accepted and the policy grants `retire`, close its session, run its runtime `stop` commands and release its leases. The worktree stays.
6. **Directives with ack (item 4)**: directives to the root are stored in the manifest and delivered as urgent digest items.
   - They stay open until the root runs `herdr_directive ack`.
   - If the root finishes a turn without acking, the directive is re-sent once. If it is still unacked, Zach gets a `herdr notification show`.
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
