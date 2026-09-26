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
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export const SELF_UPDATE_CHECK_MS = 10 * 60_000;
export const SELF_UPDATE_TEST_TIMEOUT_MS = 30 * 60_000;
const execFileAsync = promisify(execFile);

async function defaultRun(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...options });
  return stdout.trim();
}

/** `npm ci` when the lockfile changed, then `npm test`; resolves { ok, output }. Tracked, never detached. */
function defaultStartTests({ dir, install, env = process.env }) {
  const runOne = (args) =>
    new Promise((resolve) => {
      const child = spawn("npm", args, { cwd: dir, env: { ...env, BAATON_SELF_UPDATE: "0" }, stdio: ["ignore", "pipe", "pipe"] });
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
  return (async () => {
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
  const reloadRoots = async (state) => {
    const events = [];
    for (const record of runtime()) {
      if (record.role !== "extension" || !record.paneId || !record.checkout) continue;
      const disk = await headOf(record.checkout);
      if (!disk || !record.commit || disk === record.commit) continue;
      if ((state.reloads ??= {})[record.paneId] === disk) continue;
      if (!(await clean(record.checkout).catch(() => false))) continue;
      const check = await ready(record.paneId, { pane_id: record.paneId, agent_kind: record.agentKind ?? "pi" });
      if (!check?.ok || check.agent?.agent_status !== "idle") continue;
      try {
        await prompt(record.paneId, "/reload");
        state.reloads[record.paneId] = disk;
        events.push(`reloaded the root in ${record.paneId} onto ${disk.slice(0, 12)}`);
      } catch (error) {
        // A send that may have landed is not retried for this commit.
        if (error?.sent !== false) state.reloads[record.paneId] = disk;
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
        (state.tested ??= {})[sha] = { result: result.ok ? "pass" : "fail", at: now(), ...(result.ok ? {} : { tail: result.output.slice(-1500) }) };
        delete state.testing;
        await git(checkout, "worktree", "remove", "--force", dir).catch(() => rm(dir, { recursive: true, force: true }));
        if (result.ok) events.push(...(await apply(state, sha)));
        else {
          events.push(`${sha.slice(0, 12)} failed npm test; not deployed`);
          await notify({ title: "Baa-ton update failed its tests", body: `${sha.slice(0, 12)} is not deployed. ${result.output.slice(-300)}` });
        }
      } else if (!active && (!state.lastCheckAt || Date.parse(now()) - Date.parse(state.lastCheckAt) >= SELF_UPDATE_CHECK_MS)) {
        state.lastCheckAt = now();
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
          if (target && behind.length && tested === "pass") events.push(...(await apply(state, target)));
          else if (target && behind.length && !tested) {
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
