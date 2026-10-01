# Baa-ton v2 — native HERDR orchestration

A small, dependency-free wrapper around HERDR 0.9.1 for Codex, Claude Code, Pi and OpenCode. It keeps scoped goals, explicit results, cross-session messages, exact launch profiles and a supported native permission bridge. HERDR owns terminals, workspaces, worktrees and agent processes.

This branch is a substantial simplification of `dba8e02` for review. It is **not yet qualified with paid/live model launches**. Read [the migration and verification record](docs/MIGRATION.md) before replacing an existing installation.

## One installer, two interfaces

Requirements: Node 22.19+, HERDR 0.9.1, and the selected authenticated harnesses. No npm dependencies are required.

From the reviewed checkout, run `./install.sh` on macOS/Linux/WSL, `./install.ps1` in PowerShell, or `install.cmd` on Windows. With an interactive terminal this opens the compact TUI. Select the project, harnesses, exact model/effort profiles, workspace scope, approval ask-list, and optional project-local connections. Review the full proposed file changes and apply them with the final confirmation.

For an agent or automation, prepare a setup JSON file like [examples/setup.json](examples/setup.json), replace the example paths/workspace/model IDs with inspected values, then run:

```sh
node src/install.mjs --settings /absolute/path/setup.json
node src/install.mjs --settings /absolute/path/setup.json --apply
```

The first command validates and previews without writes. The second applies the reviewed project changes. The TUI and agent mode call the same implementation. Baa-ton configuration is JSON; Codex's generated MCP settings are TOML. Claude and OpenCode use their native JSON MCP settings; Pi receives a project extension.

Skills-only installation remains available:

```sh
node src/install.mjs --project-root /path/to/project --harnesses codex,claude,opencode,pi
node src/install.mjs --project-root /path/to/project --harnesses codex,claude,opencode,pi --apply
```

The seven familiar skills remain: `baa-ton-start`, `configure`, `update`, `end`, `uninstall`, `reset`, and `sweep`. Their instructions reflect the smaller runtime. They never imply permission to kill agents, delete worktrees, push, merge, or change accounts. Skills are installed under `.agents/skills`, `.claude/skills`, `.opencode/skills`, and `.pi/skills` respectively.

The installer preserves unrelated configuration and refuses modified/unowned Baa-ton files or symlinked target paths. It does not clone/update Git, alter global model/authentication settings, restart HERDR, migrate legacy state, or enable a daemon. Legacy v1 configuration and OpenCode JSONC require explicit reconciliation. The old remote `curl | bash` bootstrap is retired; run the installer from the reviewed checkout. Windows wrappers are provided; they have not been executed on Windows in this review.

## Configuration and approval choices

See [examples/config.json](examples/config.json). Scopes name an explicit workspace and cwd; they are not inferred from the focused pane. Multiple scopes are independent, including their pause state. A scope's endpoint/workspace/cwd binding is immutable once used; use a new name when changing it.

Profiles select an exact harness/model/effort, retain existing authentication, and never change global defaults. Distinct new assignments get fresh jobs and panes; reuse a request ID only to retry the same assignment. The requesting user's preferred fast model can be configured as a profile without becoming another user's default.

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

Pause stops new dispatch and automatic delivery in one scope. It does not interrupt an already executing native operation or pause any other scope. Direct explicit messages remain available. Cancel stops orchestration for a job but leaves its agent, pane and worktree intact.

Native `idle`/`done` means attention state, not success. Workers submit concrete evidence with the current revision; independent reviewers or the human verify it separately. Chains advance explicitly after their evidence gate. A watchdog `tick` is a single bounded pass: no hidden daemon, no automatic chain progression. Schedule ticks only when the user wants ongoing delivery/nudges.

## Verification

```sh
npm test
```

Tests use temporary state, fake native executables, real MCP/CLI/hook processes and installer fixtures. They do not launch paid models, register machines or modify live client configuration. See [MIGRATION.md](docs/MIGRATION.md) for remaining live acceptance checks and the reduction/tradeoff inventory.
