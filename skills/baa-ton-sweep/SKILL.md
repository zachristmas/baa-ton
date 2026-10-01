---
name: baa-ton-sweep
description: Inspect stale Baa-ton orchestration records and propose scoped cleanup.
---

Read the selected scope and compare recorded jobs with native status. Cancel abandoned orchestration records only within the user's request. The v2 runtime intentionally has no automatic workspace/worktree deletion. If the user wants native resources removed, show exact targets and their dirty/running state first, then use the appropriate native tool within that authorization. Retain uncertain-delivery evidence; do not infer success from an idle pane.
