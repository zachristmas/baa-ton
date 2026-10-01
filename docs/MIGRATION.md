# Review, migration and acceptance record

## Version and scope

Baseline: `zachristmas/baa-ton` main at `dba8e02ee06b3830c4de83e9d69d1498982c1b53` (PR181). Installed native reference: HERDR 0.9.1, API protocol 22/schema 1. Node reference: 22.22.3. Codex CLI reference: 0.159.0; Claude reference: 2.1.286.

The initial request was a simplification review without implementation. The user subsequently requested the aggressive reduction, unified installer/TUI, agent-ready configuration mode, and a draft PR before installation. This branch implements that local review candidate. No live MCP installation, model launch, machine registration, existing agent interruption or deployment was performed by this implementation task. A separate fleet setup is outside this diff.

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
| Runtime files, including installers/audit script | 94 | 24 |
| Runtime physical LOC | 42,835 | 1,440 |
| Runtime nonblank LOC | 41,179 | 1,397 |
| Runtime UTF-8 bytes | 1,932,770 | 110,873 |
| Test/support/smoke files | 123 | 7 |
| Test/support/smoke physical LOC | 31,867 | 989 |
| Declaration files / LOC | 28 / 799 | 0 / 0 |
| Direct runtime npm dependencies | 2 | 0 |
| Operator tool surface | 33 Pi + 1 MCP-only | 12 MCP/CLI; 9 worker tools |

Runtime LOC falls **96.6%**; bytes fall **94.3%**. Runtime file count falls 74.5%; total files fall from 279 to approximately 47. Tool count falls 64.7%, not 80–90%. These are source-size measures, **not proof of equivalent behavior or a measured percentage of cognitive complexity**. The smaller implementation deliberately removes substantial autonomous lifecycle behavior and its tests. Compact formatting also affects LOC, which is why bytes are included.

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

The remote pipe-to-shell clone/update bootstrap is retired. Install from a reviewed checkout. The Windows wrappers share the Node implementation but were not run on Windows. OpenCode JSONC is deliberately not rewritten. Ask-list matching is tool-level; Claude/OpenCode continue native permissions rather than claiming Codex-specific policy parity.

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
| Human redirects a spawned session | Worker self-redirect advances revision, sends no duplicate task, fences old results/approvals | Enter each harness pane and redirect it naturally; confirm no root-only refusal |
| Two independent roots/scopes | Separate state documents and pause tests; A pause leaves B delivery active | Two actual HERDR workspaces, separate goals and profiles |
| Local pause/resume | Pauses before create/start/delivery are fenced; running processes untouched; resume drains once | Pause while a real harness changes state; inspect in-flight boundary |
| Cancellation | Create/start continuations cannot revive cancelled jobs; late result rejected | Cancel a disposable live job without closing its native pane |
| Cross-harness messaging | Fixed native argv, queued delivery, no-goal drain, uncertain-send fence | Codex↔Claude↔Pi↔OpenCode round trip with real providers |
| Reconnect and session changes | Terminal/session/process identity fences, session promotion, explicit reconnect invalidation and late-reply tests | Replace a real pane/session and inspect/reconnect without replay |
| Evidence and chains | Idle does not complete; stale/self/cancelled reviewers rejected; reported/verified stage gates | Independent reviewer checks an actual artifact before advancement |
| Exact native approval | Real child Claude hook emits exact one-use native decision through MCP; changed input/session/revision/expiry fails; Bash remains native | Native provider hook delivery/prompt fallback and denial in an actual Claude session |
| Worker boundaries | Canonical controlling MCP/extension disabled by all four launch adapters; worker catalog omits approve/connect/reconnect | Confirm catalog in each installed harness; same-user shell is not a sandbox |
| Ask-list | Exact names only; unknown/wildcard rejected; changed snapshot refuses startup | Confirm selected tools prompt and routine tools do not in the local Codex UI |
| Installer/TUI/agent | All four project integrations, 28 skills, preview/cancel, idempotence, partial selection, conflict/symlink preservation, JSON CLI and POSIX wrapper | Real client skill discovery; native Windows/PowerShell wrapper runs |

At the recorded candidate, **57 tests pass** under `npm test` in approximately three seconds. Tests use temporary directories, in-memory fake HERDR and a real fake-native executable process. No paid model was launched. Independent GPT Astra review found and drove fixes for cancellation, stale identity/result/approval, delivery uncertainty and installer inheritance issues. This evidence is meaningful but does not replace live harness qualification.

Installed Codex 0.159.0 accepted the generated config in a read-only config parse. Invalid values for both `default_tools_approval_mode` and per-tool `approval_mode` were rejected with the documented enum; generated TOML was separately parsed after an existing server table and preserved that server. Skill frontmatter validation was run. The old controller suite could not be completed reliably in the sandbox because process/socket checks hit EPERM; no claim is made that every removed legacy test previously passed or that v2 replaces its entire coverage.

## Native references and deliberate limits

- [OpenAI MCP configuration](https://learn.chatgpt.com/docs/extend/mcp): stdio, client scope and per-tool approval settings.
- [Claude hooks](https://code.claude.com/docs/en/hooks): supported PermissionRequest input and native decision output; no terminal-key approval injection.
- [OpenCode configuration](https://opencode.ai/docs/config/) and [model options](https://opencode.ai/docs/models/): environment overlay and explicit provider options. Effort mapping is currently limited to its OpenAI provider.
- Local HERDR 0.9.1 `api schema --json` and CLI help were the native source of truth for workspace/tab/worktree/agent/pane operations. Native wait is an attention-state wait, not a turn-completion receipt.

There is no voice bridge, remote runtime distribution, autonomous stage advancement, retention service, global root, self-healing process supervisor or cross-account credential route here. A future voice coordinator can invoke the local executor's same CLI/MCP; host-local copies can perform fleet work through existing HERDR/SSH. Machine ownership does not decide whether a workspace/account is personal or work-related.
