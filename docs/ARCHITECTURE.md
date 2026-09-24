# Architecture

## Purpose

Baa-ton is the canonical, versioned source for local Herdr orchestration tooling. It separates workflow operations from event delivery while retaining their shared durable-manifest contract.

## Components

| Component | Repository source | Responsibility |
| --- | --- | --- |
| Workflow tools | `packages/herdr-tools/index.ts` | Plans and dispatches explicitly owned lanes, persists workflow manifests, mediates root-only approval, and observes lanes. |
| MCP bridge | `packages/herdr-tools/mcp-server.mjs` | Exposes the workflow tools to any compatible local MCP client. |
| Event controller | `packages/controller/controller.mjs` | Validates mapped status hooks, records durable event facts, and sends a non-waiting root notification. |
| Plugin metadata | `packages/controller/herdr-plugin.toml` | Declares the supported agent-status hook and Herdr-owned startup supervisor. |

## Runtime installation

The workflow tools run through the local MCP bridge. The controller installs with `herdr plugin link … --disabled`. Exact reviewed commands are in the root [README](../README.md). The checked-in source is canonical.

## Invariants

1. **Local and durable first.** Persist workflow/event state atomically before a notification or other effect.
2. **Explicit ownership.** A workflow may operate only resources it created and recorded.
3. **Root-only authority.** Child lanes report requests and evidence; they do not approve dispatch, resume, or close operations.
4. **Event-driven control.** Treat lifecycle signals as observations. Never turn them into autonomous Git, PR, deployment, production, or external actions.
5. **Bounded reads and foreground tests.** No polling loops, detached jobs, or hidden background test workers.
6. **Fail closed.** Reject malformed mappings, identity drift, ambiguous targets, and unsafe local file permissions before mutation.
7. **Forward-compatible manifests.** Lanes dispatched before an upgrade keep running MCP bridges loaded from the older release, and they share the manifest with the upgraded root and controller. Two rules follow:
   - **Strict objects:** never add a field inside an object an earlier release validates strictly. That includes parent goals and their `supervisor`, `lastDelivery`, `rootTurn` and `rootActivity`. The oldest supported release's validator is vendored in `packages/controller/test/fixtures/`, and `controller.test.mjs` plus the smoke check run manifests written by current code through it after every write. #28's `supervisor.intervalPolicy` broke `herdr_message`/`herdr_complete` for pre-upgrade lanes; the follow-up moved that marker to `rootSupervision` and strips the key from existing goals.
   - **New top-level fields:** before #28, `loadManifest` kept only the top-level keys it knew. A pre-upgrade lane's `herdr_complete` therefore rewrites the manifest without `approvalPolicyAck`, `leases`, `directives` or `rootSupervision`. New state must tolerate that loss, or live inside an object older writers already carry through unchanged.

## Validation

Run `npm test` from the repository root. The workflow smoke check is deterministic and mocks Herdr CLI interactions; the controller test suite uses a temporary JSON-line socket. Neither test creates a live Herdr workspace, tab, pane, or agent.

`npm test` runs through `packages/herdr-tools/test/support/run-hermetic.mjs`. It removes session variables (`CLAUDE_CODE_*`, `HERDR_*`, `PI_*`, `BAA_*`, `CODEX_*`, `OPENCODE_*`) and puts stub `herdr`, `claude`, `codex`, `opencode` and `pi` binaries first on `PATH`, so results are the same in a terminal, inside a Claude or Pi session in a Herdr pane, and in CI. Running `node --test` directly from an agent session inherits that session's identity and can take live-identity paths the fakes do not model.
