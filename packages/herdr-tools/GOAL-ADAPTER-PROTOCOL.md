# Controller-owned parent-goal protocol

## Purpose

Herdr owns the durable parent-goal record and lane lifecycle in the primary manifest's optional `parentGoal` field. The record is intentionally thin: objective, state, next action, deduplicated lane-event signals, and an optional durable supervisor. A registered root harness continues authorized safe local work when the controller delivers an actionable event or configured supervisor nudge, until a real wait, blocker, pause, or completion boundary. Children never interact with the user directly.

## Registration

A root registration contains a fixed allowlisted adapter identifier, harness kind, and verified capability evidence. The controller validates the identifier and capability shape; it never executes caller-supplied shell strings. Unsupported, ambiguous, or stale evidence fails closed and is recorded for the parent.

## Event delivery

For a deduplicated actionable lane event (`done`, `blocked`, `goal-paused`, or a persisted child question/confirmation):

1. Controller atomically records the event and marks delivery `sending`.
2. It verifies the live root identity.
3. It sends one native, non-waiting root prompt carrying the event envelope.
4. The root uses the durable goal/workflow record to decide the next allowed operation.
5. Controller marks `delivered`; unavailable roots retain `pending` and retry only on an identical later hook.

## Supervisor wake protocol

The supervisor is a **repeating nudge while work waits on the root**. It exists so a root cannot park itself out of supervision: it keeps nudging, once per interval, for as long as there is actionable work and the goal is not deliberately quiet.

- **When it stays quiet:**
  - the goal is `completed` or `paused`, or the supervisor is `stopped`/`paused`;
  - the goal is `action-required` while Zach actually owes an answer: an open parent question (`parent-question-required`) or approval (`parent-approval-required`) for this root. An open ask dialog shows as Herdr `blocked`, which vetoes delivery below.
- **When it nudges:** every other status (`active`, `waiting-for-event`, `review-requested`, `blocked`, and `action-required` with nothing pending for Zach), but only when there is actionable work:
  - an open lane request, including a lease ask, from a lane whose latest recorded event is not `working`;
  - a child message still `pending` or `uncertain`;
  - a workflow `planned` but not dispatched;
  - a pending queue item;
  - an open directive.
- **What the nudge says:** it names each waiting item, with request, message, workflow and directive IDs, and asks the root to handle them or record a truthful goal state. There is no "observational only" wording.
- **Idle-only delivery (unchanged):**
  - An overdue `nextNudgeAt` and an identity-matched `rootTurn.state: idle` written by the root Pi extension are required.
  - Live Herdr identity and `idle`/`done` readiness are checked again before sending (`done` is Herdr's unseen ready state). A root that is `working` or `blocked` is never prompted, and a due nudge never lands mid-turn; it waits for the next settled turn.
  - `before_agent_start`/`agent_start` persist `rootTurn: active`, including a run ID and root pane/workspace binding. Every tool and model turn, automatic retry, compaction retry and queued continuation stays inside that active run.
  - Only `agent_settled` with `ctx.isIdle()` and the matching active run may persist idle. `tool_execution_end`, `turn_end`, `agent_end` and Herdr `pane.agent_status_changed` hooks do **not** grant idle authority, and silence never expires an active run into idle.
  - Startup, reload and shutdown invalidate idle authority to `unknown`. Missing lifecycle evidence (older Pi without `agent_settled`, non-Pi/MCP-only roots) fails closed for nudges.
- **Cadence:**
  - Each outcome (delivered, pending, or uncertain) schedules the next nudge one full interval later.
  - After a delivered or uncertain send, including legacy one-shot records, no nudge comes sooner than `lastDelivery.attemptedAt + intervalSeconds`, whatever `nextNudgeAt` says.
  - A digest delivered on the same tick counts as that interval's wake. A digest still collecting updates suppresses the nudge, because it is about to wake the root.
  - A running goal with no schedule gets one, starting one interval from now.
- **Send safety (unchanged):**
  - Before prompting, the controller durably writes `lastDelivery: sending` under the shared manifest lock.
  - An interrupted `sending` record becomes `uncertain` and is never replayed. The next nudge is a new one, a full interval later.
- **Interval:**
  - The default is 300 s and is still configurable per goal (`nudgeIntervalSeconds`, 5-86400); a newer extension records the choice as `nudgeIntervalPolicy: 2` in this root's `rootSupervision` entry. It is never stored inside the supervisor, because older bridges validate supervisor keys strictly.
  - Goals written before this policy have no marker. The controller lowers an interval above 300 s to 300 once, pulls `nextNudgeAt` in accordingly and records the marker. Goals with the marker keep their chosen interval.
  - Pre-upgrade extensions drop unknown top-level keys when they save, so the marker can be lost. The only effect is that an interval deliberately set above 300 s is capped to 300 again.
  - The key `supervisor.intervalPolicy`, briefly written by #28, is removed from every goal copy on load by the extension and on each tick by the controller.
- **Goal-state writes:** `set-state` to `blocked` no longer stops the supervisor; only `completed` does, and `pause` still clears the due time. A material `set-state` change reschedules the next nudge for any status other than `completed` or `paused`. Identical `set-state` and repeated `start` on a running supervisor are idempotent.

Lifecycle writes use the existing sibling manifest lock and atomic rename. They wait at most 10 seconds for lock contention, without polling agents or starting background jobs. Failure to persist active authority aborts the Pi run rather than silently continuing with stale idle evidence. A failed idle write leaves supervision suppressed.

### Rollout and limits

Update the controller and reload the root extension together, controller first; this source change does not install, enable, or reload either live component. Lanes dispatched earlier keep their old bridges, so parent goals must stay valid under the oldest supported release's strict validators (see `docs/ARCHITECTURE.md`, forward-compatible manifests). After reload a real root run must settle before recovery nudges become eligible. A crashed run does not become idle on a timeout; restart plus fresh lifecycle evidence is required, and uncertain sends still require explicit review.

The native `agent.prompt` transport is not an atomic compare-and-submit against Pi lifecycle or editor contents. The final live readiness check, the idle-only gate and the one-interval floor after each send limit interruption, but cannot eliminate the narrow race with a newly submitted user turn or protect unsent editor text. A draft-safe conditional prompt API would be needed for that stronger guarantee. A prompt already submitted before pause cannot be recalled.

## Parent mediation

Children persist full question, confirmation, dispatch, resume, and close approval records in the workflow manifest. They return without presenting UI. The controller wakes only the root; root-only UI resolves the durable record.

## Display metadata

A root may publish display-only goal metadata with native Herdr `pane report-metadata`.
The optional Baa-ton sidebar adapter renders the `herdr_goal_*` tokens in an
expanded desktop sidebar without modifying other renderers' source. Compact and
mobile switchers do not render custom sidebar rows, so Baa-ton also publishes a
concise `idle`/`done` state label (for example, `Goal: waiting`). This is a
presentation fallback only: it never changes a pane's semantic state,
notifications, supervision, or lifecycle decisions.

## Proof requirements

For every enabled adapter: controlled lane completion wakes one root turn; repeated events dedupe; unavailable roots create durable `pending`; replay delivers once; child question and confirmation remain parent-mediated; malformed capabilities fail closed. Non-enabled adapters retain normal controller notification behavior only.
