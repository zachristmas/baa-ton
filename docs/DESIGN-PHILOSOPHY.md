# Design principles

The intended path is **dot → a fast local Codex executor → native HERDR → authorized local and SSH workspaces**. Baa-ton supplies the small CLI/MCP execution layer. The host app supplies the voice/task handoff; a direct dot MCP connector is not part of this repository.

1. **The human can intervene in any session.** A spawned worker can accept a new instruction and record its new task revision. An earlier assignment does not make the human subordinate to a root agent.
2. **HERDR owns native resources.** Reuse its workspace, pane, worktree, agent and messaging primitives. Do not build a second lifecycle controller or mirror its process graph.
3. **A scope is explicit and local.** Name the intended workspace and account context. Pause gates that scope's new automation and leaves other scopes and running agents alone. UI focus is not authority.
4. **Profiles choose execution targets.** Codex, Claude, Pi and OpenCode share a small tool surface. Choose exact model, effort and supported service tier; retain each harness's authentication and permissions.
5. **Configuration stays small.** Use JSON for Baa-ton settings, generated native client configuration, and an exact tool ask-list. Native permission requests remain native; supported delegated decisions bind one request, session, revision and input.
6. **Results need evidence.** An idle pane is not completion. Record checks and artifacts, fence stale replies, and use independent verification when the workflow requires it.
7. **Recovery is bounded and visible.** Reconnect to inspected identities. Never repeat an uncertain send automatically, revive cancelled work, silently substitute models, or create a resident supervisor to conceal startup failures.
8. **There is one installer.** People use its terminal UI; agents provide setup JSON. Both preview and apply the same selected harnesses, profiles, scopes and connections while preserving unrelated files.

New behavior should fit a short sequence of existing native operations. If it requires another policy engine, registry, daemon or state hierarchy, first simplify the workflow and explain the capability that would justify that cost.
