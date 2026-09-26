import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

// The real startup path: Herdr runs `controller.mjs supervisor` (the
// launcher), which runs `supervisor-run` as its child. Even with every
// regular tick failing (here: a config with no orchestrators), the updater
// must check origin/main, test the new commit and fast-forward the checkout,
// and the log file must show all of it.
test("the supervisor started like Herdr starts it deploys a new main, and logs to its config dir", { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-supervisor-deploy-"));
  const source = join(directory, "source");
  const origin = join(directory, "origin.git");
  const installed = join(directory, "installed");
  const configDir = join(directory, "config");
  const stateDir = join(directory, "state");
  for (const part of [["packages", "controller"], ["packages", "herdr-tools"]])
    await cp(join(checkout, ...part), join(source, ...part), { recursive: true, filter: (path) => !/[/\\](test|node_modules)([/\\]|$)/.test(path) });
  await cp(join(checkout, "package.json"), join(source, "package.json"));
  execFileSync("git", ["init", "-q", "-b", "main", source], { env: GIT_ENV });
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "installed");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: GIT_ENV });
  git(source, "push", "-q", origin, "main");
  execFileSync("git", ["clone", "-q", "-b", "main", origin, installed], { env: GIT_ENV });
  await writeFile(join(source, "NOTE.md"), "merged fix\n");
  git(source, "add", "NOTE.md");
  git(source, "commit", "-q", "-m", "merged fix");
  git(source, "push", "-q", origin, "main");
  const target = git(source, "rev-parse", "HEAD");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(join(configDir, "config.json"), JSON.stringify({ version: 2, owner: "herdr-orchestrator", orchestrators: [] }), { mode: 0o600 });
  const env = { ...GIT_ENV, HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_PLUGIN_CONFIG_DIR: configDir, BAATON_SELF_UPDATE_TEST_COMMAND: JSON.stringify([process.execPath, "-e", "process.exit(0)"]) };
  delete env.HERDR_SOCKET_PATH;
  delete env.BAATON_SELF_UPDATE;
  const launcher = spawn(process.execPath, [join(installed, "packages", "controller", "controller.mjs"), "supervisor"], { cwd: join(installed, "packages", "controller"), env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  launcher.stderr.on("data", (chunk) => (stderr += chunk));
  const log = () => readFile(join(configDir, "supervisor.log"), "utf8").catch(() => "");
  const waitFor = async (predicate, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise((done) => setTimeout(done, 250));
    }
    return false;
  };
  try {
    assert.ok(await waitFor(() => git(installed, "rev-parse", "HEAD") === target, 180_000), `the checkout was fast-forwarded to the new main.\nlog:\n${await log()}\nstderr:\n${stderr}`);
    const text = await log();
    assert.match(text, /started on [0-9a-f]{12}/);
    assert.match(text, /tick failed: config\.orchestrators must be a non-empty array/, "the tick failure is in the log");
    assert.equal(text.match(/tick failed/g).length, 1, "logged once, not every tick");
    assert.match(text, new RegExp(`self-update: testing ${target.slice(0, 12)} before deploying`));
    assert.match(text, new RegExp(`self-update: .*-> ${target.slice(0, 12)}`));
    const state = JSON.parse(await readFile(join(configDir, "self-update.json"), "utf8"));
    assert.equal(state.tested[target].result, "pass");
    assert.equal(state.updatedTo, target);
  } finally {
    launcher.kill("SIGTERM");
    await new Promise((done) => (launcher.exitCode !== null ? done() : launcher.once("exit", done)));
    await rm(directory, { recursive: true, force: true });
  }
});
