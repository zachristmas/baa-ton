/**
 * The spec loop runs in the supervisor, not in the root's turn loop
 * (docs/SPEC-LOOP.md, "Who drives"). For every Pi root whose project has a
 * spec, the supervisor keeps one spec host process running
 * (herdr-tools/spec-host.mjs); it restarts one that exits, with backoff, and
 * stops them all when it stops, so a deploy (the supervisor restarts on new
 * code) restarts the driver too.
 *
 * Alongside it, a root turn that runs ROOT_TURN_LIMIT_MS or longer is
 * interrupted (Escape), once per limit, and reported: the root decides and
 * dispatches, it does not do lane work, and an idle root can take a due
 * /reload.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_SCRIPT = fileURLToPath(new URL("../herdr-tools/spec-host.mjs", import.meta.url));
export const SPEC_FILE = join(".baa-ton", "spec.json");
export const HOST_RESTART_MIN_MS = 30_000;
export const HOST_RESTART_MAX_MS = 10 * 60_000;
export const ROOT_TURN_LIMIT_MS = 30 * 60_000;

/** The roots that get a spec host: Pi roots whose project has a spec. */
export function specRoots(config, exists = existsSync) {
  return (config?.orchestrators ?? []).filter(
    (orchestrator) => (orchestrator.root?.agent_kind ?? "pi") === "pi" && orchestrator.program?.id && orchestrator.root?.pane_id && exists(join(orchestrator.program.id, SPEC_FILE)),
  );
}

function defaultSpawnHost({ orchestrator, configDir, script = HOST_SCRIPT }) {
  const child = spawn(process.execPath, [script], {
    cwd: orchestrator.program.id,
    env: {
      ...process.env,
      HERDR_ENV: "1",
      HERDR_PANE_ID: orchestrator.root.pane_id,
      HERDR_WORKSPACE_ID: orchestrator.root.workspace_id,
      HERDR_PLUGIN_CONFIG_DIR: configDir,
      BAATON_SPEC_HOST: "1",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
  child.stderrTail = () => stderr;
  return child;
}

export function createSpecHosts({ configDir, loadConfig, spawnHost = defaultSpawnHost, script = HOST_SCRIPT, exists = existsSync, clock = () => Date.now(), log = () => {} }) {
  const hosts = new Map();
  return {
    async tick() {
      if (!exists(script)) return;
      const config = await Promise.resolve(loadConfig()).catch(() => undefined);
      if (!config) return;
      const wanted = new Map(specRoots(config, exists).map((orchestrator) => [orchestrator.id, orchestrator]));
      for (const [id, host] of hosts)
        if (!wanted.has(id)) {
          host.child?.kill("SIGTERM");
          hosts.delete(id);
          log(`spec host for ${id} stopped: the root no longer has a spec`);
        }
      for (const [id, orchestrator] of wanted) {
        const host = hosts.get(id) ?? { restarts: 0, backoffMs: HOST_RESTART_MIN_MS };
        hosts.set(id, host);
        if (host.child && host.child.exitCode === null && host.child.signalCode === null) continue;
        if (host.retryAt && clock() < host.retryAt) continue;
        const child = spawnHost({ orchestrator, configDir, script });
        Object.assign(host, { child, startedAt: clock(), retryAt: undefined });
        log(`spec host for ${id} started (pid ${child.pid ?? "?"}) in ${orchestrator.program.id}`);
        child.on?.("exit", (code, signal) => {
          if (host.child !== child) return;
          // A host that dies within a minute backs off, doubling to the cap.
          const quick = clock() - host.startedAt < 60_000;
          host.backoffMs = quick ? Math.min(host.backoffMs * 2, HOST_RESTART_MAX_MS) : HOST_RESTART_MIN_MS;
          host.retryAt = clock() + host.backoffMs;
          host.restarts += 1;
          const tail = child.stderrTail?.().trim().split("\n").slice(-3).join(" | ");
          log(`spec host for ${id} exited (${signal ?? code}); restarting in ${Math.round(host.backoffMs / 1000)}s${tail ? `: ${tail}` : ""}`);
        });
      }
    },
    stop() {
      for (const host of hosts.values()) host.child?.kill("SIGTERM");
      hosts.clear();
    },
    get size() {
      return hosts.size;
    },
  };
}

/**
 * Interrupt a root turn that ran ROOT_TURN_LIMIT_MS or longer. `status(paneId)`
 * answers Herdr's agent_status (or undefined), `interrupt(paneId)` sends
 * Escape. A turn is continuous "working"; any other status ends it.
 */
export function createRootTurnWatch({ loadConfig, status, interrupt, anomaly = async () => undefined, clock = () => Date.now(), log = () => {} }) {
  const turns = new Map();
  return {
    async tick() {
      const config = await Promise.resolve(loadConfig()).catch(() => undefined);
      for (const orchestrator of config?.orchestrators ?? []) {
        const paneId = orchestrator.root?.pane_id;
        if (!paneId) continue;
        const now = clock();
        const current = await Promise.resolve(status(paneId)).catch(() => undefined);
        const turn = turns.get(paneId) ?? {};
        if (current !== "working") {
          turns.set(paneId, { lastInterruptAt: turn.lastInterruptAt });
          continue;
        }
        turn.since ??= now;
        turns.set(paneId, turn);
        if (now - turn.since < ROOT_TURN_LIMIT_MS) continue;
        if (turn.lastInterruptAt !== undefined && now - turn.lastInterruptAt < ROOT_TURN_LIMIT_MS) continue;
        const minutes = Math.round((now - turn.since) / 60_000);
        try {
          await interrupt(paneId);
        } catch (error) {
          log(`root turn in ${paneId}: interrupt failed: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        turn.lastInterruptAt = now;
        turn.since = now;
        log(`root turn in ${paneId} ran ${minutes} min; interrupted it`);
        await Promise.resolve(
          anomaly({
            kind: "root-turn-too-long",
            signature: `root-turn:${paneId}:${new Date(now).toISOString()}`,
            summary: `the root in ${paneId} stayed in one turn for ${minutes} min, so the supervisor interrupted it; the root decides and dispatches and must not do lane work itself`,
            evidence: [`root ${orchestrator.id}`, `manifest ${orchestrator.program?.parent_manifest_path ? dirname(orchestrator.program.parent_manifest_path) : "?"}`],
          }),
        ).catch(() => undefined);
      }
    },
  };
}
