---
name: baa-ton-sweep
description: Inspect stale Baa-ton orchestration records and propose scoped cleanup.
---

Read the selected scope and compare recorded jobs with native status. Cancel abandoned orchestration records only within the user's request. Optional pane cleanup runs through the existing one-shot `herdr_tick`: `cleanup.mode=preview` reports exact candidates; `cleanup.mode=close` is an explicit opt-in for Baa-ton-created panes that pass every verification, identity, process, approval, descendant, grace, transcript, and clean-worktree check. Adopted/reconnected panes and all workspaces/worktrees remain open. A stale or uncertain close needs exact-pane inspection before any retry. Retain result/transcript evidence; do not infer success from an idle pane.
