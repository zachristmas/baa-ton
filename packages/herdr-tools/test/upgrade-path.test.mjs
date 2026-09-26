import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { migrateProjectState } from "../state-migration.mjs";
import { mergeDetectedProfiles, missingOptionalConfigSections } from "../setup-core.mjs";
import { runSupervisorTick } from "../../controller/controller.mjs";
import { validateParentGoal as validateParentGoal974a77d } from "../../controller/test/fixtures/controller-974a77d-goal-validation.mjs";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");
const checkout = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const chosenProfile = {
  agentKind: "claude",
  launchProfile: { provider: "claude-code", model: "claude-opus-5", thinking: "high", auth: "subscription" },
};

/** A project as bd4bc81 left it: state under .pi, no leases or policy,
 * a parent goal whose supervisor has only the fields that release knew. */
async function bd4bc81Project() {
  const directory = await mkdtemp(join(tmpdir(), "baa-upgrade-"));
  const project = join(directory, "project");
  const controllerDir = join(directory, "controller-config");
  const legacyManifest = join(project, ".pi", "herdr-orchestrator", "manifest.json");
  const rootPane = "w-up:p1";
  await mkdir(dirname(legacyManifest), { recursive: true, mode: 0o700 });
  await mkdir(join(project, ".baa-ton"), { recursive: true });
  await mkdir(controllerDir, { recursive: true, mode: 0o700 });
  await chmod(controllerDir, 0o700);
  await writeFile(
    join(project, ".baa-ton", "config.json"),
    JSON.stringify({ version: 1, selectedHarnesses: ["claude"], profiles: { implementation: chosenProfile } }, null, 2),
  );
  const stamp = "2026-09-20T00:00:00.000Z";
  await writeFile(
    legacyManifest,
    JSON.stringify({
      version: 2,
      workflows: [{
        id: "herdr-old00001",
        objective: "Old work",
        status: "running",
        outcome: "running",
        ownership: { createdBy: "herdr-orchestrator", workspaceId: "w-up", paneIds: [] },
        taskBinding: { workspaceId: "w-up", rootPaneId: rootPane, rootSessionPath: "/tmp/root.jsonl" },
        lanes: [{ id: "lane-old", paneId: "w-up:p2", status: "running" }],
        evidence: [],
      }],
      parentGoal: {
        version: 1,
        id: "parent-goal-old",
        objective: "Old goal",
        status: "active",
        nextAction: "Continue.",
        signals: [],
        supervisor: {
          version: 1,
          state: "running",
          intervalSeconds: 1200,
          nudgeCount: 0,
          nextNudgeAt: stamp,
          createdAt: stamp,
          updatedAt: stamp,
          lastDelivery: { status: "delivered", attemptedAt: stamp, deliveredAt: stamp },
        },
        createdAt: stamp,
        updatedAt: stamp,
      },
    }, null, 2),
    { mode: 0o600 },
  );
  const lane = { lane_id: "lane-old", target: "w-up:p2", target_kind: "pane_id", pane_id: "w-up:p2", workspace_id: "w-up" };
  await writeFile(
    join(controllerDir, "config.json"),
    JSON.stringify({
      version: 2,
      owner: "herdr-orchestrator",
      orchestrators: [{
        id: "orchestrator-up",
        root: { target: rootPane, target_kind: "pane_id", pane_id: rootPane, workspace_id: "w-up", agent_kind: "pi" },
        program: { id: project, workspace_id: "w-up", parent_manifest_path: legacyManifest },
        workflows: [{ workflow_id: "herdr-old00001", manifest_path: legacyManifest, lanes: [lane] }],
      }],
    }, null, 2),
    { mode: 0o600 },
  );
  return { directory, project, controllerDir, rootPane };
}

test("updating a bd4bc81 project migrates state, keeps profile choices and stays readable by old and new code", async () => {
  const f = await bd4bc81Project();
  try {
    const migration = await migrateProjectState({ projectRoot: f.project, controllerConfigDirectory: f.controllerDir });
    assert.equal(migration.status, "migrated");
    const manifestPath = join(f.project, ".baa-ton", "herdr-orchestrator", "manifest.json");
    assert.ok(existsSync(manifestPath), "state moved to .baa-ton");
    assert.match(await readFile(join(f.controllerDir, "config.json"), "utf8"), /\.baa-ton\/herdr-orchestrator\/manifest\.json/);

    // The real unattended setup (the update skill's step), hermetic.
    const setup = spawnSync(
      process.execPath,
      [join(checkout, "packages", "herdr-tools", "setup.mjs"), "--project-root", f.project, "--non-interactive", "--harness", "claude"],
      { encoding: "utf8", timeout: 120_000, env: { ...process.env, HOME: join(f.directory, "home") } },
    );
    assert.equal(setup.status, 0, setup.stderr);
    const config = JSON.parse(await readFile(join(f.project, ".baa-ton", "config.json"), "utf8"));
    assert.deepEqual(config.profiles.implementation.launchProfile, chosenProfile.launchProfile, "the chosen model survives setup");
    assert.match(setup.stdout, /Optional \.baa-ton\/config\.json sections not configured/);
    assert.match(setup.stdout, /runtime\.leases:/);
    assert.match(setup.stdout, /approvalPolicy:/);
    assert.equal(config.runtime, undefined, "optional sections are never added silently");
    assert.equal(config.approvalPolicy, undefined);

    // Detected defaults never replace a chosen profile.
    const detected = {
      implementation: { agentKind: "codex", launchProfile: { provider: "openai-codex", model: "gpt-6-sol", thinking: "high", auth: "subscription" } },
      quick: { agentKind: "claude", launchProfile: { provider: "claude-code", model: "claude-haiku-4-5", thinking: "low", auth: "subscription" } },
    };
    const merged = structuredClone(config);
    assert.deepEqual(mergeDetectedProfiles(merged, detected), { filled: ["quick"], preserved: ["implementation"] });
    assert.deepEqual(merged.profiles.implementation.launchProfile, chosenProfile.launchProfile);
    assert.equal(merged.profiles.quick.launchProfile.model, "claude-haiku-4-5");
    assert.deepEqual(missingOptionalConfigSections(config).map((section) => section.key), ["runtime", "approvalPolicy"]);

    // New controller: the migrated manifest is served (not skipped), and the
    // goal it writes stays valid for a lane still on 974a77d code.
    const api = {
      prompts: 0,
      async request(method) {
        if (method === "agent.get")
          return { type: "agent_info", agent: { agent: "pi", pane_id: f.rootPane, workspace_id: "w-up", agent_status: "idle" } };
        if (method === "agent.prompt") {
          api.prompts += 1;
          return { type: "agent_prompted" };
        }
        return { result: {} };
      },
    };
    const tick = await runSupervisorTick({
      stateDir: f.controllerDir,
      herdr: api,
      notify: async () => ({ status: "sent" }),
      sample: async () => ({}),
      topUsers: async () => [],
      timestamp: "2026-09-24T00:00:00.000Z",
    });
    assert.equal(tick.results.some((result) => result.status === "skipped"), false, JSON.stringify(tick.results));
    const stored = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.doesNotThrow(() => validateParentGoal974a77d(stored.parentGoal));
    assert.equal(stored.parentGoal.supervisor.intervalSeconds, 300, "the pre-#28 1200 s interval is capped once");
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("herdr_doctor reports version skew and a split install after an update", async () => {
  const f = await bd4bc81Project();
  await migrateProjectState({ projectRoot: f.project, controllerConfigDirectory: f.controllerDir });
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map((key) => [key, process.env[key]]),
  );
  // A lane bridge still running code from before the update.
  const lane = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  try {
    await mkdir(join(f.controllerDir, "runtime"), { recursive: true });
    await writeFile(
      join(f.controllerDir, "runtime", `bridge-${lane.pid}.json`),
      JSON.stringify({ role: "bridge", pid: lane.pid, checkout, fingerprint: "0123456789ab", commit: "bd4bc81".padEnd(40, "0"), paneId: "w-other:p9" }),
    );
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: f.rootPane, HERDR_WORKSPACE_ID: "w-up", HERDR_PLUGIN_CONFIG_DIR: f.controllerDir });
    const tools = new Map();
    extension({
      on() {},
      registerCommand() {},
      registerTool(definition) {
        tools.set(definition.name, definition);
      },
      async exec(command, args) {
        if (args[0] === "plugin" && args[1] === "config-dir") return { code: 0, stderr: "", stdout: f.controllerDir };
        if (args[0] === "plugin" && args[1] === "list")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({ plugins: [{ id: "herdr-orchestrator-controller", manifest_path: "/Users/someone/baa-ton/packages/controller/herdr-plugin.toml" }] }),
          };
        throw new Error(`unexpected ${command} ${args.join(" ")}`);
      },
    });
    const report = await tools.get("herdr_doctor").execute("doctor", {}, undefined, undefined, {
      cwd: f.project,
      hasUI: false,
      mode: "json",
      modelRegistry: { find: () => ({ reasoning: true, thinkingLevelMap: {} }), hasConfiguredAuth: () => true, isUsingOAuth: () => true },
    });
    const byId = Object.fromEntries(report.details.checks.map((entry) => [entry.id, entry]));
    const skew = byId["runtime-version-skew"];
    assert.equal(skew.status, "warn");
    assert.match(skew.detail, /bridge pid \d+ pane w-other:p9: loaded bd4bc81 \(0123456789ab\), installed/);
    assert.match(skew.detail, /reconnect its MCP server in the same session \(Claude: \/mcp, reconnect herdr-orchestrator\) or herdr_resume the lane/);
    assert.match(skew.detail, /supervisor: no version record \(started before version reporting\)/);
    assert.match(skew.detail, /lane herdr-old00001\/lane-old pane w-up:p2: no version record/);
    assert.match(skew.detail, /extension \(this process\) pid \d+ pane w-up:p1: current/);
    const split = byId["controller-plugin-install"];
    assert.equal(split.status, "warn");
    assert.match(split.detail, /Split install: the controller plugin runs from \/Users\/someone\/baa-ton\/packages\/controller, but this extension runs from/);
  } finally {
    lane.kill();
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a pulled update restarts the real supervisor from the new code", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-supervisor-restart-"));
  const copy = join(directory, "checkout");
  const configDir = join(directory, "config");
  const stateDir = join(directory, "state");
  for (const part of [["packages", "controller"], ["packages", "herdr-tools", "inbox"]])
    await cp(join(checkout, ...part), join(copy, ...part), { recursive: true, filter: (source) => !/[/\\](test|node_modules)([/\\]|$)/.test(source) });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(join(configDir, "config.json"), JSON.stringify({ version: 2, owner: "herdr-orchestrator", orchestrators: [] }), { mode: 0o600 });
  const launcher = spawn(process.execPath, [join(copy, "packages", "controller", "controller.mjs"), "supervisor"], {
    cwd: join(copy, "packages", "controller"),
    env: { ...process.env, HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_PLUGIN_CONFIG_DIR: configDir },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  launcher.stderr.on("data", (chunk) => (stderr += chunk));
  const supervisorRecord = async () => {
    const names = await readdir(join(configDir, "runtime")).catch(() => []);
    for (const name of names)
      if (name.startsWith("supervisor-") && name.endsWith(".json"))
        return JSON.parse(await readFile(join(configDir, "runtime", name), "utf8"));
    return undefined;
  };
  const waitFor = async (predicate, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    return undefined;
  };
  try {
    // Generous: the suite runs several heavy files in parallel.
    const first = await waitFor(supervisorRecord, 30_000);
    assert.ok(first, `the runner starts and records itself: ${stderr}`);
    assert.notEqual(first.pid, launcher.pid, "the runner is the launcher's child");
    await appendFile(join(copy, "packages", "controller", "activation.mjs"), "\n// updated by git pull\n");
    const second = await waitFor(async () => {
      const record = await supervisorRecord();
      return record && record.pid !== first.pid ? record : undefined;
    }, 30_000);
    assert.ok(second, `a new runner took over after the code changed: ${stderr}`);
    assert.notEqual(second.fingerprint, first.fingerprint, "and it loaded the new code");
    assert.match(stderr, /code changed on disk .* restarting/);
    assert.equal(launcher.exitCode, null, "the Herdr-owned launcher keeps running");
  } finally {
    launcher.kill("SIGTERM");
    await new Promise((resolveExit) => (launcher.exitCode !== null ? resolveExit() : launcher.once("exit", resolveExit)));
    await rm(directory, { recursive: true, force: true });
  }
});
