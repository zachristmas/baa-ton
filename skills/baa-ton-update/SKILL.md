---
name: baa-ton-update
description: Review and apply an explicitly requested Baa-ton runtime or project-skill update while preserving local work.
---

Inspect the recorded runtime's Git status and upstream first. Preserve dirty files and local commits. An update request permits fetching and reviewing changes; never reset, delete, or silently replace local work. Use a separate checkout when needed. Run the runtime's tests, show compatibility changes, then rerun its project installer in preview mode and apply the reviewed skill update.

The installer preserves modified or unowned skill files by refusing the conflicting installation. Resolve those files with the user. It does not update MCP host configuration, interrupt sessions, migrate legacy state, or restart HERDR. Do not present a moved runtime as active until its configured absolute path and live client tools are verified.
