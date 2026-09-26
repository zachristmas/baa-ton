# Self-healing

The loop reports its own bugs. The supervisor turns what it sees going wrong into anomalies with evidence and sends each one to the registered agent `lane-admin`. lane-admin fixes it, tests it and merges it by branch name, and self-update deploys it. Nobody watching panes should be the first to notice a problem.

## Anomalies

| Anomaly | Detected by | Evidence sent |
| --- | --- | --- |
| No lane working for 20 minutes while spec items remain | The supervisor tick, from the spec items' own lanes | The spec's waiting counts |
| The same root alert raised 3 or more times in 6 hours, while its item (if any) is still blocked | The supervisor tick, from the root's alerts | The alert text (this is a decision, so the root gets it too) |
| A blocked lane the handler did nothing about (`none` or `skipped`) | The `pane.agent_status_changed` hook | Pane id, reason, the last 30 screen lines |
| A lane still without a receipt 30 minutes after the driver's pointed ask | The supervisor tick, from `spec-state.json` | Item state, whether inference was requested |
| A self-update commit that failed `npm test` 3 times | The self-updater | The last 30 lines of the test output |
| A root reload not confirmed after 5 attempts, or a root busy 30 minutes past a due reload | The self-updater | The runtime record's commit and the checkout's |
| A root turn of 30 minutes or longer (interrupted with Escape) | The supervisor's root turn watch | The root and its manifest |

## Routing

- **Record:** each anomaly is recorded in the operator store under its signature (`anomalies`).
- **First occurrence:** it becomes one operator message to `lane-admin`, labelled `[Baa-ton anomaly: <kind>]` and carrying the evidence and the reply command. Repeats are deduplicated while it is unfixed.
- **Recurrence:** lane-admin replies to the message once the fix is merged. If the same signature comes back after that reply, it counts as a failed fix and a new message goes out.
- **The user:** after 2 failed fixes, the user gets one notification, worded as a bug report ("no action needed"). A stall notification is a bug report too, not a request to act.
- **Decisions:** an anomaly that is a decision rather than a bug also goes to the root, under the escalation policy.

## Escalation policy

- **The user is asked only about unclear requirements.** Questions are tagged `[unclear-requirements]`; scope questions count as requirements. Production and deploys also stay with a person.
- **Everything else has a policy default and is decided and logged**, never parked:
  - a root question gets its Recommended option, or the first option when none is marked;
  - lane prompts get the unattended policy;
  - declines, idle lanes and infrastructure errors get the driver's retry ladder.
- **Pushes of green work are pre-approved** (the `spec-push` grant).

## lane-admin's contract

- Register once with `baa-ton operator register lane-admin` from its pane.
- Never idle while its operator inbox holds an unhandled anomaly. Each one gets a fix, tests, a merge by branch name, and an entry below.
- **Continuity:** when its context passes about 80%, write a handoff file (open anomalies, branch, what's next) in its scratchpad. Then it must be started fresh, re-register, and resume from the handoff and `baa-ton inbox`.
- The fresh start needs something outside the session to relaunch it (an operator or a supervisor action). That relaunch is not automated yet.

## Fixed anomalies

| When | Anomaly | Fix |
| --- | --- | --- |
| 2026-09-26 | Lanes in their worktree's own workspace failed startup attestation | #102: the SessionStart hook checks the lane workspace |
| 2026-09-26 | `herdr_complete` from those lanes failed (cross-workspace inbox envelope) | #105: the bridge skips the inbox for cross-workspace routes |
| 2026-09-26 | Verify contended with integration for one worktree | #101: verify in its own detached worktree |
| 2026-09-26 | Items exhausted by infrastructure errors | #103: infrastructure failures never count; re-armed on deploy |
| 2026-09-26 | Root reload not taking effect; self-update never ran | #91, #97, #100 |
| 2026-09-26 | Self-update refused a green commit: the suite timed out while starting a process took 15-55s | Self-update waits while spawns are slow and retries a red run up to 3 times |
| 2026-09-26 | A root reload was never retried: the root stayed working for hours | A root busy 30 min past a due reload is reported as an anomaly |
| 2026-09-26 | A repeated-alert anomaly fired for an item that had moved on (the alert list is history) | Repeats count only alerts from the last 6 h whose item is still blocked |
| 2026-09-26 | Every root /reload killed the spec driver: the timer kept the old instance's context, which went stale | The timer restarts on session_start(reload) and on turn boundaries, stops on a stale context, and logs that it is alive every 10 min |
| 2026-09-26 | The spec driver went silent for hours while the root sat in one multi-hour turn and never reloaded | The driver runs in a supervisor-owned spec host; root turns over 30 min are interrupted; the root contract forbids lane work |
