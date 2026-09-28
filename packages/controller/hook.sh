#!/bin/sh
# Herdr runs this for every pane.agent_status_changed event, so it must be
# near-free: it queues the event as a file and exits. The supervisor handles
# the queue (controller.mjs drainHookQueue); no Node process per event.
#
# Only when queued events sit unhandled for 2 minutes (the supervisor is down
# or hung) does it run the Node fallback, which checks the supervisor's
# keepalive and handles the queue itself, at most one at a time.
set -u

dir="${HERDR_PLUGIN_CONFIG_DIR:-${HERDR_PLUGIN_STATE_DIR:-}}"
[ -n "$dir" ] || exec node controller.mjs hook
queue="$dir/hook-queue"
[ -d "$queue" ] || mkdir -p "$queue" || exec node controller.mjs hook

name="$queue/$$-${RANDOM:-0}"
{
  printf '%s\n' "${HERDR_PLUGIN_EVENT:-}"
  printf '%s' "${HERDR_PLUGIN_EVENT_JSON:-}"
} > "$name.tmp" && mv "$name.tmp" "$name.event" || exec node controller.mjs hook

# A queued event older than 2 min means nobody is handling the queue.
stale="$(find "$queue" -name '*.event' -mmin +2 2>/dev/null | head -n 1)"
[ -n "$stale" ] || exit 0
mkdir "$queue.fallback" 2>/dev/null || exit 0
trap 'rmdir "$queue.fallback" 2>/dev/null' EXIT
if [ -n "${VOLTA_HOME:-}" ] && [ -x "${VOLTA_HOME}/bin/volta" ]; then
  node_bin="$("${VOLTA_HOME}/bin/volta" which node)"
  if [ -n "${node_bin}" ] && [ -x "${node_bin}" ]; then
    "${node_bin}" controller.mjs hook-drain
    exit $?
  fi
fi
node controller.mjs hook-drain
