# Herdr Orchestrator Controller

A local [Herdr](https://herdr.dev) event controller for Baa-ton workflows. It is an observer and root notifier, never a dispatcher: it records durable lane events and sends a non-waiting notification only to an explicitly mapped root agent.

## Supported hook

The plugin declares one harness-neutral event:

- `pane.agent_status_changed` — classifies `done` and `blocked` states for every supported Herdr agent kind.

An opted-in workflow may perform one bounded recent-output read after an `idle` or `working` event to classify a paused goal. This is optional and never changes generic `done` or `blocked` behavior. There is no polling, `agent.wait`, `agent.prompt --wait`, or foreground wait.

## Install (parent review only)

Do **not** enable this plugin. After review, validate a fresh disabled link only:

```sh
herdr plugin unlink herdr-orchestrator-controller
herdr plugin link /Users/zchristmas/baa-ton/packages/controller --disabled
herdr plugin list --plugin herdr-orchestrator-controller --json
herdr plugin log list --plugin herdr-orchestrator-controller --limit 20
```

A reviewed parent supplies configuration in the plugin configuration directory:

```sh
PLUGIN_CONFIG_DIR="$(herdr plugin config-dir herdr-orchestrator-controller)"
install -d -m 700 "$PLUGIN_CONFIG_DIR"
install -m 600 config.sample.json "$PLUGIN_CONFIG_DIR/config.json"
```

Replace all placeholders with real opaque IDs and the absolute workflow manifest path. The controller never links or enables itself.

## Activate an already-installed supervisor

Herdr 0.9.1 runs `[[startup]]` hooks at server startup/live handoff, **not** on
plugin enable, relink, client attach, or config reload. Startup hooks are not
supervised daemons. Disable/enable is therefore not a supervisor restart.
See [Herdr's startup-hook contract](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.1/docs/next/website/src/content/docs/plugins.mdx).

For an already-enabled, configured plugin with no running supervisor, the owning
root can explicitly open the `supervisor` plugin pane:

```sh
herdr plugin pane open --plugin herdr-orchestrator-controller --entrypoint supervisor --placement tab --no-focus
```

Herdr caches manifest entrypoints in its plugin registry. After updating a local
checkout, refresh its existing link with `herdr plugin link /absolute/plugin/root
--enabled` and verify the registered `supervisor` entrypoint before opening it.
Use the already-installed plugin root, not a new copy; do not unlink first or
replace the controller configuration. Relinking refreshes metadata and does not
run startup hooks. For a managed installation, use the documented plugin update
flow instead of converting it to a local link.

Run this from the verified native root context. Let Herdr supply plugin paths,
socket and workspace identity; do not add guessed environment overrides or a
checkout `--cwd`. The foreground Node process runs in a Herdr-owned tab and uses
the same config-directory lease as the startup path. If another supervisor owns
the lease it reports `supervisor_already_running` and exits without starting a
second loop. An unreadable lease also fails closed; inspect it instead of deleting it.

Confirm the pane output (`started: true`), live process and matching lease before
a notification trial. A pane is not an agent or a new Baa-ton root. Preserve the
controller config, workflow manifests and Herdr server. Opening this pane does
not hot-reload or replace a running supervisor; stop an existing instance only
through an explicitly authorized lifecycle action, then verify lease release.
Closing this pane stops its foreground service, so it is not routine trial cleanup.

## Safety model

- Configuration maps one verified root and explicit child lanes to workflow IDs.
- Event identity is `{ pane_id, workspace_id }`; target names are verified only through live `agent.get` results.
- Every accepted event is atomically appended under `workflow.eventController.events`; duplicate events do not wake the root twice.
- Root unavailability leaves a durable pending event. Ambiguous delivery becomes uncertain and is not retried automatically.
- The optional parent-goal supervisor sends one non-waiting recovery nudge per durable work transition, only after the mapped Pi root has fully settled. Delivered/uncertain wakes survive restarts without replay; terminal snapshots cannot release an active run. See the [supervisor wake protocol and rollout limits](../herdr-tools/GOAL-ADAPTER-PROTOCOL.md#supervisor-wake-protocol).
- The controller never dispatches, resumes, closes, creates topology, mutates Git, or contacts external services.

Each supervisor tick compares the latest recorded lane transition against a five-minute wall-clock threshold. A routed lane that remains `working` beyond that threshold emits one durable `stall-suspected` signal per stale period and wakes its root; the signal is advisory, may be a false positive on a genuinely slow turn, and tells the root to inspect rather than declaring the lane dead.

## Validate

```sh
npm test
```

Tests use a temporary mocked JSON-line socket and cover strict configuration and payload validation, concurrent event serialization, event deduplication, root identity checks, parent-goal scheduling, concurrent one-shot delivery, legacy/interrupted-send suppression, authoritative root-run gating, unavailable-root recovery, generic multi-harness events, and optional paused-goal classification. They do not contact a live Herdr server or alter a workspace.
