# Operations and configuration

This guide collects the detailed installation, policy, remote-host, job-lifecycle, and verification reference. For the short project overview and first install, return to the [README](../README.md). Baa-ton is the CLI/MCP execution layer in the path dot → local Codex executor → Baa-ton → native HERDR and authorized SSH workspaces. The host application supplies the dot-to-Codex handoff; dot does not connect directly to this local MCP server.

## One installer, two interfaces

Requirements: Node 22.19+, HERDR, and the selected authenticated harnesses. Live qualification used HERDR CLI 0.9.1 (with server 0.9.0 compatibility confirmed). No npm dependencies are required.

From the reviewed checkout, run `./install.sh` on macOS/Linux/WSL, `./install.ps1` in PowerShell, or `install.cmd` on Windows. With an interactive terminal this opens the compact TUI. Select the project, harnesses, exact model/effort profiles, workspace scope, approval ask-list, and optional project-local connections. Review the full proposed file changes and apply them with the final confirmation.

For an agent or automation, prepare a setup JSON file like [examples/setup.json](../examples/setup.json), replace the example paths/workspace/model IDs with inspected values, then run:

```sh
node src/install.mjs --settings /absolute/path/setup.json
node src/install.mjs --settings /absolute/path/setup.json --apply
```

The first command validates and previews without writes. The second applies the reviewed project changes. The TUI and agent mode call the same implementation. Baa-ton configuration is JSON; Codex's generated MCP settings are TOML. Claude and OpenCode use their native JSON MCP settings; Pi receives a project extension.

`harnesses` selects control-plane connections; each `config.profiles` entry is a named worker role. They are independent, so Codex can control Baa-ton while every configured worker role uses Claude Code. The TUI starts with the seven role names in [the CIC catalog example](../examples/config.json), and pre-fills their Claude model and effort selections. Setup JSON writes the same role map. A role is dispatchable only when its exact name is present in the repository's `.baa-ton/config.json`; dispatch and chain creation reject unknown names before starting a worker.

Skills-only installation remains available:

```sh
node src/install.mjs --project-root /path/to/project --harnesses codex,claude,opencode,pi
node src/install.mjs --project-root /path/to/project --harnesses codex,claude,opencode,pi --apply
```

The seven familiar skills remain: `baa-ton-start`, `configure`, `update`, `end`, `uninstall`, `reset`, and `sweep`. Their instructions reflect the smaller runtime. They do not grant general permission to stop agents, remove worktrees, push, merge, or change accounts. Exact-pane cleanup is available only when enabled in the selected scope's config. Skills are installed under `.agents/skills`, `.claude/skills`, `.opencode/skills`, and `.pi/skills` respectively.

The installer preserves unrelated configuration and refuses modified/unowned Baa-ton files or symlinked target paths. It does not clone/update Git, alter global model/authentication settings, restart HERDR, migrate legacy state, or enable a daemon. Legacy v1 configuration and OpenCode JSONC require explicit reconciliation. The old remote `curl | bash` bootstrap is retired; run the installer from the reviewed checkout. Both Windows wrappers have passed native preview checks; the shared agent installer has applied the isolated Windows scratch configuration.

## Configuration and approval choices

See [examples/config.json](../examples/config.json). Scopes name an explicit workspace and cwd; they are not inferred from the focused pane. Each scope has its own goal, state file, and pause/resume lifecycle: configure separate `personal` and `work` scopes to keep their goals independent. A scope's endpoint/workspace/cwd binding is immutable once used; use a new name when changing it. Cleanup is disabled by default; add an explicit `cleanup` object only when you choose preview or close behavior.

Optional `cleanup` uses the existing one-shot `tick`, without adding a service. Omit it or set `mode: "disabled"` to turn cleanup off. `mode: "preview"` lists candidates; `mode: "close"` applies exact-pane closure after the configured `idleGraceSeconds` (default 24 hours; allowed range 1 minute to 7 days). The apply gate requires a Baa-ton-created pane, a saved verified result, no pending messages or approvals, no active review/chain descendants, native `idle`/`done`, unchanged terminal/session/foreground-process identity and state sequence, and clean `git status`. Adopted or reconnected panes, blocked/user-attention states, stale IDs, uncertain prior closes, unreadable transcripts, and dirty or unverifiable worktrees are skipped. Before close, Baa-ton saves up to 2,000 recent unwrapped terminal lines (512 KiB maximum) beside the unchanged result/verification record. Workspaces and worktrees are never removed. A close whose response is lost is recorded as uncertain and is never retried automatically; inspect the exact pane first.

HERDR 0.9.1 exposes `pane close` by pane ID only; it has no atomic compare-and-close argument. Baa-ton rechecks the recorded identity, idle state, verified state sequence, and foreground process immediately before the exact-pane call. HERDR documents pane IDs as stable and non-reused after closure, but there remains a narrow race if a human replaces the pane's agent between that final check and the close request.

Each role selects an exact harness/model/effort (and optional Codex `serviceTier: "priority"` when Fast is supported), retains existing authentication, and never changes global defaults. Distinct new assignments get fresh jobs and panes; reuse a request ID only to retry the same assignment. The requesting user's preferred fast model can be configured as a repository role without becoming another user's default.

```json
"approvals": {
  "ask": ["herdr_connect", "herdr_reconnect", "herdr_approve"]
}
```

This is a proposed starting list, not a universal preference. Add any exact tool name to require its native confirmation; use `[]` for no additional Baa-ton MCP prompts. Unknown names, wildcards and argument selectors are rejected. The list is **per tool**, not per action argument: listing `herdr_goal` asks for every call to that tool.

Codex receives explicit `prompt` for the selected tools and `approve` for routine tools, with an allowlist of the current tool surface and `prompt` as the fallback. Regenerate the host settings and reconnect after editing the list. A digest prevents an old generated connection from starting with changed approval choices or a changed tool catalog. A running client keeps its loaded snapshot until restarted. Pi applies the list via its native confirmation UI. Claude/OpenCode retain their native MCP approval behavior; this version does not claim they honor Codex's per-tool settings.

Provider restrictions and native harness permissions take precedence. The ask-list does not suppress shell permissions or authorize external actions. With `permissions: "broker"`, Claude's supported PermissionRequest hook can forward one exact **non-Bash** request to the controlling client. The request binds the native session, task revision, tool/input, digest and expiry, and is consumed once. Missing native identity, stale or changed input, timeout, headless failure or reconnect retain the native prompt. Every Bash request stays native. Pi retains the exact Git/PR approval guard; unsupported command forms fail closed.

Generate a host-level Codex proposal without installing it:

```sh
node src/cli.mjs host-config --config /absolute/path/config.json
```

Installation of that proposal into a global host config is a separate explicit choice. Local Codex clients share their host configuration; cloud-backed chats do not automatically acquire a local MCP server.

## Remote machines

[examples/fleet.json](../examples/fleet.json) routes named local scopes to an existing SSH host and its explicit host-local Baa-ton scope. The same validated tool call runs through native SSH into that host's Node/CLI/config; task JSON stays on stdin, with POSIX quoting or a fixed encoded PowerShell command. There is no relay service, OAuth bridge, shell tool or automatic remote installer. The first call pins the SSH account/runtime/config mapping; changing it requires a new scope name.

Prepare the reviewed runtime, Node, HERDR, authenticated harness and exact profiles on each remote host through its own approved installer run. The TUI can configure a prepared SSH route, and agent setup JSON supports the same `remotes` fields. Remote permissions and state stay on that host. The controlling client can inspect results and send cross-machine messages by targeting each remote scope. A connection failure is uncertain and never automatically retried. POSIX/Windows transport fixtures pass. Real Codex/Luna Fast status/result round trips passed on three hosts (local macOS, POSIX SSH, and Windows SSH); other harness/provider combinations still need live qualification.

## Working with jobs

```sh
node src/cli.mjs status --config /path/config.json
node src/cli.mjs goal --config /path/config.json --scope personal --action set --objective 'Finish the requested change'
node src/cli.mjs dispatch --config /path/config.json --scope personal --profile fast --task 'Inspect and report evidence' --requestId inspect-1
node src/cli.mjs pause --config /path/config.json --scope personal
node src/cli.mjs resume --config /path/config.json --scope personal
node src/cli.mjs tick --config /path/config.json --scope personal
```

Writers must pass `--access write --branch <fresh-branch>` and receive native HERDR worktrees. Read jobs share the configured cwd; Codex uses a read-only sandbox, Claude plan mode, Pi excludes its built-in bash/edit/write tools, and OpenCode denies edits while retaining native Bash prompts. These harness restrictions are not equivalent OS sandboxes.

Use `node src/cli.mjs tools` for schemas. Complex inputs use `node src/cli.mjs call herdr_chain --config ... --scope ... < arguments.json`. The same 12 tools are exposed by stdio MCP; scoped worker connections expose nine, omitting connect/reconnect/approve. The canonical controlling server is disabled in worker launch configuration. Role restrictions are a tool interface boundary, not an isolation boundary against arbitrary code running as the same OS user.

The human can intervene directly in any pane. A worker records its new instruction with `herdr_message redirect=true`; this advances the task revision without replaying the human's message to itself. Cross-session messages wait while an agent works. Lost replies become `uncertain` and block automatic replay until inspected and explicitly redirected/reconnected.

Pause stops new dispatch and automatic delivery in one scope. It does not interrupt an already executing native operation or pause any other scope. Direct explicit messages remain available. Cancel stops orchestration for a job but leaves its agent, pane and worktree intact. If cleanup has recorded a close claim, cancellation waits for its recorded outcome. When cleanup is explicitly configured, a tick may close only eligible Baa-ton-created panes; it keeps each worktree and its recorded result.

Native `idle`/`done` means attention state, not success. Workers submit concrete evidence with the current revision; independent reviewers or the human verify it separately. Chains advance explicitly after their evidence gate. A watchdog `tick` is a single bounded pass: no hidden daemon, no automatic chain progression. Schedule ticks only when the user wants ongoing delivery, nudges, or configured cleanup.

## Verification

```sh
npm test
```

Tests use temporary state, fake native executables, real MCP/CLI/hook processes and installer fixtures. They do not launch paid models, register machines or modify live client configuration. See [migration record](MIGRATION.md) for remaining live acceptance checks and the reduction/tradeoff inventory.
