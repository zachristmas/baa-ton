---
name: baa-ton-uninstall
description: Remove Baa-ton-managed project skills when the user requests uninstalling those integrations.
---

Preview `src/install.mjs --project-root <project> --harnesses <selected> --remove` in the recorded runtime, then apply the requested removal with --apply. It removes only unchanged files listed in its ownership manifest; edited and unrelated files are retained or cause a conflict. The runtime checkout, state, host MCP settings, HERDR machines/plugins, live agents, and worktrees remain. Explain that separate persistent MCP removal must be requested and reviewed for the exact host entry.
