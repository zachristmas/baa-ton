#!/usr/bin/env node
/**
 * The supervisor's spec host (spec-handover.mjs): one process per root with
 * a spec, started and restarted by the supervisor (which restarts on every
 * deploy). It loads the root extension headless, as the root, and runs the
 * spec driver (herdr_spec action=advance) on its own timer, so the loop
 * never waits on the root's turn. The root receives rootAsks and decisions
 * through its digest as before; its own herdr_spec tools stay clients of
 * the same state.
 *
 * Environment (set by the supervisor): HERDR_ENV=1, HERDR_PANE_ID and
 * HERDR_WORKSPACE_ID of the root, HERDR_PLUGIN_CONFIG_DIR, HERDR_SOCKET_PATH,
 * BAATON_SPEC_HOST=1; cwd is the root's project. It exits when the
 * supervisor goes away (IPC disconnect), and when a pass runs longer than
 * PASS_LIMIT_MS so the supervisor starts a fresh one.
 */
import { execFile } from "node:child_process";
import { watch as watchPath } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HEARTBEAT_MS, readHostLease, renewHostLease } from "./spec-handover.mjs";
import { specDriverTimer } from "./spec-timer.mjs";

export const PASS_LIMIT_MS = 20 * 60_000;
const MANIFEST_DIR = join(".baa-ton", "herdr-orchestrator");

/** The part of Pi's extension API the extension uses, without a session. */
export function headlessPi({ tools = new Map(), log = () => {} } = {}) {
  return {
    tools,
    on() {},
    registerCommand() {},
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    getActiveTools: () => [...tools.keys()],
    setActiveTools() {},
    sendMessage(message) {
      log({ message: String(message?.content ?? "").slice(0, 300) });
    },
    exec(command, args, options = {}) {
      return new Promise((resolve) => {
        execFile(command, args, { cwd: options.cwd, signal: options.signal, timeout: options.timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
          resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: error ? (typeof error.code === "number" ? error.code : 1) : 0, killed: Boolean(error?.killed) });
        });
      });
    },
  };
}

/**
 * A context for tool calls: no UI, never streaming. Planning and dispatch
 * prove the caller acts for the root's live Pi session (the session file
 * and UUID Herdr records for the root pane). The host has no session of its
 * own, so `session` supplies the root's, read from Herdr before each pass.
 */
export function headlessContext(cwd, session = {}) {
  const ui = new Proxy({}, { get: () => () => undefined });
  const sessionManager = { getSessionFile: () => session.file, getSessionId: () => session.id };
  return { cwd, hasUI: false, mode: "json", ui, sessionManager, isIdle: () => true, hasPendingMessages: () => false, abort() {}, signal: undefined };
}

/**
 * The root's live Pi session: Herdr's agent record for the root pane (this
 * host's HERDR_PANE_ID) names the session file, whose header holds the UUID.
 * Only a Pi agent in exactly that pane and workspace counts.
 */
export async function rootSession(pi, { paneId = process.env.HERDR_PANE_ID, workspaceId = process.env.HERDR_WORKSPACE_ID } = {}) {
  if (!paneId || !workspaceId) return {};
  const result = await pi.exec("herdr", ["agent", "get", paneId], { timeout: 30_000 });
  // Herdr answered that the pane has no agent: the root is gone.
  if (result.code !== 0) return /agent_not_found|agent_not_running|no agent/i.test(`${result.stdout}\n${result.stderr}`) ? { gone: true } : {};
  let agent;
  try {
    const parsed = JSON.parse(result.stdout);
    agent = (parsed?.result ?? parsed)?.agent;
  } catch {
    return {};
  }
  if (!agent || agent.agent !== "pi") return { gone: true };
  if (agent.pane_id !== paneId || agent.workspace_id !== workspaceId || agent.agent_session?.kind !== "path") return {};
  const file = agent.agent_session.value;
  try {
    const header = JSON.parse((await readFile(file, "utf8")).split("\n", 1)[0]);
    return header?.type === "session" && typeof header.id === "string" ? { file, id: header.id } : { file };
  } catch {
    return { file };
  }
}

export async function runSpecHost({ cwd = process.cwd(), loadExtension, readSession, now = () => Date.now(), exit = (code) => process.exit(code), timerOptions = {} } = {}) {
  const stateDir = join(cwd, MANIFEST_DIR);
  const logPath = join(stateDir, "spec-driver.log");
  const write = (entry) => appendFile(logPath, `${JSON.stringify({ at: new Date(now()).toISOString(), host: process.pid, ...entry })}\n`, { mode: 0o600 }).catch(() => undefined);
  const startedAt = new Date(now()).toISOString();
  // The root session last seen live, kept across host restarts, so the loop
  // goes on when the root is busy, hung or gone.
  const previous = readHostLease(stateDir);
  const session = previous?.rootSession?.file ? { ...previous.rootSession } : {};
  const extra = { rootGone: false };
  const renew = () => {
    try {
      renewHostLease(stateDir, { startedAt, now: now(), rootGone: extra.rootGone, rootSession: session });
    } catch {
      // The root keeps driving while there is no lease.
    }
  };
  renew();
  // Not unref'd: the heartbeat keeps the host alive between passes.
  const heartbeat = setInterval(renew, HEARTBEAT_MS);
  const pi = headlessPi({ log: write });
  const extension = await (loadExtension ?? defaultLoadExtension)();
  extension(pi);
  const tool = pi.tools.get("herdr_spec");
  if (!tool) throw new Error("the extension registered no herdr_spec tool");
  const ctx = headlessContext(cwd, session);
  let passStartedAt;
  const watchdog = setInterval(() => {
    if (passStartedAt !== undefined && now() - passStartedAt > PASS_LIMIT_MS) {
      void write({ error: `a driver pass ran over ${Math.round(PASS_LIMIT_MS / 60_000)} min; exiting so the supervisor starts a fresh host` }).then(() => exit(3));
    }
  }, 30_000);
  watchdog.unref?.();
  write({ started: true, cwd });
  let lastSkip;
  const timer = specDriverTimer({
    run: async () => {
      passStartedAt = now();
      try {
        const live = await (readSession ?? rootSession)(pi).catch(() => ({}));
        if (live.file) Object.assign(session, { file: live.file, id: live.id });
        // Unknown (Herdr did not answer) leaves the last answer in place.
        if (live.file || live.gone) extra.rootGone = Boolean(live.gone);
        renew();
        const result = await tool.execute("spec-host", { action: "advance" }, undefined, undefined, ctx);
        return result?.details ?? {};
      } finally {
        passStartedAt = undefined;
      }
    },
    log: (result, reason) => {
      if (result?.skipped !== undefined) {
        if (result.skipped !== lastSkip) void write({ trigger: reason, skipped: result.skipped });
        lastSkip = result.skipped;
        return;
      }
      lastSkip = undefined;
      if (result?.actions?.length || result?.rootAsks?.length) void write({ trigger: reason, actions: result.actions, rootAsks: result.rootAsks });
    },
    onError: (error) => void write({ error: String(error?.message ?? error).slice(0, 500) }),
    // A pass shortly after the manifest changes (lane receipts and statuses).
    watch: (onChange) => {
      try {
        const watcher = watchPath(stateDir, (_event, file) => {
          if (file === "manifest.json") onChange();
        });
        return () => watcher.close();
      } catch {
        return () => {};
      }
    },
    ...timerOptions,
  });
  timer.start?.();
  return {
    timer,
    stop() {
      clearInterval(heartbeat);
      clearInterval(watchdog);
      timer.stop?.();
    },
  };
}

async function defaultLoadExtension() {
  const require = createRequire(import.meta.url);
  const jiti = require("jiti")(import.meta.url);
  const { default: extension } = await jiti.import(fileURLToPath(new URL("./index.ts", import.meta.url)));
  return extension;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The supervisor holds the other end: when it exits, so does the host.
  process.on("disconnect", () => process.exit(0));
  runSpecHost().catch((error) => {
    process.stderr.write(`spec host failed: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
