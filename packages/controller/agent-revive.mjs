/**
 * Dead-pane fallback for registered agents (docs/SELF-HEALING.md). An agent
 * registered with a resume command (`baa-ton operator register <name>
 * --resume`) is relaunched in its own pane when that pane has no agent left
 * or shows a bare shell: the session exited or crashed. It is never a
 * context-size measure; Claude Code compacts its own session.
 *
 * The pane must look dead on two ticks at least REVIVE_CONFIRM_MS apart, a
 * relaunch waits REVIVE_INTERVAL_MS after the last one, and at most
 * REVIVE_MAX_PER_HOUR run in an hour. Attempts are kept on the agent's record
 * in the operator store, so a supervisor restart does not reset the budget.
 */
export const REVIVE_CONFIRM_MS = 30_000;
export const REVIVE_INTERVAL_MS = 10 * 60_000;
export const REVIVE_MAX_PER_HOUR = 3;
const HOUR_MS = 60 * 60_000;

function operator() {
  return import("../herdr-tools/operator.mjs");
}

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** The shell line typed into the dead pane, or undefined when the agent is not resumable. */
export function reviveCommand(agent) {
  if (!agent?.resume || !agent.paneId) return undefined;
  return agent.cwd ? `cd ${quote(agent.cwd)} && ${agent.resume}` : agent.resume;
}

/**
 * `paneState(agent)` answers { dead: boolean, reason } or undefined when the
 * pane cannot be read (a pane that is gone cannot be relaunched in either).
 * `run(paneId, command)` types the command into the pane.
 * `sessionPane(agent)` answers { paneId, workspaceId } where the agent's
 * session runs now, if anywhere; `paneExists(paneId)` whether the pane is
 * still there. A Herdr restart renames every pane: a session that lives on
 * elsewhere is followed, never started a second time, and a pane that is
 * gone is reported once, not retried.
 */
export function createAgentReviver({ env = process.env, paneState, run, sessionPane = async () => undefined, paneExists = async () => true, anomaly = async () => undefined, notify = async () => undefined, clock = () => Date.now() }) {
  const deadSince = new Map();
  const exhausted = new Set();
  const gone = new Set();
  return {
    async tick() {
      const { operatorStorePath, readOperatorStore, withOperatorStore } = await operator();
      const storePath = operatorStorePath(env);
      const events = [];
      const agents = (await readOperatorStore(storePath)).agents ?? {};
      for (const [name, agent] of Object.entries(agents)) {
        const command = reviveCommand(agent);
        if (!command) continue;
        const state = await paneState(agent).catch(() => undefined);
        const key = `${name}@${agent.paneId}`;
        if (!state?.dead) {
          deadSince.delete(key);
          exhausted.delete(key);
          gone.delete(key);
          continue;
        }
        // The same session live in another pane: follow it (never a second copy).
        const elsewhere = agent.sessionId ? await sessionPane(agent).catch(() => undefined) : undefined;
        if (elsewhere?.paneId && elsewhere.paneId !== agent.paneId) {
          await withOperatorStore(storePath, (store) => {
            const record = store.agents?.[name];
            if (record && record.paneId === agent.paneId) Object.assign(record, { paneId: elsewhere.paneId, ...(elsewhere.workspaceId ? { workspaceId: elsewhere.workspaceId } : {}) });
          });
          deadSince.delete(key);
          events.push(`${name}: its session ${agent.sessionId} runs in pane ${elsewhere.paneId}; registration moved from ${agent.paneId}`);
          continue;
        }
        const now = clock();
        if (!deadSince.has(key)) {
          deadSince.set(key, now);
          continue;
        }
        if (now - deadSince.get(key) < REVIVE_CONFIRM_MS) continue;
        const recent = (agent.revives ?? []).map((at) => Date.parse(at)).filter((at) => now - at < HOUR_MS);
        if (recent.length && now - Math.max(...recent) < REVIVE_INTERVAL_MS) continue;
        if (recent.length >= REVIVE_MAX_PER_HOUR) {
          if (!exhausted.has(key)) {
            exhausted.add(key);
            events.push(`${name}: pane ${agent.paneId} is still dead after ${recent.length} relaunches this hour; waiting`);
            await notify({ title: `Baa-ton: ${name} keeps dying`, body: `${name}'s pane ${agent.paneId} died again after ${recent.length} relaunches this hour (${state.reason}). Relaunching pauses until the hour's budget frees up.` }).catch(() => undefined);
          }
          continue;
        }
        // A pane that no longer exists cannot be relaunched in: say so once.
        if (!(await paneExists(agent.paneId).catch(() => true))) {
          if (!gone.has(key)) {
            gone.add(key);
            events.push(`${name}: pane ${agent.paneId} no longer exists and its session runs nowhere; not relaunched (register it again from its new pane)`);
            await notify({ title: `Baa-ton: ${name} is gone`, body: `${name}'s pane ${agent.paneId} no longer exists and its session is not running anywhere. Start it again and run baa-ton operator register from its pane.` }).catch(() => undefined);
          }
          continue;
        }
        const at = new Date(now).toISOString();
        let started = true;
        try {
          await run(agent.paneId, command);
        } catch (error) {
          started = false;
          events.push(`${name}: relaunch in pane ${agent.paneId} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        // An attempt counts against the budget whether or not it started.
        await withOperatorStore(storePath, (store) => {
          const record = store.agents?.[name];
          if (record && record.paneId === agent.paneId) record.revives = [...(record.revives ?? []).filter((item) => now - Date.parse(item) < HOUR_MS), at];
        });
        deadSince.delete(key);
        if (!started) continue;
        events.push(`${name}: pane ${agent.paneId} was dead (${state.reason}); relaunched with "${agent.resume}"`);
        await anomaly({
          kind: "agent-relaunched",
          signature: `relaunch:${name}:${at}`,
          summary: `${name}'s pane ${agent.paneId} had no live agent (${state.reason}), so the supervisor relaunched it; find what ended the session`,
          evidence: [`command: ${command}`, `relaunches this hour: ${recent.length + 1} of ${REVIVE_MAX_PER_HOUR}`],
        }).catch(() => undefined);
      }
      return { events };
    },
  };
}
