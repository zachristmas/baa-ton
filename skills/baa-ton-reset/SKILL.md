---
name: baa-ton-reset
description: Recover one Baa-ton job or scope after the user requests a reset or reconnect.
---

Inspect the exact scope, job, and current native pane. Prefer herdr_reconnect with a freshly observed terminal ID, or cancel an abandoned job and create a fresh assignment. Direct human redirection uses herdr_message redirect=true and a new request ID; a worker records its own direct instruction without sending it again. Never wipe state, restart HERDR, close panes, replay uncertain delivery, or reset all scopes as a convenience.
