# Baa-ton

<p align="center">
  <img src="assets/mascot.png?v=3761159" alt="Nala, the Baa-ton dog" width="320" height="320">
</p>

<pre align="center">───────────────────🐕  🐑  🐑  🐑  🐑  🐑  🐑──────────────────</pre>

Baa-ton is a durable, harness-neutral orchestration layer for [Herdr](https://github.com/herdrdev/herdr) 0.9+. Herdr owns panes and agent processes; Baa-ton plans work, verifies agents before dispatch, and records durable receipts.

## Install

macOS, Linux, and WSL:

```sh
curl -fsSL https://raw.githubusercontent.com/zachristmas/baa-ton/main/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/zachristmas/baa-ton/main/install.ps1 | iex
```

Windows CMD:

```bat
curl -fsSL https://raw.githubusercontent.com/zachristmas/baa-ton/main/install.cmd -o install.cmd && install.cmd && del install.cmd
```

Run the installer from the project directory you want to use. It defaults to that directory, lets you choose another, detects your installed harnesses, and installs the project skills.

When it says `Install complete`, open the harness of your choice in that project and invoke `baa-ton-start`, then describe your task. Use `baa-ton-configure` to choose worker profiles and model assignments, or `baa-ton-update` to update Baa-ton and refresh the project integration.

Re-running the installer updates the checkout and project configuration.

Uninstall:

```sh
curl -fsSL https://raw.githubusercontent.com/zachristmas/baa-ton/main/uninstall.sh | bash
```

On Windows, run `uninstall.ps1` or `uninstall.cmd`. The uninstaller removes only Baa-ton-owned links, plugins, and checkout files; it preserves shared Herdr config, project manifests, and harness MCP config.

## Set up a root

Start a supported harness in the target project and invoke `baa-ton-start`. It connects the harness, bootstraps the current Herdr pane as the Baa-ton root, and waits for your task.

If the harness cannot discover project skills, use this fallback:

```sh
node ~/.baa-ton/packages/herdr-tools/root-setup.mjs --harness claude
# use pi, codex, or opencode as appropriate
```

Keep the harness in the same Herdr pane so its identity is preserved.

## Configure workers

Invoke `baa-ton-configure` in the project to edit `.baa-ton/config.json`, where each task profile’s harness, provider, model, thinking, and auth settings are stored. It only changes configuration; it does not start work.

## Update Baa-ton

Invoke `baa-ton-update` in the project to update the shared Baa-ton checkout, install dependency changes, and refresh the project integrations. Your project contract, configuration, instructions, and user-authored skills are preserved.

What an update does and doesn't change:
- **Profiles:** setup keeps every task profile that already names an `agentKind` or `launchProfile`, fills only missing ones, and prints which it kept and filled.
- **Optional sections:** it lists `.baa-ton/config.json` sections you haven't configured (`runtime` leases, `approvalPolicy`) and never enables them for you.
- **Supervisor:** the controller supervisor restarts itself when its code on disk changes and stays stable for two checks. Herdr runs plugin startup hooks only when its server starts, so a supervisor started before this version must be restarted once.
- **Version skew:** roots and lanes keep the code they loaded. `herdr_doctor` reports `runtime-version-skew` (installed commit versus what the root, each lane's MCP bridge and the supervisor loaded) and `controller-plugin-install` (the controller plugin linked from a different checkout than the one being updated). Reload what it lists before starting new work: a root in the same session (`pi --session <path>`), and a lane through `/mcp` reconnect or `herdr_resume`.

Older installs kept orchestrator state in `.pi/herdr-orchestrator`. Setup copies it to `.baa-ton/herdr-orchestrator`, rewrites the absolute paths and route ids in it and in the controller's `config.json` and `inbox.json`, and leaves the old directory in place as an archive with a `MIGRATED-TO-BAA-TON.json` marker. Update at a quiet point: an old Baa-ton still running against `.pi` after the copy is reported by `herdr_doctor`. To migrate by hand, run `node packages/herdr-tools/state-migration.mjs --project-root <project> --controller-config-dir "$(herdr plugin config-dir herdr-orchestrator-controller)"`; `--status` only reports.

## Re-run project setup

If you installed from the wrong directory or want to change harness selections, run the same wizard manually from the project root. Press Enter to keep the current directory, or enter another existing project path when prompted:

macOS, Linux, and WSL:

```sh
node ~/.baa-ton/packages/herdr-tools/install-tui.mjs --project-root "$PWD"
```

Windows PowerShell:

```powershell
node "$HOME\.baa-ton\packages\herdr-tools\install-tui.mjs" --project-root "$PWD"
```

The wizard updates a managed `BAA.md` reference in existing `AGENTS.md` or `CLAUDE.md` files; use `--instructions-path <file>` to choose another instruction file. `setup.mjs` remains the CLI-compatible entry point for scripts and automation (it delegates to `install-tui.mjs` under the hood) and accepts the same flags non-interactively.

For manual/source setup, see [workflow tools](packages/herdr-tools/README.md#any-harness-as-root).

## Task profiles

Profiles give the root a short, stable intent while `.baa-ton/config.json` holds the exact provider/model/thinking/auth launch settings.

| Profile | Use it for |
| --- | --- |
| `planning` | Explore and produce a plan; read-only. |
| `quick` | A small, well-bounded change. |
| `balanced` | The normal implementation default. |
| `implementation` | A larger multi-file change with stronger execution. |
| `sustained` | A well-specified long-running task: good context, low cost, low effort. |
| `review` | Read-only correctness and regression review. |
| `deep-review` | Read-only high-scrutiny review for risky changes. |

Pass a profile name to `herdr_plan` with `taskProfile`. Configure exact launch profiles explicitly; an unknown or incomplete profile fails closed instead of silently falling back.

## BAA.md

`BAA.md` is the canonical Baa-ton Agent Agreement. It is intentionally short and harness-neutral: it covers root/child roles, delegation, receipts, verification, safety gates, and profile selection. The setup wizard manages only its reference block in an instruction file, so your surrounding `AGENTS.md` or `CLAUDE.md` remains yours.

## Supported harnesses

| Harness | Integration |
| --- | --- |
| Pi | Native extension; root or lane. |
| Claude Code | MCP bridge plus startup attestation and deny rules. |
| Codex | Headless MCP bridge; native confirmation requires a TUI-capable root. |
| OpenCode | MCP bridge with conservative permissions. |

Support is qualification-by-profile, not a promise that every model or configuration works. Unqualified harnesses and launch profiles fail before topology is created.

If a registered root pane changes harness, run `herdr_doctor` from that pane and
then `herdr_reconcile_root` when it reports identity drift. This repairs only
the current pane's root mapping; it does not reset concurrent roots.

## Operating guarantees

- Herdr owns terminal topology; Baa-ton does not spawn detached processes.
- Plans, events, queues, sessions, and receipts are durable local records.
- Writers use isolated worktrees; read-only review lanes are explicit.
- Push, merge, deploy, and resource closure remain human-gated.
- Routine local dispatch, retry and resume run without a dialog only under an `approvalPolicy` in `.baa-ton/config.json` that the root has acknowledged (`herdr_policy`); push, merge, deploy, production, close and sweep always ask.
- Lanes ask for leases, runtime launches and approvals with `herdr_request`; policy-matching requests are answered at once and the rest stay open in the root digest until answered.
- Finished lanes are retired (services stopped, tab and session closed, leases released) by `herdr_retire`, automatically under an acknowledged `retire` grant; worktrees are never removed by it.
- Ports and service names come from `runtime.leases` in `.baa-ton/config.json` through `herdr_lease`; active leases never share a port or name, and close/sweep release them.
- `herdr_sweep` is dry-run by default; execution requires the native confirmation dialog. A headless MCP caller must show the exact inventory and obtain approval before cleanup.

## Tests

```sh
npm install
npm test
```

`npm run test:extension` and `npm run test:controller` run the packages separately. Live harness qualification is tracked in the [progress log](docs/native-prerequisite-progress.md).

## More

- [Workflow tools and MCP setup](packages/herdr-tools/README.md)
- [Event controller](packages/controller/README.md)
- [Adding a harness](docs/ADDING-A-HARNESS.md)
- [Design philosophy](docs/DESIGN-PHILOSOPHY.md)
- [Launch contract and evidence](packages/herdr-tools/HARNESS-ADAPTERS.md)
