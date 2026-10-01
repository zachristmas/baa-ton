---
name: baa-ton-end
description: End orchestration for an explicitly selected Baa-ton scope or job without closing native sessions.
---

Identify the scope/job from the user's request and inspect its current state. For a completed goal use herdr_goal action=complete. For an abandoned job use herdr_cancel with the reason. Report remaining running native agents: these commands do not stop processes, close panes, remove worktrees, merge, or push. Such actions require a separate explicit request through their native tools. Do not affect other scopes.
