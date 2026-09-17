# Herdr workflow tools

Harness-neutral local workflow operations for Herdr. The local MCP bridge exposes the same durable planning, dispatch, observation, recovery, and close tools to any Herdr-compatible harness.

## Tools

| Tool | Purpose |
| --- | --- |
| `herdr_goal` | Manage the root-only durable parent goal. |
| `herdr_reparent` | Preview or root-confirm a controller-root handoff. |
| `herdr_recover_root` | Preview or explicitly apply an audited migration of a stale project root whose workspace is gone. |
| `herdr_plan` | Create a durable workflow and its lanes. |
| `herdr_dispatch` | Preview or create owned Herdr workspace/tab/lane resources. |
| `herdr_observe` | Record lane state and bounded recent output, including child messages. |
| `herdr_message` | Send durable informational context from a child to its parent. |
| `herdr_resume` | Recover paused Pi goals or reattach done/gone lanes through exact native session resume. |
| `herdr_close` | Close only a completed, evidenced, extension-owned workspace. |

All operations fail closed outside a Herdr session. Dispatch, resume, and close are previews by default. Non-root callers persist a parent-approval request rather than presenting approval UI.

## Recover a stale project root

Use `herdr_recover_root` when the registered root's workspace has disappeared
and a manually started session in the same checkout needs to take ownership.
Use `herdr_reparent` for its existing live-root handoff case. Recovery does not
bootstrap with reset or discard previous workflows.

1. Read the controller registrations and select the exact recorded `oldRootId`.
   Resolve any external failed-submission records before changing the manifest.
2. Call `herdr_recover_root` with `oldRootId` only. The preview verifies the real
   current pane, workspace and native session, requires the old workspace to be
   absent and its agent probe to return structured `agent_not_found`, and rejects
   conflicting root/child ownership or non-quiescent workflows.
3. Show the preview. With explicit migration authorization, call the same tool
   with `execute: true`, its `expectedFingerprint`, and `evidence` describing that
   authorization. Changed inputs require another preview. Run `herdr_doctor`
   afterward; do not infer dispatch readiness from migration alone.

Recovery retains other roots and routes. It migrates the selected root's scoped
goal/queue ownership and session log, and updates its workflow controller-root
references. Workflow receipts and original `taskBinding` provenance are retained;
this is not an adoption, verification, resume, or cleanup of historical workflows.
Only completed workflows with durable receipts and untouched, unrouted plans
are accepted. Cross-manifest routes and legacy draft scoped-goal schemas require
separate investigation. The new session must expose an exact native session path.

Manifest and controller locks protect the update. Private preimages and proposed
postimages are written to `.pi/herdr-orchestrator/root-recovery/` before applying
either document. Ordinary second-write failures restore the unchanged first
document; uncertain or crash-interrupted writes leave a pending journal and
further recovery refuses to proceed. Inspect that journal before any manual
repair. Keep `.pi/herdr-orchestrator/` excluded from Git. No lanes, worktrees,
model calls, authentication changes, or resource closures are performed.

Local live validation exercised a stale-root migration with prior workflow
history retained. Doctor reported healthy overall with an existing lane-bridge
warning; a subsequent read-only native Claude Code review completed with a
durable receipt and independent root verification. Migration alone does not
qualify other profiles or clear unrelated readiness warnings.

## Messaging the parent

A registered child uses `herdr_message` for durable informational context the root should review, including late facts after `herdr_complete`; use the question flow when Zach must decide something, and use `herdr_complete` for the lane's one completion receipt. Messages are not approval requests and are controller-routed to wake the mapped root.

## UI labels

Herdr lanes are labeled `🐑 <slug>` and the manually bootstrapped parent tab is
labeled `🐕 root`; the same role markers appear in the optional sidebar rows.
Lane slugs are deterministic kebab-case made from up to five significant
objective words after stopword removal, capped at 32 ASCII characters. New
lane agents use `child-<workflow8>-<laneNumber>` (for example,
`child-b5cc61d5-1`); existing names remain valid and unchanged.

Herdr v0.9.0 measures tab labels with Unicode display width (including the
East Asian Wide width of both role glyphs) before truncating, so the emoji
format is the active format. If a future renderer loses that width handling,
use the equivalent fallback prefixes `R: root` and `C: <slug>`.

The native `rows_by_agent` selector is canonical-agent scoped, so the
controller supplies `$herdr_role` and `$herdr_workflow` as pane metadata
(tokens are omitted when a value is unavailable); a root does not get one
workflow ID when it supervises multiple workflows.

## Guarantees

- Manifests are private, atomic local records.
- Workflows operate only resources they created and recorded.
- Each lane gets its own Herdr tab/root pane; no pane splits or implicit child sessions.
- Worktree workflows bind to one clean, pre-existing checkout and one registered parent workspace.
- Partial dispatch failures preserve resources and retry state; nothing is automatically closed.
- Observation is bounded; completion requires every lane to be done.
- No operation pushes, merges, deploys, invokes external services, or runs detached work.

## Session log

Each root manifest keeps a durable `sessionLog` root entry, and each lane keeps
its own `sessionLog` entry. An entry records `kind`, the provider-neutral
`sessionRef` (`PersistenceHandle`), `startedAt`, `lastResponseAt`, lifecycle
`status`, and the workflow/lane, pane/tab, workspace, and worktree breadcrumbs
when known. Lane `lastResponseAt` is derived from the controller's durable
`eventController.events` ledger, so it does not drift through a second activity
writer. The trace remains readable after a lane tab is retired or a worktree is
removed. `herdr_observe` returns the current root's root-plus-lane entries in
`details.sessionLog`; the manifest is the durable source of truth. `herdr_resume` natively reattaches `done`/`gone` lanes through the parity
adapter table in `HARNESS-ADAPTERS.md`; it retains the original `startedAt` and
records the new incarnation's start separately. Cleanup/retirement is a
root-only operation built on this trace; see the cleanup section below for the
confirmation and headless-MCP handoff rules.

## Cleanup sweep

`herdr_sweep` is a root-only, dry-run-by-default inventory of terminal lane tabs
and unopened orphaned Git worktrees belonging to the current root. Passing
`execute: true` always shows the complete bounded tab/worktree list in the
native `ctx.ui.confirm` dialog; no authorization policy can bypass that human
gate. A decline has zero side effects. After confirmation it retires recorded
lane tabs, verifies worktrees are clean, then runs direct non-forced Git
worktree and branch removal. Dirty, open, changed, or failed resources remain
in place and receive durable manifest evidence; session-log entries are marked
`retired` or `gone` only when the corresponding cleanup succeeds.

The JSON MCP bridge used by Codex is headless (`hasUI: false`) and cannot answer
that native confirmation on the user's behalf. A Codex/root caller must run the
dry-run, show its exact inventory in chat, and ask the user directly before
continuing. The user's chat approval is not an argument that bypasses the guard:
retry from a TUI-capable root or carry out only the exact approved manual cleanup,
and do not report cleanup as complete when the confirmation call is unavailable.

## Run as MCP

After `npm install` in the repository root, configure a local stdio MCP client with:

```sh
node /Users/zchristmas/baa-ton/packages/herdr-tools/mcp-server.mjs
```

The bridge exposes tools only when `HERDR_ENV=1` is present. It has no platform-specific dependency.

## Any harness as root

The bridge preserves root-role parity for `herdr_bootstrap_root`, `herdr_goal`,
`herdr_plan`, `herdr_dispatch`, `herdr_observe`, `herdr_resume`,
`herdr_close`, `herdr_operator_close`, `herdr_reparent`,
`herdr_question_answer`, and `herdr_doctor`. A non-Pi root receives a concise
`ROOT BRIEFING` when it bootstraps, covering the durable manifest, delegation,
wake, and approval/closure gates.

From the **current Herdr pane**, print exact setup instructions with:

```sh
node packages/herdr-tools/root-setup.mjs --harness claude
# or: codex | opencode | pi
```

The helper is stdout-only unless `--write` is supplied; it prints an `export`
line for the current pane identity as part of the setup commands. `--write` writes only
the selected harness's normal config location: project `.mcp.json` for Claude,
`~/.codex/config.toml` (only when absent) for Codex, or project
`opencode.json` for OpenCode; it does not write a Pi config. Claude and
OpenCode MCP processes inherit the current pane's `HERDR_*` identity, so keep
the harness in that pane. Codex MCP children do **not** inherit it; the helper
puts `HERDR_ENV`, `HERDR_WORKSPACE_ID`, `HERDR_PANE_ID`, and
`HERDR_PLUGIN_CONFIG_DIR` explicitly in Codex's MCP configuration. Pi uses the
extension directly. Live qualification of a non-Pi root remains the final
step.

To register another root without retiring an existing one, call
`herdr_bootstrap_root` from that root's current pane with `add: true`. Add mode
appends only the current pane/workspace mapping and leaves existing controller
records and manifests intact. The new root must use both a distinct pane and a
distinct workspace; using an already-registered root pane, a child-lane pane,
or a workspace already owned by another root is rejected. A same-pane/different
checkout replacement remains a `reset: true` operation, while an already
registered pane and checkout is idempotent.

Concurrent roots are isolated: each root owns its own checkout manifest,
parent goal, workflow/lanes, and wake/approval state. The controller keeps all
orchestrator records in one config but routes lifecycle events and wakes by the
registered pane/workspace mapping, so Pi, Claude Code, and other harness roots
can run side by side without sharing parent state.

## The queue

Each verified root has an additive, versioned durable queue in its own
manifest. Use `herdr_queue action=enqueue` with an objective, optional `notes`,
declared `files`, and `after` queue-item IDs; `list` shows states and blockers,
and `dequeue` returns only the ordered head whose dependencies and file
ownership are clear. The queue stores intent, not scoping judgment: the root
checks the declared files and decides scope at dequeue time.

Pass the returned `queueItemId` to `herdr_plan` to copy the objective and notes
into a planned workflow. Planning records the queue link and marks the item
`dispatched`; the root later uses `herdr_queue action=update` with evidence to
mark it `verified`, then `landed` (or `dropped`). When a landed workflow leaves a
clear next head, the controller sends one event-driven review wake. The optional
sidebar includes `$herdr_queue` as `N pending · head <slug>` alongside the goal
rows.

## Validate

```sh
npm run test:extension
```

The deterministic smoke check mocks Herdr and filesystem interactions; it never creates a live workspace, tab, pane, or agent.

## Design notes

- [Parent-goal protocol](./GOAL-ADAPTER-PROTOCOL.md)
- [Topology and cleanup](./TOPOLOGY-CLEANUP-PLAN.md)
- [Defect ledger](./DEFECTS.md)

## Planning parallel and sequential lanes

A worktree-bound workflow carries exactly one writer lane; multi-lane worktree
workflows must be all read-only. To parallelize writers, plan one workflow per
worktree with disjoint file ownership and dispatch them concurrently — lanes that
touch the same files must be sequenced (plan the second after the first verifies).
Integration is the parent's job: land lanes linearly, resolve the expected
type-move conflicts, and re-run the merged suite before calling the round green.

Worktree note: `herdr worktree create` auto-opens a workspace, which plan-time
inspection rejects. Create the branch, `herdr worktree remove` it, then a plain
`git worktree add <path> <branch>` registers it with Herdr without an open
workspace. An upstream `--no-open` flag request is tracked in the progress log.
