/**
 * The supervisor is the watcher (docs/SELF-HEALING.md): nothing else needs to
 * arm one. Two failures left a spec run with no nudge and no alert for 11
 * hours:
 * - a root parked its own supervision (herdr_goal action=stop) while the spec
 *   still had unfinished items, and the tick skipped everything, anomaly
 *   detection included, for a stopped supervisor;
 * - the root harness drifted (a Pi root exited and a plain Claude session
 *   took its pane), so nudges and messages went nowhere.
 *
 * This module holds the pieces that decide, as pure functions over the
 * manifest's supervision entry, so the tick stays small and testable.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A supervision that restarted itself for unfinished spec work does not restart again within this. */
export const SPEC_RESTART_MIN_MS = 10 * 60_000;
/** A live agent of another kind than the registered root, this long, is adopted. */
export const ROOT_DRIFT_ADOPT_MS = 5 * 60_000;
/** A root pane with no agent (or a bare shell) this long is dead. */
export const ROOT_DEAD_CONFIRM_MS = 60_000;
export const ROOT_RELAUNCH_INTERVAL_MS = 10 * 60_000;
export const ROOT_RELAUNCH_MAX_PER_HOUR = 3;
const HOUR_MS = 60 * 60_000;
const FINISHED = new Set(["done", "resolved"]);

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * How far the spec run is: { total, done, deferred, open }, or undefined when
 * the project has no spec. `open` counts every item that is neither done,
 * resolved by decision nor deferred.
 */
export function specProgress(manifestPath) {
  try {
    const spec = JSON.parse(readFileSync(join(dirname(dirname(manifestPath)), "spec.json"), "utf8"));
    const items = Array.isArray(spec?.items) ? spec.items : [];
    if (!items.length) return undefined;
    let state = {};
    try {
      state = JSON.parse(readFileSync(join(dirname(manifestPath), "spec-state.json"), "utf8"))?.items ?? {};
    } catch {
      state = {};
    }
    let done = 0;
    let deferred = 0;
    let open = 0;
    for (const item of items) {
      const stage = isRecord(state[item?.id]) && typeof state[item.id].state === "string" ? state[item.id].state : "pending";
      if (stage === "deferred") deferred += 1;
      else if (FINISHED.has(stage)) done += 1;
      else open += 1;
    }
    return { total: items.length, done, deferred, open };
  } catch {
    return undefined;
  }
}

/**
 * What the root's pane holds now. `shell` is true when the pane shows a bare
 * shell prompt (the agent exited), `info` the `agent get` result.
 * ok: the registered agent kind; drift: another agent kind is live in the
 * pane; dead: no agent, or a bare shell.
 */
export function classifyRootPane({ shell, info, root }) {
  if (shell === true) return { status: "dead", reason: "pane_shows_shell_prompt" };
  const body = isRecord(info) && isRecord(info.result) ? info.result : info;
  const agent = isRecord(body) && body.type === "agent_info" && isRecord(body.agent) ? body.agent : undefined;
  if (!agent || typeof agent.agent !== "string" || !agent.agent) return { status: "dead", reason: "no_agent_in_pane" };
  const live = {
    kind: agent.agent,
    ...(typeof agent.name === "string" ? { name: agent.name } : {}),
    ...(typeof agent.agent_status === "string" ? { status: agent.agent_status } : {}),
    ...(isRecord(agent.agent_session) && typeof agent.agent_session.value === "string" ? { session: agent.agent_session.value } : {}),
  };
  if (root.agent_kind && agent.agent !== root.agent_kind) return { status: "drift", live, registered: root.agent_kind };
  return { status: "ok", live };
}

/**
 * Advance the root's health episode kept on its supervision entry, and say
 * what to do now: { adopt: <live kind>, relaunch: true, anomaly: <kind> }.
 * An episode starts when a non-ok state is first seen, and ends when the root
 * is ok again.
 */
export function advanceRootHealth(entry, observation, { timestamp, resumable = false }) {
  if (observation.status === "ok") {
    delete entry.rootHealth;
    return {};
  }
  const health = entry.rootHealth;
  const continuing = health && health.status === observation.status && health.live?.kind === observation.live?.kind;
  const episode = continuing ? health : { status: observation.status, since: timestamp, ...(observation.live ? { live: observation.live } : {}), ...(observation.registered ? { registered: observation.registered } : {}), reason: observation.reason };
  entry.rootHealth = episode;
  const age = Date.parse(timestamp) - Date.parse(episode.since);
  const actions = {};
  if (observation.status === "drift" && age >= ROOT_DRIFT_ADOPT_MS) Object.assign(actions, { adopt: observation.live.kind, anomaly: "root-harness-drift" });
  if (observation.status === "dead" && age >= ROOT_DEAD_CONFIRM_MS) {
    if (resumable) actions.relaunch = true;
    if (!resumable || age >= 2 * ROOT_DEAD_CONFIRM_MS) actions.anomaly = "root-dead";
  }
  return actions;
}

/** Whether a relaunch may run now: at most ROOT_RELAUNCH_MAX_PER_HOUR an hour, ROOT_RELAUNCH_INTERVAL_MS apart. */
export function relaunchAllowed(entry, timestamp) {
  const now = Date.parse(timestamp);
  const recent = (Array.isArray(entry.rootRelaunches) ? entry.rootRelaunches : []).map((at) => Date.parse(at)).filter((at) => now - at < HOUR_MS);
  if (recent.length >= ROOT_RELAUNCH_MAX_PER_HOUR) return false;
  return !recent.length || now - Math.max(...recent) >= ROOT_RELAUNCH_INTERVAL_MS;
}

export function recordRelaunch(entry, timestamp) {
  const now = Date.parse(timestamp);
  entry.rootRelaunches = [...(Array.isArray(entry.rootRelaunches) ? entry.rootRelaunches : []).filter((at) => now - Date.parse(at) < HOUR_MS), timestamp];
}

/** The shell line typed into a dead root pane: the configured resume command, in the project. */
export function rootRelaunchCommand(root, projectDir) {
  if (typeof root?.resume_command !== "string" || !root.resume_command.trim()) return undefined;
  const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  return projectDir ? `cd ${quote(projectDir)} && ${root.resume_command}` : root.resume_command;
}
