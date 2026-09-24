# Baa-ton

<p align="center">
  <img src="assets/mascot.png?v=3761159" alt="Nala, the Baa-ton dog" width="320" height="320">
</p>

<pre align="center">───────────────────🐕  🐑  🐑  🐑  🐑  🐑  🐑──────────────────</pre>

Run a team of coding agents you can actually watch. One root agent splits the work, every worker gets its own [Herdr](https://github.com/herdrdev/herdr) pane and git worktree, and you choose which model does which job.

## What people use it for

- **Claude reviews GPT.** Codex writes the change and Claude Opus reviews it read-only before you merge.
- **Visible fan-out.** Hand the root a 20-item checklist. Each item becomes a lane in its own Herdr tab, so you can read, type into or stop any agent at any time.
- **Cheap workers, strong reviewer.** Run the grunt work on a fast model like GLM-5.3 Flash and keep planning and review on a frontier model.
- **Mix harnesses.** A Pi root with Claude Code, Codex and OpenCode workers, set per job type.
- **Walk away.** Lanes report back in batched digests instead of one ping each. Routine dispatch and retry run under a policy you approve once. Push, merge and deploy always ask you.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/zachristmas/baa-ton/main/install.sh | bash
```

Run it from your project directory. For Windows and uninstall, see [Operating Baa-ton](docs/OPERATIONS.md#install).

## Use it

Open your agent (Claude Code, Codex, Pi or OpenCode) in a Herdr pane inside the project, then run one of these skills:

| Skill | Does |
| --- | --- |
| `baa-ton-start` | Makes this pane the root. Then describe your task. |
| `baa-ton-configure` | Picks a harness and model for each job type. |
| `baa-ton-update` | Updates Baa-ton and keeps your settings. |

If the root's old Herdr workspace is gone, move its workflows to a new root with the audited `herdr_recover_root` preview instead of resetting anything. See [stale-root recovery](packages/herdr-tools/README.md#recover-a-stale-project-root).

## Pick a model per job

The root asks for a job type (`planning`, `quick`, `balanced`, `implementation`, `sustained`, `review`, `deep-review`). `.baa-ton/config.json` decides who does it:

```jsonc
{
  "version": 1,
  "profiles": {
    // GPT builds
    "implementation": { "agentKind": "codex",
      "launchProfile": { "provider": "openai-codex", "model": "gpt-6-luna", "thinking": "high", "auth": "subscription" } },
    // Claude reviews, read-only
    "review": { "agentKind": "claude",
      "launchProfile": { "provider": "claude-code", "model": "claude-opus-5-5", "thinking": "high", "auth": "subscription" } },
    // GLM does the small stuff (via Pi)
    "quick": { "agentKind": "pi",
      "launchProfile": { "provider": "zai", "model": "glm-5.3-flash", "thinking": "low", "auth": "subscription" } }
  }
}
```

`baa-ton-configure` writes this for you. A profile that's missing or incomplete fails closed; it never falls back to another model.

## What it won't do

- Push, merge, deploy or run cleanup sweeps without asking you.
- Let two writers share a worktree, a port or a database name.
- Hide an agent. Everything runs in a Herdr pane you can see.

## More

- [Operating Baa-ton](docs/OPERATIONS.md): every install path, updates, migration, harness support, guarantees and tests
- [Workflow tools and MCP setup](packages/herdr-tools/README.md)
- [Event controller](packages/controller/README.md)
- [Adding a harness](docs/ADDING-A-HARNESS.md)
- [Design philosophy](docs/DESIGN-PHILOSOPHY.md)
