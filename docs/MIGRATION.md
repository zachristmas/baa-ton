# Review, migration and acceptance record

## Version and scope

Baseline: `zachristmas/baa-ton` main at `dba8e02ee06b3830c4de83e9d69d1498982c1b53` (PR181). Installed native reference: HERDR 0.9.1, API protocol 22/schema 1. Node reference: 22.22.3. Codex CLI reference: 0.159.0; Claude reference: 2.1.286.

The initial request was a simplification review without implementation. The user subsequently requested the aggressive reduction, unified installer/TUI, agent-ready configuration mode, and a draft PR before installation. This branch implements that local review candidate. The user later approved a local MCP installation, isolated smoke tests, and copying the reviewed runtime to two existing SSH hosts. These operational checks are recorded below; the committed configuration examples remain generic. No existing agent was interrupted or account switched.

No original checkout existed at the expected legacy paths on the inspected Mac; old skills referenced a missing checkout. A clean isolated clone was used, preserving existing work. The baseline remains in Git and an external source archive was retained. No old state/config directories were rewritten.

## Confirmed problems at the reviewed baseline

The complaints were checked against PR181's merged version, not assumed from older reports:

- `packages/herdr-tools/operator.mjs:339-363` has one `store.runState`, with no root/workspace key. `operator-api.mjs:136` changes that shared field; controller per-root loops read the same operator state. An isolated import of the baseline pure functions demonstrated two consumers observing the same pause. The global-pause problem persisted after PR181.
- `operator-api.mjs:123-132` requires a particular sender name and refuses pause from registered root/lane panes, even when a human is typing there.
- `packages/herdr-tools/index.ts:1361` requires a registered root goal executor. `mcp-server.mjs:215` supplies a sole-parent/root briefing. Those are implementation restrictions, not the desired future authority model. The new contract accepts direct human instructions in any pane.
- PR181's exact external-operation approval gate is valuable. Its three modules remain, with a narrow Git-global-flag detection repair and updated integration tests. The generic Claude broker does not attempt to classify arbitrary shell: all Bash permissions stay native.

## Quantified reduction

Physical lines include comments and blanks. Tests, declarations, docs and configuration are counted separately. Reproduce either revision with `node tools/measure.mjs <git-ref>`; omit the ref for tracked plus nonignored working files. It classifies test/support/smoke paths first, declarations separately, Markdown as docs, executable extensions as runtime, and remaining text as configuration. Binary art is not LOC.

| Measure | Baseline | Review candidate |
|---|---:|---:|
| Runtime files, including installers/audit script | 94 | 25 |
| Runtime physical LOC | 42,835 | 1,532 |
| Runtime nonblank LOC | 41,179 | 1,485 |
| Runtime UTF-8 bytes | 1,932,770 | 119,998 |
| Test/support/smoke files | 123 | 8 |
| Test/support/smoke physical LOC | 31,867 | 1,092 |
| Declaration files / LOC | 28 / 799 | 0 / 0 |
| Direct runtime npm dependencies | 2 | 0 |
| Operator tool surface | 33 Pi + 1 MCP-only | 12 MCP/CLI; 9 worker tools |

Runtime LOC falls **96.4%**; bytes fall **93.8%**. Runtime file count falls 73.4%; total files fall from 279 to 51. Tool count falls 64.7%, not 80–90%. These are source-size measures, **not proof of equivalent behavior or a measured percentage of cognitive complexity**. The smaller implementation deliberately removes substantial autonomous lifecycle behavior and its tests. Compact formatting also affects LOC, which is why bytes are included.

For state, the baseline `contract.ts` declares 50 exported types, 34 of them object-shaped contracts; these are not 34 independent databases. Its durable graph includes workflows, lanes, per-lane/root goals, supervisors, root turns, retries, approval/question/message records, session logs, controller mappings, ownership, closure and retirement records, alongside operator/controller/inbox state. The candidate has six conceptual records—goal, job, message, embedded result/verification, exact approval, chain—in one JSON file per explicit scope plus generated launch files. There is no global root registry or global run-state switch.

## Keep / delete / replace

| Existing files / subsystem | Decision and replacement |
|---|---|
| `external-approval.mjs`, `external-approval-hook.mjs`, `external-approval-resolver.mjs` | Keep exact binding/expiry/single-use and native Pi pre-execution confirmation. Repair Git `-C`/`-c` push detection. Keep two focused test files; replace old source-regex integration with the real new Pi registration seam. |
| `packages/herdr-tools/index.ts` (13,606 LOC), `mcp-server.mjs`, compiled extension loading | Replace with `src/mcp.mjs`, `tools.mjs`, `pi.mjs`, and one shared `core.mjs`. Remove Pi SDK/jiti runtime dependency. |
| `operator.mjs`, `operator-api.mjs`, operator CLI/global run state | Replace with scoped `goal`, `message`, `status`, CLI and local store. No hardcoded sender or root-pane authority. |
| `dispatch-task.mjs`, root bootstrap/reconcile/recover, harness catalog/profile resolution | Replace with fixed native command sequencing in `herdr.mjs` and explicit profiles in `profiles.mjs`/`config.mjs`. No model substitution. |
| Entire `packages/controller/` including 5,709-LOC controller, supervisor scripts, revive/watch/digest paths | Delete. Optional one-shot `tick` skips busy/blocked/paused/stale jobs and uses a bounded nudge count. No resident controller, auto-revival or daemon installation. |
| Spec driver, stage host selection, services, runtime lease/directive/policy graph | Delete. Small explicit chains retain profile-per-stage sequencing and evidence gates. No automatic spec integration, service management or distributed resource leases. |
| Housekeeping/retirement/sweep, operator resource closure | Remove resource deletion. Cancellation changes orchestration state only. Users may separately operate native resources with their normal tools. |
| Installer/setup TUI/root-setup and generated skills | Replace with `install.mjs` + `setup.mjs`, seven short skills, and six small platform wrappers. One terminal wizard and the same JSON-driven agent mode; preview/apply, selected harnesses, profiles, scope and ask-list remain. |
| Legacy root-only BAA contract and old docs | Replace with direct-user authority, explicit scopes, native permissions, setup and migration docs. |

## Backward compatibility choices

The `baa-ton` binary name, `install.sh`/`.ps1`/`.cmd`, uninstall wrappers, and seven familiar skill names survive. The v1 state schema and old 34-tool API do not: keeping a compatibility state engine would preserve much of the complexity being removed. There is no automatic state conversion, hidden old controller, or alias that pretends old workflow semantics still exist.

A live v1 job should finish under its existing runtime. Do not point a running v1 session at v2 or have both versions manage the same job. Start v2 with a separate scope/config after inspection, and explicitly connect an existing pane only when intended. Existing legacy config/skills are preserved and conflicting files require reconciliation. Installed absolute runtime paths must remain available until their clients are disconnected.

The remote pipe-to-shell clone/update bootstrap is retired. Install from a reviewed checkout. Both Windows wrappers have now passed native preview checks, and the agent installer applied the isolated Windows scratch configuration. OpenCode JSONC is deliberately not rewritten. Ask-list matching is tool-level; Claude/OpenCode continue native permissions rather than claiming Codex-specific policy parity.

## Executable migration slices

The draft contains the full candidate so every removal is reviewable. The work can be split into these review/merge commits without expanding scope:

1. **Pin and reproduce baseline:** retain `dba8e02`, run `node tools/measure.mjs dba8e02`, record native schema/version and isolate all fixtures. Confirm the global-pause and root-only gates above.
2. **Introduce the native core beside v1:** add `src/{store,herdr,config,profiles,core,tools,mcp,cli}.mjs`, explicit scope binding, intent/claim records and twelve tools. Run core and stdio tests. This is the concrete first implementation slice: fix local pause and direct intervention without deploying a controller replacement.
3. **Restore supported permission boundaries:** add exact Claude non-Bash hook, Pi registration and retained external gate; add native per-tool ask-list compilation. Run replay, stale-session, digest, cancellation, reconnect and actual child-hook tests.
4. **Install through one workflow:** add unified TUI and JSON setup mode, project skills/connections and ownership manifests. Run temporary-project tests for all four harnesses, preview/cancel, repeat, partial selection and conflicts; parse generated TOML with a real parser.
5. **Retire superseded runtime/docs:** remove controller/spec/lease/revival/cleanup engines and old dependencies. Re-run all tests and metrics; review the explicit removed-feature table. Keep Git/archive recovery.
6. **Qualified cutover after user review:** choose actual project/workspace/profile/ask-list, preview the installer, approve its exact writes, apply, reconnect one local client and confirm the expected tools. Run the live acceptance matrix below before broader use. Publish/merge or install only under the separately authorized request.

Agent mode: fill `examples/setup.json`, run `node src/install.mjs --settings setup.json`, review its complete before/after proposal, then repeat with `--apply`. TUI mode: run the platform install wrapper with no arguments in a terminal. Neither mode is invoked against a live home/project by the test suite.

Rollback: disconnect/disable only the newly installed v2 host entry, retain its scope state for inspection, and return to the baseline checkout/config. Never reset a dirty checkout. `uninstall` removes only unchanged v2-owned project skills; it intentionally leaves state, checkout, host entries and native resources. Restore any separately approved config changes from the reviewed before-content/backup. No automated rollback closes running sessions.

## Acceptance matrix and observed evidence

| Criterion | Automated observation | Remaining live qualification |
|---|---|---|
| Human redirects a spawned session | Worker self-redirect advances revision, sends no duplicate task, fences old results/approvals; live Codex intervention passed | Repeat the direct-pane check in Claude, Pi and OpenCode |
| Two independent roots/scopes | Separate state documents and pause tests; two live local workspaces retained independent A-paused/B-active goals | Concurrent live worker delivery under changing pause state |
| Local pause/resume | Pauses before create/start/delivery are fenced; running processes untouched; resume drains once | Pause while a real harness changes state; inspect in-flight boundary |
| Cancellation | Create/start continuations cannot revive cancelled jobs; late result rejected | Cancel a disposable live job without closing its native pane |
| Remote dispatch | POSIX/Windows fixtures, real SSH status, and Luna Fast MCP status→result round trips pass on both hosts | Other selected remote harness/provider combinations |
| Cross-harness messaging | Fixed native argv, queued delivery, no-goal drain, uncertain-send fence | Codex↔Claude↔Pi↔OpenCode round trip with real providers |
| Reconnect and session changes | Terminal/session/process identity fences, session promotion, explicit reconnect invalidation and late-reply tests | Replace a real pane/session and inspect/reconnect without replay |
| Evidence and chains | Idle does not complete; stale/self/cancelled reviewers rejected; reported/verified stage gates | Independent reviewer checks an actual artifact before advancement |
| Exact native approval | Real child Claude hook emits exact one-use native decision through MCP; changed input/session/revision/expiry fails; Bash remains native | Native provider hook delivery/prompt fallback and denial in an actual Claude session |
| Worker boundaries | Canonical controlling MCP/extension disabled by all four launch adapters; worker catalog omits approve/connect/reconnect | Confirm catalog in each installed harness; same-user shell is not a sandbox |
| Ask-list | Exact names only; unknown/wildcard rejected; changed snapshot refuses startup | Confirm selected tools prompt and routine tools do not in the local Codex UI |
| Installer/TUI/agent | Four project integrations,28 skills, preview/cancel, idempotence, conflicts, applied remote JSON setup, and native Windows wrapper previews pass | Live discovery in every selected harness |

At the recorded candidate, **64 tests pass** under `npm test` in approximately three seconds. Tests use temporary directories, in-memory fake HERDR and a real fake-native executable process. The automated suite launches no paid model. Independent GPT Astra review found and drove fixes for cancellation, stale identity/result/approval, delivery uncertainty and installer inheritance issues. This evidence is meaningful but does not replace live harness qualification.

Installed Codex 0.159.0 accepted the generated config in a read-only config parse. Invalid values for both `default_tools_approval_mode` and per-tool `approval_mode` were rejected with the documented enum; generated TOML was separately parsed after an existing server table and preserved that server. Skill frontmatter validation was run. The old controller suite could not be completed reliably in the sandbox because process/socket checks hit EPERM; no claim is made that every removed legacy test previously passed or that v2 replaces its entire coverage.

## Native references and deliberate limits

- [OpenAI MCP configuration](https://learn.chatgpt.com/docs/extend/mcp): stdio, client scope and per-tool approval settings.
- [Claude hooks](https://code.claude.com/docs/en/hooks): supported PermissionRequest input and native decision output; no terminal-key approval injection.
- [OpenCode configuration](https://opencode.ai/docs/config/) and [model options](https://opencode.ai/docs/models/): environment overlay and explicit provider options. Effort mapping is currently limited to its OpenAI provider.
- Local HERDR 0.9.1 `api schema --json` and CLI help were the native source of truth for workspace/tab/worktree/agent/pane operations. Native wait is an attention-state wait, not a turn-completion receipt.

Remote scope routing is implemented via native SSH to a prepared host-local runtime; fixture tests cover both POSIX and Windows command/payload boundaries, immutable endpoint binding and uncertain failure. Native agent labels are persisted separately from durable job IDs, stay below32 characters, include scope identity and are collision-checked against native agents before resource creation.

The intended entry path is dot → local Codex executor → native HERDR/SSH fleet. This repository implements the CLI/MCP and fleet execution layer; the surrounding application supplies the voice/task handoff. It does not implement a direct dot MCP connector, automatic remote distribution, autonomous stage advancement, retention service, global root, self-healing supervisor or cross-account credential route. Machine ownership does not decide whether a workspace/account is personal or work-related.

## Live qualification at runtime commit `58d4c2564ebf4a2f88aab22b56028a8be183cbf3`

The approved Mac host entry is registered with the exact twelve-tool allowlist and native ask-list settings, preserving unrelated configuration. Local HERDR server 0.9.0 accepts the 0.9.1 CLI API; no server upgrade/restart was performed. Native startup initially exposed two issues missed by fake-native tests: a fresh shell can reject start as busy, and a multi-kilobyte inline Codex command can remain truncated at the shell. Startup now retries only the explicit pre-execution busy rejection, and Codex uses a generated per-job MCP loader plus one compact native TOML table (about 910 bytes in the inspected setup). The loader pins config, worker, scope and policy digest; all nine worker tool modes remain explicit.

The local Luna Fast worker completed a real status → result MCP round trip, recording `2+2=4`. After a direct native-pane instruction it recorded its own redirection without prompting itself, advanced revision 1→2 and submitted `3+3=6`. No root-only gate blocked it. Pausing local scope A left local scope B active, and resuming A preserved both records. Reconnect reused the inspected terminal after the user explicitly accepted its exact native scratch-folder trust prompt; no duplicate worker was launched.

The same committed archive was copied to two approved SSH hosts with matching SHA256, and the unified JSON installer applied isolated Codex scratch configurations. Actual Baa-ton SSH status calls succeeded for POSIX and Windows. Native Windows `.cmd` and PowerShell installer previews succeeded, as did seven focused native Windows policy/transport tests. A fresh-host startup failure exposed an incomplete disabled MCP entry; the launch override now supplies a valid disabled transport even when no global Baa-ton server exists. Existing global remote MCP settings were not changed.

After explicit approval of their exact native scratch-folder trust prompts, both existing remote workers were reconnected without relaunch. Each called the worker MCP status tool and submitted `2+2=4` for its current revision; the controlling Mac retrieved both records through Baa-ton SSH with matching live identities. The profiles were exactly Luna, low effort, priority/Fast, read-only. Hermes's official npm Codex CLI was updated from 0.140.0 to 0.159.3 after verifying the active desktop app used a separate binary; a rollback archive was retained and the refreshed catalog confirmed Luna/Fast. No account, credential, daemon or global remote MCP change was made.

Failed attempts remain inspectable and were cancelled only after shell-only process inspection. Full cross-harness round trips, live Claude approval delivery, and independent live result verification remain separate qualification gates. The complete local test suite passes 64/64; test success is not a claim of full legacy feature parity. The operating-system account and native sandbox remain the permission boundary. Historical startup errors remain in recovered job records for inspection even after a later reported result.
