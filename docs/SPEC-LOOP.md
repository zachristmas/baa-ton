# Baa-ton spec loop: run until the spec is met

Status: design, 2026-09-24. Author: Ink, for Zach. Builder: lane-admin.

Examples below are illustrative. They describe a multi-day run against a real project, with its identifiers removed.

## Goal

Run Baa-ton and Herdr in a loop until a written spec is met, asking the user only for real decisions and pushes. The first spec is a readiness checklist of about 30 items for a pull request. An item is done when its code is merged into the target pull request's branch and an evidence report proves it.

## What a multi-day run showed

1. **The goal forbade its own finish line.** The parent goal said "no commit, push, merge, or deploy", and every lane contract says never push, merge or create a PR. After three days, about 20 worktrees and 17 local evidence reports existed, and the target branch tip was still the commit every lane started from. No item had been integrated.
2. **"Done" was the LLM's opinion.** The spec was prose in a markdown table. Each turn the root re-read it and decided what was done, so it re-argued, re-asked and parked. The burn-down had to be counted by hand.
3. **The loop driver was an LLM that stops.** In one afternoon the root:
   - parked on stale records;
   - chose on its own to dispatch one lane at a time while most of the machine's memory sat free;
   - asked a person three times for one lane's frozen install, dependency build and unit tests;
   - set itself to `waiting-for-event` with nothing pending.
   Supervisor nudges help, but the root still decides whether to act.
4. **Decisions arrived mid-build, one at a time.** One item stopped four times in a day: for its migration slot, a file overlap, a policy question and test admission.
5. **Conflicts between items were found late.** A migration chain with one misordered number, shared source files, and a build cache shared across worktrees all surfaced mid-lane.
6. **Lanes graded their own work.** The `review` profile exists, but no stage used it.
7. **Resources and cost were unmanaged.**
   - Service stacks outlived their lanes (several GB idle) and tripped the capacity gate.
   - Every lane ran a frontier model at high effort in one long session; contexts reached hundreds of thousands of tokens.
   - There was no cost-per-item figure, so a subscription's usage was spent without finishing.

## Design

### 1. Spec file: the single source of truth

`.baa-ton/spec.json` (validated by a schema, strict). Names, paths and commands in this example are illustrative:

```jsonc
{
  "version": 1,
  "target": {
    "repo": "~/src/example-app",
    "remote": "origin",
    "branch": "feature/example-release",
    "preview": { "url": "https://preview.example.test", "releaseCheck": "https://preview.example.test/api/version" }
  },
  "defaults": { "maxParallel": 4, "maxBuildAttempts": 3 },
  "stages": {
    "decide":    { "profile": "planning" },
    "build":     { "profile": "implementation" },
    "review":    { "profile": "review", "differentFrom": "build" },
    "integrate": { "profile": "balanced" },
    "verify":    { "profile": "quick" }
  },
  "items": [{
    "id": "I10",
    "title": "Example feature: a discount that applies to shipping only",
    "dependsOn": ["I08"],
    "owns": ["services/orders/src/features/shipping-discount/**", "apps/admin/src/features/shipping-discount/**"],
    "sharedTouch": ["services/orders/src/features/checkout/**"],
    "migrations": 1,
    "decisions": ["board:I10", "board:Q2"],
    "acceptance": {
      "text": "Checkout reduces shipping only, never below zero; ...",
      "tests": ["npm test --workspace services/orders"],
      "preview": ["tests/e2e/i10-shipping-discount.spec.ts"],
      "evidence": { "report": "artifacts/i10/evidence.docx", "minImages": 4 }
    }
  }]
}
```

- **Import once.** A one-time `herdr_spec import` step (LLM-assisted, reviewed by the user) turns the project's workboard into this file. After that the spec is canonical; the board keeps its prose and decisions, and links each row by item id.
- **Decisions are data.** `decisions` points at the board rows a lane must read, so lanes stop re-asking what is already decided.

### 2. Item state machine

`pending → deciding → ready → building → reviewing → integrating → verifying → done`

There is also `blocked{reason: decision | dependency | capacity | human-gate}` and `failed{attempts}`. Transitions are recorded durably with their evidence (receipt ids, commit SHAs, report hashes), the same way workflows record events today. Only the loop driver moves an item; a lane's receipt is an input to that, not a verdict.

### 3. Verifier: a deterministic exit test (no LLM)

`herdr_spec verify` (also a CLI) checks each item and prints `N/M done` plus the first failing check for each item:

1. The evidence report exists, has at least `minImages` inline images, and its hash matches the recorded one.
2. The item's integrated commit is an ancestor of `target.remote/target.branch`.
3. Its `tests` were recorded green at the integrated target SHA.
4. Its `preview` specs passed against the preview once the release check reports that SHA or a later one.

This is both the loop's exit condition and the burn-down: the loop stops when it reports M/M. No stage sets `done` directly; only the verifier does.

### 4. Loop driver: code drives the loop, and the root advises

Each supervisor tick computes ready actions deterministically:

- A **ready** item has all `dependsOn` items at `integrating` or later. Its `owns` must not overlap any in-flight builder's `owns`, and its `sharedTouch` must not overlap one either.
- It is dispatched to its stage's profile when `maxParallel` and the live capacity gate allow.
- When a lane files its receipt, the driver advances the state and dispatches the next stage, with a fresh lane per stage (small context, no very long sessions).
- The root LLM is prompted only for judgment:
  - the decide stage's leftover questions;
  - a review rejection that needs triage;
  - an item that hits `maxBuildAttempts`.
- The root cannot choose to serialize, and it cannot park the loop. "Waiting" is a computed state with a named reason, shown in `herdr_spec status`.

### 5. Stages

| Stage | Who | Does | Output |
| --- | --- | --- | --- |
| decide | planning profile, read-only | Reads the item, the linked decisions, meeting notes and scope rules. Answers what those settle and lists the rest. The leftovers from all items are batched into one question round for the user. | Decision record, confirmed `owns`, migration count |
| build | implementation profile, own worktree **from the current target tip** | Implements the change with leases and the local-validation grant (install, build, codegen, tests, lane DB and services, browser tests). Commits on `spec/<id>`. | Commit SHA, local evidence report, receipt |
| review | review profile on a **different model or harness** than the builder | Read-only review of the diff against acceptance and evidence. Pass or fail with findings. | Verdict; a fail sends the item back to build with the findings |
| integrate | one serial integration queue | Merges `spec/<id>` onto the integration branch (target tip plus already-integrated items) in dependency order. Renumbers migrations from the sequence lease, runs the full suite, commits. | Integration SHA, suite result |
| push (human gate) | the user | One batched prompt: "Push N integrated items (list) to the target branch?" | Push to `target.branch` |
| verify | quick profile | Waits for the preview release check to report the pushed SHA, runs the item's `preview` specs against the preview, and writes the final evidence report at that SHA. | Final report; the verifier marks the item done |

### 6. Ownership and ordering

- **Overlapping writers.** The driver refuses to run two builders whose `owns` overlap. `sharedTouch` edits are held until the owner item has been integrated.
- **Migration numbers.** Numbers become a new lease kind, `sequence`, which reserves a slot at build time. The integrator assigns the final number in integration order, so re-chaining migrations happens mechanically, not by message.
- **Shared build caches.** Builds always bypass or isolate caches that are shared across worktrees (for example a per-worktree cache directory).

### 7. Policy

Add grants to `approvalPolicy`:

- **`local-validation`:** install `--frozen-lockfile`, builds, codegen, typecheck, lint, tests, and DB, services and browser tests inside the lane's leases.
- **`integrate`:** local commits and merges into the integration branch.

Push to the target, deploy, production, shared DBs, and package or lockfile edits stay human-gated. The push gate is batched per integration round.

### 8. Resources and cost

- **Service lifecycle.** Services started for a lane are registered to it and stopped at the end of its stage and on retire. The capacity digest names idle stacks owned by finished lanes.
- **Right-sized models.** Per-stage profiles let small builds run on cheap models while review stays on a frontier model.
- **Cost report.** Record turns and token usage per lane from the harness transcript, and roll them up per item in `herdr_spec status`, so cost per item is visible.

### 9. Visibility

`herdr_spec status` prints one table: item, stage, lane or pane, age, and blocker (with its reason). Every root digest starts with the verifier line, e.g. `spec 11/29 done · 4 building · 2 reviewing · 1 awaiting push · 3 blocked(decision)`.

## Human touchpoints

Two, both batched:

1. decision rounds from the decide stage;
2. push rounds to the target branch.

Everything else runs under policy.

## Build plan (one PR each; unit tests with fakes, `npm test` green)

1. **Spec schema, verifier and `herdr_spec status`.** Read-only and useful right away as the real burn-down.
2. **State machine and dispatch** for the build and review stages, including the `differentFrom` review rule and a fresh lane per stage.
3. **Integration queue**, `sequence` leases for migration numbers, the `integrate` grant and the batched push gate.
4. **Decide stage** and batched decision rounds.
5. **Preview verification** (release-check wait, preview browser-test run, final evidence report).
6. The **`local-validation` grant** and **service lifecycle** already queued with lane-admin fold into PRs 2-3.

## Moving a running project onto it

1. Import the spec items. Items with a local evidence report and no review become `reviewing`; the rest follow their board status.
2. Start the integration queue on reviewed items first, so the target branch starts to move. Re-base builds onto the target tip at integration time.
3. Replace any "no commit, push, merge, or deploy" wording in the parent goal with the policy above; lane contracts get the stage-specific rule.

## Implementation notes (lane-admin, against the current code)

These refine the design where it meets existing invariants:

1. **The loop driver runs in the root's extension, not the controller.** The controller never dispatches: it has no harness adapters, no root identity proof and no Pi context. The deterministic driver runs on every settled root turn (the same mechanism auto-retire uses), and the controller computes ready actions and wakes the root when there are any. It is still code, not the LLM, that decides and dispatches.
2. **Automatic local Git actions are an explicit grant.** The integrate stage's merges and commits, and worktree creation from the target tip, are exceptions to ARCHITECTURE invariant 4. The `integrate` grant is that exception, and the invariant text is amended to say so. Push, deploy and production stay excluded.
3. **Item state lives in a side file** (`.baa-ton/herdr-orchestrator/spec-state.json`, written under the manifest lock), not a new top-level manifest key. Pre-upgrade manifest writers drop top-level keys they don't know (ARCHITECTURE invariant 7).
4. **New verifier inputs.** Test results at the integrated SHA need a durable record (written by the build and integrate stages), and `minImages` needs .docx parsing (the zip's `word/media` entries), with no new dependencies.

## Build status

- **PR 1 (built):** `packages/herdr-tools/spec.mjs` validates `.baa-ton/spec.json` strictly (unknown keys, duplicate ids, unknown or cyclic dependencies, paths outside the repo and bad stage references are rejected). It reads item state from `.baa-ton/herdr-orchestrator/spec-state.json` and verifies each item in order:
  1. the evidence report: it exists, has `minImages` images (counted from the .docx `word/media/` entries without a zip dependency, or image references in Markdown/HTML), and its SHA-256 matches `evidence.sha256`;
  2. `integratedSha` is an ancestor of `refs/remotes/<remote>/<branch>` (no fetch; the verifier reads the local ref);
  3. each acceptance test has a `pass` recorded at `integratedSha`;
  4. each preview spec has a `pass` recorded on a `releaseSha` that contains `integratedSha`.

  `herdr_spec action=status|verify` and `node packages/herdr-tools/spec.mjs status|verify [project]` print the same verdict; `verify` exits 0 only at M/M. A recorded `done` that the verifier rejects is shown as `verifying`. Nothing writes the state file yet; the stages that do come in PR 2 onward.

- **PR 2 (built):** the state machine (`packages/herdr-tools/spec-driver.mjs`, pure) and its driver in the extension, run on every settled root turn and by `herdr_spec action=advance`.
  - **Readiness:** an item is ready when its dependencies are integrating or later. It builds while fewer than `maxParallel` items are in flight, the root has no capacity gate waiting, and its `owns`/`sharedTouch` don't overlap an in-flight builder's `owns` (a conservative static-prefix glob test). Otherwise it waits with a named reason (dependency, capacity, ownership), shown in `herdr_spec status`.
  - **Build:** the driver creates `spec/<id>` in a worktree from the local `<remote>/<branch>` ref under `~/.herdr/worktrees/<repo>/spec-<id>` (reused by rebuilds). It plans one lane with the build stage's profile and dispatches it under the standing policy, headless, so an out-of-policy dispatch waits instead of opening a dialog.
  - **Review:** the build lane's receipt starts a review: a fresh read-only lane in the same worktree on the review profile. If `differentFrom` names a stage whose profile has the same provider and model, the item is blocked (human-gate) and the root is asked.
  - **Verdict:** the review receipt's first line must be `VERDICT: PASS` or `VERDICT: FAIL`. PASS moves the item to `integrating` (PR 3). FAIL rebuilds with the findings until `maxBuildAttempts`, then the item fails and the root is asked. An unclear verdict, or a lane that ends without a receipt, is handled the same way.
  - **Root asks** go into the root's digest as `spec-needs-root` alerts.
  - **Grants:** the driver acts only when the acknowledged policy grants `dispatch` and the new `integrate` grant. `integrate` is the ARCHITECTURE invariant 4 exception for these local worktrees (and, in PR 3, integration merges). It is appended last, so existing policies keep their hash.
  - **Not verified live:** that Herdr's `worktree list` registers a worktree created with `git worktree add`, which `herdr_plan` requires.

- **PR 3 (built):** the integration queue, `sequence` leases and the batched push gate.
  - **Queue:** a reviewed item waits in `integrating`. One integration lane at a time, in dependency order, runs on the integrate stage's profile (default `balanced`) in `~/.herdr/worktrees/<repo>/spec-integration` on branch `spec-integration`, created from the target tip.
  - **The lane's job:** merge `spec/<id>` (`--no-ff`), renumber colliding migrations in integration order, run `target.suite` and the item's tests, commit, and never push. Its receipt starts with `INTEGRATED: <40-char SHA>` and `SUITE: pass|fail`.
  - **Lane rules:** it is the only lane whose contract allows local merges, and only its Claude settings drop the `git merge` deny. Push, PR and the rest stay denied. The stage is set by the driver through `specStage`, which `herdr_plan` does not accept.
  - **Outcomes:**
    - A pass moves the item to `awaiting-push` and records its tests green at that SHA.
    - A failed suite rebuilds the item, with rebase-and-fix findings, as a build attempt.
    - An unclear receipt goes to the root.
    - A lost integration lane is retried without counting an attempt.
  - **Sequence leases:** the `sequence` lease kind (`{ kind: "sequence", start, digits }`) hands out the lowest free number (for example `migration = 0056`). A retire does not release it. The driver releases an item's reservations once the item is integrated.
  - **Push gate:** as soon as items are ready (`defaults.pushGate: "round"`, the default; `"item"` asks per item), one `spec-push-ready` alert offers them. It doesn't wait for the rest of the queue: the push goes to the last ready item's integration commit, so items still integrating (or stuck) never ride along or hold the others back. Each new head is offered once. The alert names the items and the exact `git push <remote> <sha>:refs/heads/<branch>` for the root to run after the user approves; under the `spec-push` grant the driver runs it. Items move to `verifying` (with `integratedSha`) once `refs/remotes/<remote>/<branch>` contains their SHA.

- **PR 4 (built):** the decide stage and batched decision rounds. With `stages.decide` configured, every item first gets a read-only decide lane in the project (profile default `planning`). The lane reads the item, its linked decisions and the scope rules, answers what they settle, and reports each leftover as a `QUESTION:` line, plus `OWNS:` and `MIGRATIONS:` when the build's files or migration count differ from the spec.
  - An item with no questions goes straight to the build queue. `OWNS:` replaces the item's `owns` for the overlap check.
  - Items with questions are `blocked(decision)`. Once no decide lane is running, all of their questions go to the root in one `spec-decisions` alert, to be asked in a single round.
  - The root records each item's answers with `herdr_spec action=answer itemId=<id> text=<answers>`. The item then builds, with the decide record and the answers in its lane objective.
  - Without `stages.decide`, items skip the stage as before.

- **PR 5 (built):** preview verification.
  - **Waiting for the deploy:** a pushed item (`verifying`, with `integratedSha`) that has preview specs waits until `target.preview.releaseCheck` reports a deployed SHA containing its commit. That's one GET per driver pass; the SHA is read from a JSON field (`sha`, `commit`, `gitSha`, `revision`, `version`, including nested `build`/`git`/`release`) or the first SHA in a text body. A `maxParallel` slot is held only by a live lane (or a building/reviewing item whose dispatch is being retried). Items queued for the serial integration lane, and verifying items waiting for a deploy, hold none.
  - **Verify lane:** runs on the verify stage's profile (default `quick`) in the integration worktree. It runs the item's preview specs against `target.preview.url`, writes the final evidence report, and reports `PREVIEW: <spec> pass|fail` lines and `REPORT: <path>`. By default the final report sits alongside the build lane's (`<name>.final.<ext>`); with `defaults.finalReport: "replace"` it uses the spec's path. Both options exist because this was open question 3.
  - **Recording:** the driver records the preview runs (with the release SHA) and the report's path, SHA-256 and image count. The verifier then decides: only a pass moves the item to `done`.
  - **Failures:** a failed or missing preview run blocks the item (human-gate) and asks the root whether to fix forward. An item with no preview specs and no evidence report goes straight to the verifier after the push.
  - **Digest line:** every root digest now starts with the burn-down line (`spec N/M done · 2 building · 1 awaiting-push · 1 blocked(decision)`), computed by the controller from `spec.json` and `spec-state.json`.
  - **Not verified live:** the release-check formats beyond these parsers; a real preview run.

## When the driver runs

A root can stay in one LLM turn for many minutes, so the driver doesn't wait for turns. The root's extension runs it:

- every 25 seconds while the root session is up;
- 2 seconds after `manifest.json` changes, which is where lane receipts and statuses land;
- when a turn settles, as before.

Passes never overlap: a trigger during a pass leaves exactly one follow-up pass. A pass that throws backs the timer off, doubling up to 5 minutes. `maxParallel`, the capacity gate, the live memory floor and the shell-timeout backoff all apply inside every pass. Each pass that started something, needed the root, or changed its skip reason is appended to `.baa-ton/herdr-orchestrator/spec-driver.log`. The driver opens no dialog and uses no LLM, so a pass mid-turn is safe.

## Unattended operation

The loop runs with nobody watching panes. Every path by which a lane or the root could wait on a person, and what resolves it:

| Waiting on | Resolved by |
| --- | --- |
| A lane's permission prompt for a known-safe command: temp-file removal, `rmdir`, a folder the same command recreates with `mkdir`, a file created with `>`, `2>` or `&>` (not `>>`), own-branch create or reset, a discard after a scratch patch, a generated-artifact revert, the lane-admin PR flow | The lane's PermissionRequest hook approves it at once (`known-safe.mjs`). |
| (Safety) a digest, wake, root message or answer typed while the agent is gone | Every sender re-checks right before typing. `agent get` must show the expected agent, live and ready, and the pane's foreground must not be only its shell (Herdr can keep an agent record briefly after the agent exits). Otherwise the item stays pending. Nothing is ever typed into a raw shell. |
| A known-safe step inside a longer command (greps, builds, `cd`) | Segments are split only outside quotes. In `bypassPermissions` and `auto` mode (lanes run in `auto`), the hook checks only the segments that match the session's Bash `ask` rules (user and project settings), because in those modes they are what forces the prompt. A command with no ask-rule segment defers, since its prompt has another cause. Other modes still classify the whole command, and any command substitution still defers. |
| (Resources) idle sessions piling up after their receipts | Under an acknowledged `retire` grant, each driver pass retires every spec lane whose receipt the driver has consumed (no item points at it any more): it closes the lane's tab, ending its session, and releases its leases. Sequence numbers stay held until integration. |
| A lane idle while its own background suite, build or monitor still runs | Each pass reads the pane's process tree (`herdr pane process-info`, then `ps`; never the transcript). Any descendant of the agent that is not a long-lived helper (MCP bridge, language server, permission hook, `caffeinate`, a bare shell wrapper) counts as work. While it runs, the lane is not asked for a receipt, a pending ask is withdrawn, the item is not blocked, and the lane keeps its worktree reserved. When the work ends, the usual receipt ask resumes. |
| A prompt left on a lane's screen (the hook was unavailable, or an agent without one) | The controller's `pane.agent_status_changed` hook fires when the lane turns `blocked`. It reads only that pane's visible screen (30 lines), plus at most the last 256 KB of the lane's transcript when a command box is truncated, and classifies the prompt. A known-safe permission is approved with `herdr agent send-keys`, right after re-checking that the same agent is still live and blocked and the same prompt is still on screen. Anything else opens a lane request for the root, delivered through the existing digest. The supervisor's tick applies the root's answer as keys: grant approves, deny dismisses, and for a question the option named in the note. With no answer within 10 minutes, it applies the default: the unattended policy for a permission, or the Recommended option for a question (dismissed, with a decide-it-yourself note, when there is none). Each default is recorded in the manifest's `unattendedDecisions` for review. |
| A lane idle without a receipt, its last output asking for direction in plain text | On the lane's `done` event, the controller reads its visible screen once. A question with a direction cue ("which approach do you want?", "should I…?", "let me know") becomes a lane request for the root. The root answers with `herdr_request` grant and the answer in the note, which reaches the lane. With no answer within 10 minutes, the lane is told to decide under its goal rules (its own recommendation, or the most conservative in-scope option) and to say which in its receipt. This is logged in `unattendedDecisions`. The spec driver's receipt ask and its 30-minute escalation remain the backstop. |
| Any other lane permission prompt | Routed to the root as a lane request. A grant or deny reaches the waiting hook. With no answer within 300 s (or no route), the unattended policy decides: allow when the command stays inside the lane's worktree, scratch and `/tmp` with no network, credentials, publishing or system commands; otherwise deny, with a reason the lane can act on. The prompt never falls back to the pane. |

| A Pi lane's `ask_user_question` dialog | The lane never shows it. The extension stores the question for the parent, and the root answers it through the digest (existing child question routing). |
| The root's own `ask_user_question` in an autonomous run (a spec file plus an acknowledged `dispatch` grant) | Handled in-process by the extension, not by screen reading. If every question in the round has exactly one option marked Recommended and nothing in it concerns push, deploy, production or new scope, a 5-minute timer is armed when the dialog opens. If the user has not answered by then, the extension records the answer in `unattendedDecisions` (`reviewed: false`), shows a Herdr notification, ends the open dialog, and gives the root the Recommended answer as a follow-up message. An answer in time disarms the timer. |
| The root's question dialog when Herdr shows the root as working, or when the root runs older extension code with no in-process default (so it is never idle enough to get `/reload`) | The extension reports each open root dialog to Herdr as `blocked` with `pane report-agent`, and releases it when the dialog closes or the turn ends. Independently of the root's own code, the auto-deployed supervisor handles an autonomous run's root dialog. While the root is working or blocked, it reads the root's visible screen at most once every 5 minutes. A question dialog, numbered or a cursor-marked select list with exactly one Recommended option, that is still open after 6 minutes gets that option: arrow keys, then Enter, after re-checking that the same dialog is on screen. The answer is logged in `unattendedDecisions` and notified. Questions about push, deploy, production or new scope are never answered this way; the user is notified once. Once the dialog is answered, the root goes idle and gets `/reload`. |
| A lane idle without a receipt (no question on screen), an unclear receipt, or a lane that never started (startup attestation, shell) | The spec driver asks once for the receipt (a status reply pushes the next ask back). If there is no reply after 30 minutes, the lane climbs the retry ladder shared with declines. An integration whose commits are already on `spec-integration` is recorded as integrated. Anything else gets a fresh lane with the reason in its objective, then the stage's `fallbackProfiles` after `defaults.maxDeclines` tries. A ladder that runs out is held as `blocked(exhausted)` and the root is told. `human-gate` is only for push, deploy, production and scope. Items an older driver held at the human gate for these reasons go back on the ladder. A hold caused only by generated artifacts outside owns resumes on any pass (at most 3 times per code version), and the resumed stage restores them from HEAD. |
| Decide-stage questions the spec cannot settle | They are batched into one `spec-decisions` round for the root. Any question the root itself then opens follows the root-question row above. |
| A lock held by a lane that will never release it: the integration worktree, held by an integrate or verify lane that is done or gone while its item moved on (blocked, failed, re-queued) or its receipt ask escalated | Each driver pass counts a lock only while its owner is live. The owner must be a working or blocked agent, or a lane its item still waits on in that stage. Otherwise the pass reclaims the lock, logs it in the item's history, dispatches the next integration itself, and tells the root once in an alert. The Herdr-side scan also counts only a working or blocked agent; an idle or done agent in the pane holds nothing. |
| The root's goal set to `waiting-for-event` while nothing can send that event | The supervisor nudge treats `waiting-for-event` as a wait only while some lane is working or blocked, or the user owes an answer. Otherwise it nudges on every interval ("no event is coming: this is no progress, not a wait") until the root takes the next action or records a truthful state. |
| A lane that declines its assigned work | Every spec objective tells the lane to decline only through its receipt: `DECLINED: <reason>` (or to do the rest and name the one step it can't do), never by stopping in chat. For review, integrate and verify, plain decline language in a receipt missing the stage's required lines also counts. The driver retries the same stage at once, with the reason quoted in the new objective. After `defaults.maxDeclines` declines (default 2) it switches to the stage's next `spec.stages.<stage>.fallbackProfiles` entry. Only when every configured profile has declined is the item held and the root told. Baseline and fix-baseline lanes are retried with their reason up to 3 times. |
| A prompt on a registered standalone agent (an admin session, an external assistant) | See docs/OPERATOR-MESSAGES.md: the same known-safe approval and bounded defaults, recorded in the operator store and notified. |
| Spec items waiting (awaiting-push, pending, ready, failed, exhausted, or integrating with no lane) while no lane is working | The supervisor nudges any live goal with a `spec:` reason, whatever the goal's status says. After 2 nudges the root didn't act on, the user gets one notification for the episode. An operator pause (the run state) silences it. |
| A green round waiting to be pushed, when push is pre-approved | Under the `spec-push` grant (narrow: fast-forward the spec's own target branch to the green integration head, no force), the driver pushes the round itself, fetches, and notifies. The next pass moves the items to verifying. If the push fails, it falls back to the root's push ask with the error. Without the grant, a push still waits for the root and the user. |
| A queued item merged with rewritten commits (squash, cherry-pick, renumbering), so its branch tip is not on `spec-integration` | The driver finds the item's own `spec(<id>)` commit, or a merge or integrate commit naming it, in `<target>..spec-integration` and records it as integrated there. |
| A baseline or fix-baseline lane idle without its receipt | It is asked once for the receipt with the exact lines, then replaced by a fresh lane after 30 minutes. After 3 idle attempts the baseline is recorded as unknown. |
| An evidence report rewritten by a newer run | If it still meets the item's evidence bar (a readable report with enough images), its hash is re-recorded (logged in history) and verification goes on. One item's evidence never holds other items' push. |
| Verification contending with integration for one worktree (a staged merge there failed every verify dispatch as "worktreeCwd must be clean") | Each pushed item is verified in its own detached worktree, `spec-verify-<id>`, at its pushed commit. It never uses `spec-integration`. Its final report is copied to the state folder (`evidence/<id>/`) when recorded, and the worktree is removed once the item leaves verifying. A fresh integrate lane starts from a clean `spec-integration`: a half-done merge or staged changes left by an earlier lane are saved as a patch (`aborted-integrations/`) and aborted first. Integrate lanes are told to commit or `git merge --abort`, never to leave the branch staged. |
| Push, deploy, production and new scope | These wait for a person by design. The spec driver stops at `awaiting-push`, the root's question defaults never cover them, and lane contracts deny them. The root gets a `spec-push-ready` alert to take to the user. |

Unattended defaults are never silent. Every one is written to the manifest's `unattendedDecisions` with `reviewed: false`, and a root default also sends a notification.

## Adopting a live run

A run that started before the spec loop already has work: worktrees and branches, local commits, evidence reports, reviews, and legacy workflows still running. On an empty `spec-state.json` the driver would rebuild every item and double-dispatch live ones. So a live run is adopted first:

1. Per item, `adopt` in spec.json names what exists: `{ "worktree": "<abs>", "branch": "<name>", "report": "<abs>", "workflow": "<id>", "review": "<id>", "accepted": true }`. All fields are optional. Paths are absolute, because lanes kept worktrees and reports outside the target repo.
2. Run `herdr_spec action=adopt dryRun=true` (or `node packages/herdr-tools/spec.mjs adopt <project> --dry-run`). It prints each item's proposed state, the reason and any warnings (a missing workflow or report, too few images, a FAIL verdict). Then run it without the dry run to write the first `spec-state.json` under the manifest lock. Adopt refuses to replace a state that already tracks items unless `force` is set.
3. **Starting states,** first match wins:
   - `deferred`: the acceptance says deferred and the item owns no files. It's excluded from M.
   - `integrating`: `accepted: true`, or a receipt starting `VERDICT: PASS` on the adopted or review workflow.
   - `building`: the adopted workflow still has a live lane. The item is attached to that lane, so nothing is dispatched twice, and the lane's receipt advances it like a driver-built lane.
   - `reviewing`: a build receipt exists, or the evidence report exists. The driver starts a review lane, honoring `differentFrom`.
   - `pending`: otherwise.
4. The report's path, SHA-256 and image count are recorded at adopt time. The verifier reads a recorded path, even outside the repo.
5. **Adopted branches and worktrees** replace `spec/<id>` for build, review and integration. Before merging an adopted branch, the driver lists the item-owned uncommitted paths in its worktree (all changes when `owns` is empty). It never lists anything matching `*secret*`, `.env*` or `*.lane-secrets.json`, tracked or not. The integration lane commits exactly those paths first and leaves any listed secrets uncommitted.

Fixes from the first dry run on a live run:

- **Shared files:** the commit list for an adopted worktree is the item's `owns` plus `sharedTouch` (migration journals, module and OpenAPI files, generated contracts, shared schema index files, `.gitignore`), staged by explicit path.
- **Refusals:** integration refuses an adopted branch that still has uncommitted changes outside that list (other than secrets; ignored files never appear). The item goes to the root with the file list. An item with no `owns` commits nothing; any uncommitted change sends it to the root instead of sweeping the worktree.
- **Stalled lanes:** a lane Herdr reports `done` with no receipt is asked once, through `herdr_tell`, for its receipt in its stage's format. If nothing comes within 30 minutes, the item goes to the root. A lane whose session is `gone` is retried in the same worktree; a gone build lane counts as an attempt only when its worktree has no uncommitted changes.
- **Resolved by decision:** `adopt.resolved: "<reason>"` records an item settled by a decision with no code (the user resolved it, or it was verified absent) as `resolved`. The verifier counts it as done by decision (`spec 3/30 done (1 by decision)`). Adopting logs it in `spec-state.json` `decisions` and alerts the root and the user, and `herdr_spec action=reopen itemId=<id>` overturns it (also logged).

Reviewing adopted work: adopted worktrees are dirty by design, because their work is uncommitted.

- **Commit before review:** before an adopted item's review, the driver commits that item's own changes on its branch as one commit, `spec <id>: adopt work as built`. It's a local commit under the `integrate` grant, with the same rules as integration: `owns` plus `sharedTouch`, explicit paths only (`git add -- <paths>` and `git commit -- <paths>`), never secrets. The reviewer then reads the branch diff against the target tip.
- **Shared worktrees:** in a worktree shared by several items, each item commits its own paths when its review starts, in spec order. The first item claims a shared file; other items' changes are left for their own commits.
- **Holds:** changes no item owns, or a failed commit (a hook, for example), hold the item for the root with the file list or the error.
- **Dirty worktrees:** read-only lanes (review, decide) may be planned into a dirty worktree, because they never write. Writer lanes and resume still require a clean one.
- **Builds in adopted worktrees:** a build dispatched into an adopted worktree gets the same adopt commit first. Spec-loop lanes tolerate a worktree whose only changes are untracked files, which the driver deliberately leaves uncommitted. Other writers and resume still need it fully clean.
- **Integration worktree reservation:** any integrate or verify lane whose workflow is not closed or completed keeps `spec-integration` reserved, even when its item was blocked or the lane went idle without a receipt. So does any lane with `specStage` integrate or verify whose pane Herdr still reports an agent in, whatever state its item is in, including lanes no item tracks any more. The next integration or verification waits.
- **Status replies:** a lane that answers the receipt request with a `herdr_message` status is still working (for example, a long suite in a tracked background shell). Its item isn't blocked; the driver asks again after an hour, doubling each time it answers with a status.
- **Already-integrated branches:** before starting an integration, a queued item whose branch tip is already on `spec-integration` (a batch lane merged it) is recorded as integrated at the commit that contains it. Its tests are recorded green only when another item integrated at that same commit recorded a suite pass; otherwise the verifier waits for them. This applies only to real work. The branch needs at least one commit beyond the target base (a tip equal to the base is an ancestor of everything), and the item's worktree must have no uncommitted owned changes. Otherwise the item is integrated normally.
- **Baseline-relative suite gate:** a target whose own tip fails the suite (an upstream lint error, say) would make `SUITE: pass` impossible, so the loop could never push. Instead:
  - Once an item is queued for integration, the driver records the suite at the target tip, once per target SHA (the last 5 are kept in `spec-state.json` `baselines`). A baseline lane checks out that exact commit in the `spec-baseline` worktree, runs `target.suite` and changes nothing.
  - Lanes report failures per package and task as `FAILED: <package> <task>` lines. Turborepo, pnpm and Nx summaries in a receipt are read too.
  - An integration with `SUITE: fail` passes when every failure it reports already fails in the baseline. It then records `integration.baselineFailures`, and the push ask lists them as known baseline failures, not caused by the items.
  - Any new failure sends the item back to its builder, with the new failures named in the findings.
  - A failing integration receipt waits for the baseline if the baseline isn't recorded yet.
  - The integration objective lists the known failures, so the lane doesn't try to fix them.
  - With `spec.defaults.fixBaseline: true`, one lane first fixes the baseline failures on `spec-integration`, with small commits and no behavior change. Integrations wait for it and are then judged against what it left failing. If the lane ends twice without a receipt, the loop falls back to the recorded baseline.
- **Generated artifacts:** before the uncommitted-outside-owns check (at adopt-commit, build and integrate), modified tracked files matching `spec.defaults.generatedArtifacts` that the item does not own (nor a sibling item sharing the worktree) are restored to HEAD and logged in the item's history. The default globs are `**/openapi-spec.json` and `packages/shared/api-clients/src/api/**`. A stale committed baseline that every build regenerates no longer holds builds. An item that owns such a file commits it as usual.
- **Worktrees open elsewhere:** Herdr opens a worktree in one workspace only. When a lane's worktree is already open in another workspace (first-wave lanes left adopted worktrees open in their old workspaces), planning records it as the workflow's `laneWorkspaceId` instead of failing. Dispatch then creates the lanes there as new tabs, and each lane records its `workspaceId`. Controller registration and operator lane cleanup follow it. The root's task binding is unchanged. The sweep still reports such lane tabs rather than sweeping them.
- **Commit headers:** every commit the driver or an integration lane makes uses a conventional header of at most 72 characters: `spec(<id>): adopt work as built`, `spec(<id>): integrate`, `spec(<id>): commit work before integration`. Commitlint's config-conventional accepts these.
- **What blocks:** only modified or staged tracked files outside `owns`/`sharedTouch` block an adopted item. Untracked files outside the list (lane harness scripts, artifact folders) stay in place, uncommitted, and are listed in the item's history. Secrets are never staged.
- **Hooks:** the repository's hooks run. The driver stages the explicit paths, checks that nothing else is staged, and commits without a pathspec, so lint-staged can rewrite and re-stage files. If a hook fails, the last ~40 lines of its output (not the command line) go into the item's reason.
- **Retry after a deploy:** holds a code change may fix (a failed adopt commit, or blocking changes at review or integration) are stamped with the loaded code's fingerprint. They retry once, back to the stage they were in, on the first pass after new code loads. Holds recorded before stamping existed are recognized by their note.

Memory-aware dispatch: besides a waiting capacity gate, the driver samples free memory and swap before dispatching when `defaults.minFreeMemoryGb` or `defaults.maxSwapUsedGb` is set. After a dispatch fails with "shell did not become ready", it starts nothing else that pass and backs off for 10 minutes. Retries of an undispatched stage honor the same hold.

## Open questions for Zach

- Is one push prompt per integration round right, or one per item?
- Does every push to the target branch redeploy the preview, and which endpoint reports the deployed SHA?
- Should the verify stage's final report replace the lane's local report, or sit alongside it?
