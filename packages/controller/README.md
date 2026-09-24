# Herdr Orchestrator Controller

A local [Herdr](https://herdr.dev) event controller for Baa-ton workflows. It records durable lane events and child messages and delivers them to an explicitly mapped root agent as batched, non-waiting digests. It never dispatches work.

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

## Safety model

- Configuration maps one verified root and explicit child lanes to workflow IDs.
- Event identity is `{ pane_id, workspace_id }`; target names are verified only through live `agent.get` results.
- Every accepted event is atomically appended under `workflow.eventController.events`; duplicate events do not wake the root twice.
- Root unavailability leaves a durable pending event. Ambiguous delivery becomes uncertain and is not retried automatically.
- The optional parent-goal supervisor sends one non-waiting recovery nudge per durable work transition, only after the mapped Pi root has fully settled. Delivered/uncertain wakes survive restarts without replay; terminal snapshots cannot release an active run. See the [supervisor wake protocol and rollout limits](../herdr-tools/GOAL-ADAPTER-PROTOCOL.md#supervisor-wake-protocol).
- The controller never dispatches, resumes, closes, creates topology, mutates Git, or contacts external services.

## Root digests

Lane `done`, `blocked` and `goal-paused` events, child messages and open lane requests (`laneRequests`, from `herdr_request`) are not sent one by one. The dispatcher (`dispatchRootDigest`) sends everything the root has not seen as one `[Baa-ton digest]` prompt:

- **Only when the root is free.** For a Pi root, the extension's settled turn record (`supervisor.rootTurn.state === "idle"`) is required, because Herdr can report idle between tool calls. Live Herdr status vetoes only when it is `working` or `blocked`. A root is never prompted mid-turn.
- **After a short collection window.** Herdr reports `done` at the end of every child turn, usually beside that lane's child message. Non-urgent items wait until the oldest is `digest_window_seconds` old (default 60), so a burst becomes one wake. `blocked`, `goal-paused` and new lane requests skip the window. Every digest ends with the list of lane requests still awaiting an answer, so an unanswered request stays in front of the root without waking it again. Set it per project with `program.digest_window_seconds` (0–3600) in the controller config; `BAA_TON_DIGEST_WINDOW_SECONDS` is a machine-wide override.
- **Once.** Items are marked `sending` and saved before the prompt; an interrupted send becomes `uncertain` and is never replayed. Deferrals are not counted as attempts.

Hooks attempt delivery immediately; each supervisor tick (every 5 s) delivers whatever became due. There is no wall-clock stall timer for lanes: a lane that is `working` is left alone, and a stuck lane shows up as `blocked`.

## Directives

A directive is an instruction to the root from Zach or a supervisor session that must not be silently dropped (for example, one that lands while the root has a dialog open). Post one with:

```sh
node packages/controller/directive.mjs post --manifest <parent manifest> --root <orchestrator id> --from zach --text "Run herdr_sweep for the finished lanes."
node packages/controller/directive.mjs list --manifest <parent manifest>
```

- **Storage:** directives live in the parent manifest's top-level `directives`.
- **Delivery:** they go out as urgent digest items. The root acknowledges each one with `herdr_directive action=ack`.
- **Re-send:** if the root finishes a turn after delivery without acknowledging, the directive is sent once more. A root without a turn record gets the re-send after 5 minutes.
- **Escalation:** after the re-send is ignored, or `program.directive_escalate_minutes` (default 15, range 1-1440) after posting, whichever comes first, Zach gets one local Herdr notification (`herdr notification show ... --sound request`). This includes a directive never delivered because the root stayed busy.
- **Scope:** this is the controller's first wall-clock threshold. The notification is local Herdr UI, not an external service.

## Validate

```sh
npm test
```

Tests use a temporary mocked JSON-line socket and cover strict configuration and payload validation, concurrent event serialization, event deduplication, root identity checks, parent-goal scheduling, concurrent one-shot delivery, legacy/interrupted-send suppression, authoritative root-run gating, unavailable-root recovery, generic multi-harness events, and optional paused-goal classification. They do not contact a live Herdr server or alter a workspace.
