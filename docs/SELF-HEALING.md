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
| The supervisor's heartbeat older than 2 minutes (it died or hung) | Every plugin hook (`supervisor-keepalive.mjs`), which also relaunches it when no live process holds its lease | The heartbeat and the lease owner |
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

- Register once from its pane with `baa-ton operator register lane-admin --resume`. That records its Claude Code session and the command that resumes it (`--resume-command "<command>"` sets the command explicitly, for example to keep a permission mode).
- Never idle while its operator inbox holds an unhandled anomaly. Each one gets a fix, tests, a merge by branch name, and an entry below.
- **Continuity:** Claude Code compacts its own session, so nothing is relaunched for context size. lane-admin keeps a handoff file in its scratchpad (role, open anomalies, branch, what's next) and updates it after each merge, so a compaction or a restart loses nothing.
- **Dead-pane fallback** (`packages/controller/agent-revive.mjs`): when a pane registered with a resume command has no agent left, the supervisor types `cd <folder> && <resume command>` into it. "No agent left" means the shell is the only foreground process there, or, when process info is unavailable, Herdr reports no agent. Safeguards:
  - the pane must look dead on two checks at least 30 seconds apart;
  - relaunches are at least 10 minutes apart, at most 3 an hour, and the count survives supervisor restarts;
  - each relaunch is reported as an `agent-relaunched` anomaly (so the resumed session sees it and looks for the cause);
  - when the hour's budget runs out, the user gets one notice.

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
| 2026-09-26 | Four done lanes held every slot for hours: their language server's tsserver typings installer counted as background work, and one lane's hung test run counted forever | A helper's whole process subtree is tooling, not work; background work over 60 min with the agent idle no longer defers the receipt ask |
| 2026-09-26 | A dead lane-admin session needed a person to restart it | Dead-pane fallback: the supervisor resumes a registered agent in its pane |
| 2026-09-26 | Ten finished spec lanes (dispatch "failed" though an agent started, operator-closed workflows still holding an agent, lanes whose item moved on) were never retired: none had a receipt | The driver retires a spec lane no item maps once it started 10 min ago and its agent is not working or blocked; auto-retire also runs after every driver pass |
| 2026-09-26 | A baseline lane that could not start ("Claude native session reference missing") could exhaust the baseline | A lane that never started is infrastructure: no attempt counted, a fresh lane after a backoff |
| 2026-09-26 | Verify lanes retyped their worktree path with a typo and stopped at permission prompts; five started dev stacks at once | Every lane contract names its working directory and says to use it; verify lanes that run the app take turns (`defaults.maxDevStacks`, default 1) |
| 2026-09-26 | A new stage inherited the last lane's receipt bookkeeping (pointed ask, inference), so a working review lane was reported receipt-missing | Receipt and background fields are cleared when an item changes stage; older records are cleaned on the next pass |
| 2026-09-26 | A verify lane stopped on `tail -100 /tmp/backend.log` and nothing answered; lane-admin's own rebase in its worktree was not recognized | Read-only commands (and Read/Grep/Glob) on the worktree, /tmp and scratch are known-safe and approved at once, never credential files; a rebase of the own feature branch (a leading cd into a worktree of the same repository included) is known-safe |
| 2026-09-26 | The supervisor and its launcher died silently for 1.5 h: no deploys, no spec host, no nudges, no anomalies; Herdr reruns the startup command only at its own start | Both processes log crashes, signals and exit codes to supervisor.log and survive a closed stderr and a hangup; the launcher restarts a crashed runner; every plugin hook checks the supervisor's heartbeat and relaunches it detached when it is over 2 min old and no live process holds the lease (a supervisor-down anomaly either way) |
| 2026-09-26 | The demo requirement stalled the run: verified items with missing or invalid evidence got no lane, and six items failed review for evidence that only the verify stage can produce | An evidence failure dispatches a demo lane (told what was wrong, after a backoff), never terminal; reviews judge the code, not the demo; review-failed items with evidence in the findings get one fresh review |
| 2026-09-26 | An item was held "human-gate" for changes outside its owns | They are saved as a patch in the state folder and restored to HEAD; the item carries on and the root is told where the patch is |
| 2026-09-26 | receipt-missing fired for a failed item | Failed, done and held items are never judged for receipts |
| 2026-09-26 | Self-update refused commits for one failing test it could not name (only the last 1,500 characters were kept), an MCP bridge test that timed out a fake herdr call under load | Self-update records every `not ok` block and names the failing tests in its log and anomaly; the test runner gives herdr commands 120 s (production keeps 35 s) |
| 2026-09-26 | Doctor's lane-bridge-liveness failed on two root-dispatched lanes whose dispatch failed, gone without a receipt | The driver retires any lane of a dispatch-failed workflow once its agent is gone, recording that it never started |
| 2026-09-26 | A demo lane stopped at a permission prompt on its own demo-report.mjs command (a multi-line command with backslash continuations) | The installed demo recorder writing --steps/--out inside the worktree or scratch is known-safe; backslash continuations are read as one line; the demo contract says to write the command on one line |
| 2026-09-26 | A demo lane sat at Claude's "backslash-escaped whitespace" prompt twice and the blocked handler never ran: that check leaves the pane "working", so no blocked event ever fired | The supervisor sweeps working lanes' screens once a minute and handles a prompt it finds like a blocked lane (the screen fingerprint is the proof); a leading lone backslash line is joined; `node <session scratchpad>/*.mjs` is known-safe; lane contracts forbid backslash-continued commands |
| 2026-09-26 | Fifteen root-dispatched lanes of completed workflows kept their panes' records forever: their receipts were never delivered, and auto-retire takes delivered receipts only | The driver retires a completed workflow's lane with its receipt recorded once its agent is gone |
