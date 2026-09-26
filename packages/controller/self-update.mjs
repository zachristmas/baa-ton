/**
 * Deploy without anyone: when Baa-ton's origin/main moves, the supervisor
 * tests the new commit in a scratch worktree and, when green, fast-forwards
 * the installed checkouts (its own and the root extension's). The
 * supervisor then restarts on its own code-change watcher, every hook
 * already starts a fresh process, and an idle Pi root is sent /reload
 * (which keeps its session) once per new commit.
 *
 * Guard rails: only a clean checkout on main that fast-forwards; one test
 * run at a time, tracked by the supervisor (never detached); a red commit
 * is never applied and is reported once; disabled by BAATON_SELF_UPDATE=0 or
 * {"enabled": false} in <configDir>/self-update.json.
 *
 * The suite spawns many processes, so a machine that takes seconds to start
 * one (heavy load, OS exec checks) fails it for reasons unrelated to the
 * commit. A test run waits while starting Node takes over SPAWN_SLOW_MS, and
 * a red run is retried at the next checks, SELF_UPDATE_TEST_ATTEMPTS runs in
 * all, before the commit counts as failed.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export const SELF_UPDATE_CHECK_MS = 10 * 60_000;
export const SELF_UPDATE_TEST_TIMEOUT_MS = 30 * 60_000;
/** How long a /reload has to show up in the root's runtime record. */
export const RELOAD_CONFIRM_MS = 60_000;
export const RELOAD_ATTEMPTS = 5;
export const SELF_UPDATE_TEST_ATTEMPTS = 3;
export const SPAWN_SLOW_MS = 5_000;
/** A root busy this long past a due reload is reported: it never goes idle for /reload. */
export const RELOAD_BUSY_MS = 30 * 60_000;
const execFileAsync = promisify(execFile);

/** Milliseconds to start and end a bare Node process. */
async function defaultSpawnProbe() {
  const started = Date.now();
  await execFileAsync(process.execPath, ["-e", "0"], { timeout: 120_000 }).catch(() => undefined);
  return Date.now() - started;
}

async function defaultRun(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...options });
  return stdout.trim();
}

/** `npm ci` when the lockfile changed, then `npm test`; resolves { ok, output }. Tracked, never detached. */
function defaultStartTests({ dir, install, env = process.env }) {
  const runOne = (args) => runCommand("npm", args);
  const runCommand = (command, args) =>
    new Promise((resolve) => {
      const child = spawn(command, args, { cwd: dir, env: { ...env, BAATON_SELF_UPDATE: "0" }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const keep = (chunk) => {
        output = (output + chunk).slice(-8000);
      };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      const timer = setTimeout(() => child.kill("SIGTERM"), SELF_UPDATE_TEST_TIMEOUT_MS);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, output });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ ok: false, output: String(error?.message ?? error) });
      });
    });
  // For tests of the supervisor itself: a JSON command array instead of npm test.
  const override = env.BAATON_SELF_UPDATE_TEST_COMMAND ? JSON.parse(env.BAATON_SELF_UPDATE_TEST_COMMAND) : undefined;
  return (async () => {
    if (override) return runCommand(override[0], override.slice(1));
    if (install) {
      const installed = await runOne(["ci", "--no-audit", "--no-fund"]);
      if (!installed.ok) return installed;
    }
    return runOne(["test"]);
  })();
}

export function selfUpdateEnabled(state, env = process.env) {
  return env.BAATON_SELF_UPDATE !== "0" && state?.enabled !== false;
}

/**
 * The updater. Effects are injected: `run(command, args, options)` for git
 * and npm, `startTests({ dir, install })`, `notify({ title, body })`,
 * `runtime()` (live runtime records), `ready(paneId, expected)` and
 * `prompt(paneId, text)` for the root reload, `commitOf(checkout)`.
 */
export function createSelfUpdater({
  configDir,
  ownCheckout,
  run = defaultRun,
  startTests = defaultStartTests,
  notify = async () => undefined,
  runtime = () => [],
  ready = async () => ({ ok: false, reason: "no Herdr" }),
  prompt = async () => undefined,
  commitOf,
  // Root panes (from the controller config): only roots get /reload, never
  // the Pi extension records of lanes. Undefined means no filter.
  rootPanes = async () => undefined,
  // Whether a dialog (question or permission prompt) is on the pane's screen.
  dialogOpen = async () => false,
  // Self-healing: a failed update test or an unconfirmed reload is an anomaly.
  anomaly = async () => undefined,
  prune = () => 0,
  // Wall time to start a process; a test run waits while it is slow.
  spawnProbe = defaultSpawnProbe,
  now = () => new Date().toISOString(),
  env = process.env,
} = {}) {
  const statePath = join(configDir, "self-update.json");
  let active;
  const load = async () => {
    try {
      return JSON.parse(await readFile(statePath, "utf8"));
    } catch {
      return {};
    }
  };
  const save = async (state) => {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const temporary = `${statePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, statePath);
  };
  const git = (checkout, ...args) => run("git", ["-C", checkout, ...args]);
  const headOf = commitOf ?? ((checkout) => git(checkout, "rev-parse", "HEAD").catch(() => undefined));
  const clean = async (checkout) => (await git(checkout, "status", "--porcelain", "--untracked-files=no")) === "";
  const checkouts = () => [...new Set([ownCheckout, ...runtime().filter((record) => record.role === "extension" && record.checkout).map((record) => record.checkout)].filter(Boolean))];

  /** Whether a checkout can take a fast-forward to `target`; the reason when not. */
  const eligible = async (checkout, target) => {
    if ((await git(checkout, "rev-parse", "--abbrev-ref", "HEAD").catch(() => "")) !== "main") return "not on main";
    if (!(await clean(checkout).catch(() => false))) return "has uncommitted changes";
    const head = await git(checkout, "rev-parse", "HEAD");
    if (head === target) return "current";
    const ancestor = await git(checkout, "merge-base", "--is-ancestor", head, target).then(() => true, () => false);
    return ancestor ? undefined : "does not fast-forward to origin/main";
  };

  /** An idle Pi root still running older code than its checkout gets /reload, once per commit. */
  /**
   * An idle or done Pi root on older code than its checkout gets /reload,
   * never while a dialog is on its screen. A reload counts only once the
   * root's runtime record shows the new commit; otherwise it is retried
   * after RELOAD_CONFIRM_MS, up to RELOAD_ATTEMPTS times, then the user is
   * told once.
   */
  const reloadRoots = async (state) => {
    const events = [];
    const roots = await Promise.resolve(rootPanes()).catch(() => undefined);
    const reloads = (state.reloads ??= {});
    for (const record of runtime()) {
      if (record.role !== "extension" || !record.paneId || !record.checkout) continue;
      if (roots && !roots.has(record.paneId)) continue;
      const disk = await headOf(record.checkout);
      if (!disk || !record.commit) continue;
      // Older state kept a bare commit: treat it as sent, not confirmed.
      let entry = typeof reloads[record.paneId] === "string" ? { commit: reloads[record.paneId], attempts: 1 } : reloads[record.paneId];
      if (disk === record.commit) {
        if (entry?.commit === disk && !entry.confirmedAt) {
          reloads[record.paneId] = { ...entry, confirmedAt: now() };
          events.push(`root reload in ${record.paneId} confirmed on ${disk.slice(0, 12)}`);
        }
        continue;
      }
      if (entry?.commit !== disk) entry = undefined;
      if (entry?.gaveUpAt) continue;
      if (entry?.sentAt && Date.parse(now()) - Date.parse(entry.sentAt) < RELOAD_CONFIRM_MS) continue;
      if ((entry?.attempts ?? 0) >= RELOAD_ATTEMPTS) {
        reloads[record.paneId] = { ...entry, gaveUpAt: now() };
        events.push(`root reload in ${record.paneId} not confirmed after ${entry.attempts} attempts`);
        await Promise.resolve(anomaly({ kind: "reload-unconfirmed", signature: `reload:${record.paneId}:${disk}`, summary: `the root in ${record.paneId} did not reload onto ${disk.slice(0, 12)} after ${entry.attempts} /reload attempts`, evidence: [`runtime record commit ${String(record.commit).slice(0, 12)}`, `checkout ${disk.slice(0, 12)}`] })).catch(() => undefined);
        await notify({ title: "Baa-ton: root did not reload", body: `${record.paneId} still runs ${String(record.commit).slice(0, 12)} after ${entry.attempts} /reload attempts onto ${disk.slice(0, 12)}; reload it by hand.` });
        continue;
      }
      // A dialog was on screen: look again at most once a minute.
      if (entry?.waitingOnDialogAt && Date.parse(now()) - Date.parse(entry.waitingOnDialogAt) < RELOAD_CONFIRM_MS) continue;
      if (!(await clean(record.checkout).catch(() => false))) continue;
      const check = await ready(record.paneId, { pane_id: record.paneId, agent_kind: record.agentKind ?? "pi" });
      // Herdr reports a Pi root that finished its turn as done, or as idle.
      if (!check?.ok || !["idle", "done"].includes(check.agent?.agent_status)) {
        // A root that never goes idle never gets /reload: say so rather than wait in silence.
        const due = entry?.busySince ?? now();
        reloads[record.paneId] = { ...(entry ?? { commit: disk, attempts: 0 }), busySince: due };
        if (!entry?.busyReportedAt && Date.parse(now()) - Date.parse(due) >= RELOAD_BUSY_MS) {
          reloads[record.paneId].busyReportedAt = now();
          const status = check?.agent?.agent_status ?? check?.reason ?? "unknown";
          events.push(`root reload in ${record.paneId} still waiting: the root has been ${status} for ${Math.round((Date.parse(now()) - Date.parse(due)) / 60_000)} min`);
          await Promise.resolve(anomaly({ kind: "reload-unconfirmed", signature: `reload-busy:${record.paneId}:${disk}`, summary: `the root in ${record.paneId} has not been idle for ${Math.round(RELOAD_BUSY_MS / 60_000)}+ min, so it cannot be sent /reload onto ${disk.slice(0, 12)}; it still runs ${String(record.commit).slice(0, 12)}`, evidence: [`status: ${status}`, `attempts so far: ${entry?.attempts ?? 0}`] })).catch(() => undefined);
        }
        continue;
      }
      // Typed into a dialog, /reload would answer it instead of reloading.
      if (await Promise.resolve(dialogOpen(record.paneId)).catch(() => true)) {
        if (!entry?.waitingOnDialogAt) events.push(`root reload in ${record.paneId} waits: a dialog is on screen`);
        reloads[record.paneId] = { ...(entry ?? { commit: disk, attempts: 0 }), waitingOnDialogAt: now() };
        continue;
      }
      const attempts = (entry?.attempts ?? 0) + 1;
      try {
        await prompt(record.paneId, "/reload");
        reloads[record.paneId] = { commit: disk, sentAt: now(), attempts };
        events.push(`sent /reload to the root in ${record.paneId} onto ${disk.slice(0, 12)} (attempt ${attempts})`);
      } catch (error) {
        reloads[record.paneId] = { commit: disk, sentAt: now(), attempts, error: error instanceof Error ? error.message : String(error) };
        events.push(`root reload in ${record.paneId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return events;
  };

  const apply = async (state, target) => {
    const events = [];
    for (const checkout of checkouts()) {
      const reason = await eligible(checkout, target).catch((error) => String(error?.message ?? error));
      if (reason) {
        if (reason !== "current") events.push(`${checkout}: not updated (${reason})`);
        continue;
      }
      const head = await git(checkout, "rev-parse", "HEAD");
      const lockChanged = await git(checkout, "diff", "--quiet", head, target, "--", "package.json", "package-lock.json").then(() => false, () => true);
      await git(checkout, "merge", "--ff-only", "-q", target);
      if (lockChanged) await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: checkout, timeout: 10 * 60_000 }).catch(() => undefined);
      events.push(`${checkout}: ${head.slice(0, 12)} -> ${target.slice(0, 12)}`);
    }
    state.updatedTo = target;
    state.updatedAt = now();
    await notify({ title: "Baa-ton updated", body: `Deployed ${target.slice(0, 12)} after npm test passed. ${events.join("; ")}` });
    return events;
  };

  return {
    /** One supervisor tick's worth: reload roots, finish a test run, or check for a new commit. */
    async tick() {
      const state = await load();
      if (!selfUpdateEnabled(state, env)) return { disabled: true };
      const events = await reloadRoots(state);
      if (active?.done) {
        const { sha, result, dir, checkout } = active;
        active = undefined;
        const attempts = (state.tested?.[sha]?.attempts ?? 0) + 1;
        const final = result.ok || attempts >= SELF_UPDATE_TEST_ATTEMPTS;
        (state.tested ??= {})[sha] = { result: result.ok ? "pass" : final ? "fail" : "retry", at: now(), attempts, ...(result.ok ? {} : { tail: result.output.slice(-1500) }) };
        delete state.testing;
        await git(checkout, "worktree", "remove", "--force", dir).catch(() => rm(dir, { recursive: true, force: true }));
        if (result.ok) events.push(...(await apply(state, sha)));
        else if (!final) events.push(`${sha.slice(0, 12)} failed npm test (run ${attempts} of ${SELF_UPDATE_TEST_ATTEMPTS}); retrying at the next check`);
        else {
          events.push(`${sha.slice(0, 12)} failed npm test ${attempts} times; not deployed`);
          await Promise.resolve(anomaly({ kind: "self-update-test-failed", signature: `update-test:${sha}`, summary: `${sha.slice(0, 12)} failed npm test and was not deployed`, evidence: result.output.split("\n").slice(-30) })).catch(() => undefined);
          await notify({ title: "Baa-ton update failed its tests", body: `${sha.slice(0, 12)} is not deployed. ${result.output.slice(-300)}` });
        }
      } else if (!active && (!state.lastCheckAt || Date.parse(now()) - Date.parse(state.lastCheckAt) >= SELF_UPDATE_CHECK_MS)) {
        state.lastCheckAt = now();
        const pruned = prune();
        if (pruned) events.push(`pruned ${pruned} runtime record(s) of ended processes`);
        const base = checkouts()[0];
        if (base) {
          await git(base, "fetch", "-q", "origin", "main").catch(() => undefined);
          const target = await git(base, "rev-parse", "origin/main").catch(() => undefined);
          const behind = [];
          for (const checkout of checkouts()) {
            if (checkout !== base) await git(checkout, "fetch", "-q", "origin", "main").catch(() => undefined);
            const reason = target ? await eligible(checkout, target).catch((error) => String(error?.message ?? error)) : "origin/main unknown";
            if (!reason) behind.push(checkout);
            else if (reason !== "current") events.push(`${checkout}: ${reason}`);
          }
          const tested = target ? state.tested?.[target]?.result : undefined;
          // Only the real suite is probed; an override (tests of the supervisor) is not.
          const probed = spawnProbe !== defaultSpawnProbe || (startTests === defaultStartTests && !env.BAATON_SELF_UPDATE_TEST_COMMAND);
          const slow = probed && target && behind.length && (!tested || tested === "retry") ? await Promise.resolve(spawnProbe()).catch(() => 0) : 0;
          if (target && behind.length && tested === "pass") events.push(...(await apply(state, target)));
          else if (slow > SPAWN_SLOW_MS) {
            if (!state.deferredSlowAt) events.push(`testing ${target.slice(0, 12)} waits: starting a process takes ${Math.round(slow / 1000)}s, so the suite would time out`);
            state.deferredSlowAt ??= now();
          } else if (target && behind.length && (!tested || tested === "retry")) {
            delete state.deferredSlowAt;
            const dir = join(configDir, "self-update", target.slice(0, 12));
            await git(base, "worktree", "remove", "--force", dir).catch(() => undefined);
            await rm(dir, { recursive: true, force: true });
            await mkdir(join(configDir, "self-update"), { recursive: true, mode: 0o700 });
            await git(base, "worktree", "add", "--detach", "-q", dir, target);
            const head = await git(base, "rev-parse", "HEAD");
            const install = await git(base, "diff", "--quiet", head, target, "--", "package.json", "package-lock.json").then(() => false, () => true);
            if (!install && existsSync(join(base, "node_modules"))) await symlink(join(base, "node_modules"), join(dir, "node_modules"), "dir").catch(() => undefined);
            const run = { sha: target, dir, checkout: base, done: false, result: undefined };
            active = run;
            state.testing = { sha: target, startedAt: now() };
            events.push(`testing ${target.slice(0, 12)} before deploying`);
            Promise.resolve(startTests({ dir, install, env }))
              .then((result) => Object.assign(run, { done: true, result }))
              .catch((error) => Object.assign(run, { done: true, result: { ok: false, output: String(error?.message ?? error) } }));
          }
        }
      }
      await save(state);
      return { events, testing: active ? active.sha : undefined };
    },
  };
}
