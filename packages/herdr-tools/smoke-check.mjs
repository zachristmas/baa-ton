#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { handleHook, runSupervisorTick } from "../controller/controller.mjs";

// This check simulates its own session_start events against synthetic
// fixtures; it never dispatches a real lane. BAA_STARTUP_INTENT is set only
// by dispatch-task.ts for an actually-launched lane and points at a startup
// proof file that does not exist here. An inherited copy of that variable
// (e.g. this check running inside a pane that a lane itself dispatched)
// must not make session_start try to read and verify it, so drop it before
// exercising anything rather than requiring `env -u` at the call site.
delete process.env.BAA_STARTUP_INTENT;

const root = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(root, "index.ts"), "utf8");
const readme = await readFile(join(root, "README.md"), "utf8");
const defects = await readFile(join(root, "DEFECTS.md"), "utf8");
const dispatchStart = source.indexOf("  async function dispatch(");
const dispatchEnd = source.indexOf("\n  async function observe(");
assert.ok(
  dispatchStart >= 0 && dispatchEnd > dispatchStart,
  "dispatch function is present",
);
const dispatch = source.slice(dispatchStart, dispatchEnd);

assert.doesNotMatch(
  dispatch,
  /waitForShell|setTimeout\s*\(|lockRetryDelay\s*\(/,
  "dispatch readiness has no local sleeps (bounded manifest-lock contention is separate)",
);
assert.match(
  source,
  /async function parentGoal\([\s\S]*?const release = await acquireManifestLock\(cwd\)[\s\S]*?finally[\s\S]*?await release\(\)/,
  "every herdr_goal operation holds the shared manifest lock through its write",
);
assert.match(
  source,
  /\.\$\{MANIFEST_NAME\}\.herdr-orchestrator\.lock/,
  "goal writes use the documented shared manifest sibling lock",
);
assert.doesNotMatch(
  dispatch,
  /"pane"\s*,\s*"process-info"/,
  "does not mistake a process snapshot for readiness",
);
// Native busy recovery and topology are tested behaviorally in dispatch-task.test.mjs.
const failurePath = dispatch.slice(dispatch.indexOf("catch (error)"));
assert.doesNotMatch(
  failurePath,
  /"workspace", "close"/,
  "partial failure has no cleanup close",
);
assert.match(
  readme,
  /Partial dispatch failures/,
  "README documents recovery behavior",
);
assert.match(
  defects,
  /agent_pane_busy/,
  "defect ledger records the readiness incident",
);
assert.match(
  source,
  /verified controller-mapped root/,
  "verified root designation is enforced",
);
assert.match(
  source,
  /herdr_bootstrap_root/,
  "manual root bootstrap is registered",
);
assert.match(
  source,
  /current pane identity/,
  "manual roots use verified pane identity",
);
assert.match(readme, /Non-root callers/, "README documents root mediation");
assert.match(
  defects,
  /Child approvals/,
  "defect ledger records approval mediation",
);
assert.match(
  source,
  /ask_user_question[\s\S]*terminate:\s*true/,
  "child questions terminate without transcript output",
);
assert.match(
  source,
  /worktreeCwd[\s\S]*plannedCwd/,
  "planner validates worktree cwd",
);
assert.match(
  readme,
  /Worktree workflows/,
  "README documents worktree ownership",
);
// Worktrees select checkout paths only; dispatch must never open a workspace.
assert.match(
  defects,
  /Worktree dispatch/,
  "defect ledger records worktree metadata retention",
);
// Detection compatibility is not a verified startup capability.
assert.match(
  source,
  /sharedWorkspace[\s\S]*?workspace-retained-for-other-workflows/,
  "closing a shared workspace is guarded by other non-closed workflow references",
);
assert.match(
  readme,
  /Each lane gets its own Herdr tab/,
  "README documents workspace/tab/pane topology",
);
assert.match(
  source,
  /RECENT_AGENT_OUTPUT_LINES[\s\S]*goal-paused[\s\S]*?\/goal-resume/,
  "observation parses bounded paused-goal output and resume sends the goal command",
);
assert.match(
  source,
  /herdr_complete\(\{ workflowId:[\s\S]*?chat-only outcome is insufficient[\s\S]*?fallback-only/,
  "every generated lane contract requires an explicit durable completion receipt",
);
assert.match(
  source,
  /authorizationPolicy[\s\S]*authorization-policy-granted/,
  "bounded authorization policy is stored and audited",
);
assert.match(
  source,
  /authorizationPolicy cannot authorize/,
  "policy rejects capabilities outside the fixed local allowlist",
);
assert.match(readme, /herdr_resume/, "README documents the resume tool");
assert.match(
  defects,
  /Paused-goal evidence/,
  "defect ledger records paused goals",
);

const require = createRequire(import.meta.url);
const createJiti = require("jiti");
const jiti = createJiti(fileURLToPath(import.meta.url), {
  alias: { typebox: require.resolve("typebox") },
});
const extension = await jiti.import(join(root, "index.ts"));
const tools = new Map();
const commands = new Map();
const eventHandlers = new Map();
const calls = [];
let failAgentStart = true;
let agentStartAcknowledgment = "json";
const existingAgents = new Map();
let controllerPluginAvailable = true;
let controllerConfigDir = "";
const rootPaneId = "w-root:p1";
const rootWorkspaceId = "w-root";
let goalResumePromptCount = 0;
let worktreeClean = true;
let registeredParentCheckout = "";
let openWorktreeWorkspaceId = null;
let parentWorkspaceMode = "one";
let genericWorkspaceCount = 0;
const missingWorkspaceIds = new Set();
const nextTabNumberByWorkspace = new Map();
extension.default({
  on(event, handler) {
    eventHandlers.set(event, handler);
  },
  registerTool(definition) {
    tools.set(definition.name, definition);
  },
  registerCommand(name, definition) {
    commands.set(name, definition);
  },
  async exec(command, args) {
    if (command === "git") {
      if (args[2] === "rev-parse")
        return { stdout: `${args[1]}\n`, stderr: "", code: 0 };
      assert.deepEqual(
        args.slice(-3),
        ["status", "--porcelain", "--untracked-files=all"],
        "worktree validation checks Git cleanliness synchronously",
      );
      return {
        stdout: worktreeClean ? "" : " M index.ts\n",
        stderr: "",
        code: 0,
      };
    }
    assert.equal(command, "herdr", "dispatch uses only the Herdr CLI");
    calls.push(args);
    const response = (stdout) => ({
      stdout: JSON.stringify(stdout),
      stderr: "",
      code: 0,
    });
    if (args[0] === "plugin" && args[1] === "config-dir") {
      assert.equal(args[2], "herdr-orchestrator-controller");
      if (!controllerPluginAvailable)
        return {
          stdout: "",
          stderr: "plugin_not_linked",
          code: 1,
        };
      return { stdout: `${controllerConfigDir}\n`, stderr: "", code: 0 };
    }
    if (args[0] === "pane" && args[1] === "report-metadata")
      return response({ result: {} });
    if (args[0] === "workspace" && args[1] === "close")
      return response({ result: {} });
    if (args[0] === "workspace" && args[1] === "get") {
      if (missingWorkspaceIds.has(args[2]))
        return { stdout: "", stderr: "workspace_not_found", code: 1 };
      return response({ result: { workspace: { workspace_id: args[2] } } });
    }
    if (args[0] === "worktree" && args[1] === "list") {
      const checkoutPath = args[args.indexOf("--cwd") + 1];
      return response({
        result: {
          type: "worktree_list",
          source: {
            repo_key: "repo-smoke",
            repo_root: registeredParentCheckout,
            source_checkout_path: registeredParentCheckout,
            source_workspace_id: "w-parent",
          },
          worktrees: [
            {
              path: checkoutPath,
              open_workspace_id: openWorktreeWorkspaceId,
            },
          ],
        },
      });
    }
    if (args[0] === "workspace" && args[1] === "list") {
      // Herdr's parent workspace may be generic; its repository binding is
      // authoritative in worktree-list.source rather than workspace.worktree.
      const parent = { workspace_id: "w-parent" };
      return response({
        result: {
          workspaces:
            parentWorkspaceMode === "ambiguous"
              ? [{ ...parent }, { ...parent }]
              : [parent],
        },
      });
    }
    if (args[0] === "worktree" && args[1] === "open") {
      assert.equal(
        args[args.indexOf("--workspace") + 1],
        "w-parent",
        "opens from the registered parent workspace",
      );
      openWorktreeWorkspaceId = "w-smoke";
      return response({
        result: {
          type: "worktree_opened",
          already_open: false,
          workspace: { workspace_id: "w-smoke" },
          tab: { tab_id: "w-smoke:t1" },
          root_pane: { pane_id: "w-smoke:p1" },
          worktree: { path: args[args.indexOf("--path") + 1] },
        },
      });
    }
    if (args[0] === "workspace" && args[1] === "create") {
      const workspaceId = `w-generic-${++genericWorkspaceCount}`;
      return response({
        result: {
          workspace: { workspace_id: workspaceId },
          tab: { tab_id: `${workspaceId}:t1` },
          root_pane: { pane_id: `${workspaceId}:p1` },
        },
      });
    }
    if (args[0] === "tab" && args[1] === "create") {
      const workspaceId = args[args.indexOf("--workspace") + 1];
      const number = (nextTabNumberByWorkspace.get(workspaceId) ?? 1) + 1;
      nextTabNumberByWorkspace.set(workspaceId, number);
      return response({
        result: {
          tab: { tab_id: `${workspaceId}:t${number}` },
          root_pane: { pane_id: `${workspaceId}:p${number}` },
        },
      });
    }
    if (args[0] === "tab" && args[1] === "rename")
      return response({ result: {} });
    if (args[0] === "pane" && args[1] === "process-info")
      return response({
        result: {
          process_info: { shell_pid: 99, foreground_process_group_id: 99 },
        },
      });
    if (args[0] === "agent" && args[1] === "get") {
      if (args[2] === rootPaneId)
        return response({
          result: {
            type: "agent_info",
            agent: {
              name: "smoke-root",
              agent: "pi",
              agent_session: {
                agent: "pi",
                source: "herdr:pi",
                kind: "path",
                value: "/sessions/root.jsonl",
              },
              pane_id: rootPaneId,
              workspace_id: rootWorkspaceId,
              agent_status: "idle",
            },
          },
        });
      const agent = existingAgents.get(args[2]);
      if (agent)
        return response({
          result: {
            type: "agent_info",
            agent: {
              name: args[2],
              agent: agent.kind,
              pane_id: agent.paneId,
              workspace_id: agent.workspaceId,
              agent_status: "idle",
              agent_session_path: "/tmp/pi-goal-smoke.jsonl",
              agent_session_id: "pi-goal-smoke",
            },
          },
        });
      return {
        stdout: "",
        stderr: '{"error":{"code":"agent_not_found"}}',
        code: 1,
      };
    }
    if (args[0] === "agent" && args[1] === "read")
      return {
        stdout:
          "pi-goal-bb029 paused after a child-facing question was cancelled; send /goal-resume through Herdr.\n",
        stderr: "",
        code: 0,
      };
    if (args[0] === "agent" && args[1] === "start") {
      if (failAgentStart)
        return {
          stdout: "",
          stderr: '{"error":{"code":"agent_pane_busy"}}',
          code: 1,
        };
      const paneId = args[args.indexOf("--pane") + 1];
      existingAgents.set(args[2], {
        kind: args[args.indexOf("--kind") + 1],
        paneId,
        workspaceId: paneId.slice(0, paneId.lastIndexOf(":p")),
      });
      if (agentStartAcknowledgment === "empty")
        return { stdout: "", stderr: "", code: 0 };
      if (agentStartAcknowledgment === "non-json")
        return { stdout: "agent started\n", stderr: "", code: 0 };
      return response({ result: { agent: { agent_status: "idle" } } });
    }
    if (args[0] === "agent" && args[1] === "prompt") {
      if (args.at(-1) === "/goal-resume") {
        goalResumePromptCount += 1;
        return response({ result: { receipt: "goal-resume accepted" } });
      }
      return response({ result: {} });
    }
    throw new Error(`Unexpected Herdr call: ${args.join(" ")}`);
  },
});
assert.equal(tools.size, 16, "extension registered its workflow tools");
assert.ok(tools.has("herdr_recover_root"), "extension registers audited stale-root recovery");
assert.ok(
  tools.has("herdr_bootstrap_root"),
  "extension registers manual root bootstrap",
);
assert.ok(
  tools.has("herdr_question_answer"),
  "extension registers parent question answers",
);
assert.ok(tools.has("herdr_queue"), "extension registers the root queue");
assert.ok(tools.has("herdr_reparent"), "extension registers root handoff");
assert.ok(tools.has("herdr_sweep"), "extension registers the root cleanup sweep");
assert.ok(tools.has("herdr_message"), "extension registers child messages");
assert.ok(
  tools.has("herdr_complete"),
  "extension registers verified completion receipts",
);
assert.ok(
  tools.has("herdr_operator_close"),
  "extension registers root-only operator receipt reconciliation",
);
assert.ok(
  tools.has("herdr_doctor"),
  "extension registers the read-only installation/health preflight",
);
assert.ok(commands.has("herdr-resume"), "extension registered /herdr-resume");

const testCwd = await mkdtemp(join(tmpdir(), "herdr-orchestrator-smoke-"));
const previousHerdrEnv = process.env.HERDR_ENV;
const previousRootEnv = process.env.HERDR_ORCHESTRATOR_ROOT;
const previousPaneEnv = process.env.HERDR_PANE_ID;
const previousWorkspaceEnv = process.env.HERDR_WORKSPACE_ID;
const previousPluginConfigDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
process.env.HERDR_ENV = "1";
process.env.HERDR_PANE_ID = rootPaneId;
process.env.HERDR_WORKSPACE_ID = rootWorkspaceId;
controllerConfigDir = join(testCwd, "controller-config");
process.env.HERDR_PLUGIN_CONFIG_DIR = controllerConfigDir;
let confirmationCalls = 0;
let rootIdle = false;
let abortedRuns = 0;
const notifications = [];
const ctx = {
  cwd: testCwd,
  sessionManager: { getSessionFile: () => "/sessions/root.jsonl" },
  isIdle: () => rootIdle,
  abort: () => {
    abortedRuns += 1;
  },
  mode: "tui",
  hasUI: true,
  ui: {
    confirm: async () => {
      confirmationCalls += 1;
      return true;
    },
    notify: (...args) => notifications.push(args),
  },
};
const headlessRootCtx = { ...ctx, mode: "json", hasUI: false };
const bb029Policy = {
  version: 1,
  scope: { workflow: "BB-029", localOnly: true },
  capabilities: [
    "local-herdr-topology",
    "clean-local-worktrees",
    "foreground-tests",
    "observe-retry-review",
    "durable-ledger",
    "paused-goal-recovery",
  ],
};
try {
  delete process.env.HERDR_ORCHESTRATOR_ROOT;
  await mkdir(controllerConfigDir, { mode: 0o755 });
  await chmod(controllerConfigDir, 0o755);
  const legacyManifestPath = join(
    testCwd,
    ".pi",
    "herdr-orchestrator",
    "manifest.json",
  );
  await mkdir(dirname(legacyManifestPath), { recursive: true });
  await writeFile(
    legacyManifestPath,
    `${JSON.stringify({
      version: 2,
      workflows: [{ id: "legacy-workflow" }],
      questionRequests: [{ id: "legacy-question" }],
    })}\n`,
  );
  await assert.rejects(
    tools
      .get("herdr_bootstrap_root")
      .execute("bootstrap-root-without-reset", {}, undefined, undefined, ctx),
    /parent manifest has existing state/,
    "bootstrap refuses to adopt a legacy manifest",
  );
  const bootstrappedRoot = await tools
    .get("herdr_bootstrap_root")
    .execute("bootstrap-root", { reset: true }, undefined, undefined, ctx);
  assert.equal(bootstrappedRoot.details.root.pane_id, rootPaneId);
  assert.equal(bootstrappedRoot.details.manifestReset, true);
  assert.equal(
    confirmationCalls,
    0,
    "manual root bootstrap is confirmation-free by default",
  );
  assert.deepEqual(
    JSON.parse(await readFile(legacyManifestPath, "utf8")),
    { version: 2, workflows: [] },
    "explicit reset retires legacy parent state",
  );
  const bootstrapConfig = JSON.parse(
    await readFile(join(controllerConfigDir, "config.json"), "utf8"),
  );
  assert.equal(
    bootstrapConfig.orchestrators[0].root.pane_id,
    rootPaneId,
    "bootstrap persists the verified root pane",
  );
  const worktreeCwd = join(testCwd, "bb029-writer-worktree");
  const dirtyWorktreeCwd = join(testCwd, "dirty-worktree");
  const ambiguousWorktreeCwd = join(testCwd, "ambiguous-worktree");
  registeredParentCheckout = join(testCwd, "registered-parent-workspace");
  await mkdir(worktreeCwd);
  const normalizedWorktreeCwd = await realpath(worktreeCwd);
  await mkdir(dirtyWorktreeCwd);
  await mkdir(ambiguousWorktreeCwd);
  await assert.rejects(
    tools
      .get("herdr_plan")
      .execute(
        "relative-worktree",
        { objective: "relative", worktreeCwd: "bb029-writer-worktree" },
        undefined,
        undefined,
        ctx,
      ),
    /absolute existing directory/,
  );
  await assert.rejects(
    tools
      .get("herdr_plan")
      .execute(
        "missing-worktree",
        { objective: "missing", worktreeCwd: join(testCwd, "missing") },
        undefined,
        undefined,
        ctx,
      ),
    /does not exist/,
  );
  await assert.rejects(
    tools
      .get("herdr_plan")
      .execute(
        "invalid-agent-kind",
        { objective: "invalid agent", agentKind: "not-a-herdr-harness" },
        undefined,
        undefined,
        ctx,
      ),
    /agentKind must be one of/,
    "the extension fails closed outside the installed Herdr compatibility set",
  );
  await assert.rejects(
    tools.get("herdr_plan").execute(
      "invalid-policy",
      {
        objective: "BB-029 invalid",
        authorizationPolicy: {
          ...bb029Policy,
          capabilities: [...bb029Policy.capabilities, "close"],
        },
      },
      undefined,
      undefined,
      ctx,
    ),
    /cannot authorize close/,
    "a local policy cannot authorize resource closure",
  );
  worktreeClean = false;
  await assert.rejects(
    tools
      .get("herdr_plan")
      .execute(
        "dirty-worktree",
        { objective: "dirty", worktreeCwd: dirtyWorktreeCwd },
        undefined,
        undefined,
        ctx,
      ),
    /worktreeCwd must be clean/,
    "planning rejects a dirty worktree before it can open a workspace",
  );
  worktreeClean = true;
  parentWorkspaceMode = "ambiguous";
  await assert.rejects(
    tools
      .get("herdr_plan")
      .execute(
        "ambiguous-parent",
        { objective: "ambiguous", worktreeCwd: ambiguousWorktreeCwd },
        undefined,
        undefined,
        ctx,
      ),
    /ambiguous worktree dispatch/,
    "planning rejects ambiguous registered parent workspaces",
  );
  parentWorkspaceMode = "one";
  await assert.rejects(
    tools.get("herdr_plan").execute(
      "writer-lanes",
      {
        objective: "writer lanes",
        lanes: ["writer root", "writer tab"],
        worktreeCwd,
      },
      undefined,
      undefined,
      ctx,
    ),
    /every lane declares readOnly: true/,
    "one worktree cannot receive multiple writer lanes",
  );
  const plan = await tools.get("herdr_plan").execute(
    "plan",
    {
      objective: "BB-029 smoke",
      lanes: [
        { objective: "read root", readOnly: true },
        { objective: "read tab", readOnly: true },
      ],
      worktreeCwd,
      authorizationPolicy: bb029Policy,
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(
    plan.details.workflow.cwd,
    normalizedWorktreeCwd,
    "planner records target cwd",
  );
  assert.equal(
    plan.details.workflow.worktree,
    normalizedWorktreeCwd,
    "planner records target worktree",
  );
  assert.deepEqual(
    plan.details.workflow.authorizationPolicy,
    bb029Policy,
    "planner persists the exact validated BB-029 policy",
  );
  assert.equal(
    plan.details.workflow.evidence[0].kind,
    "authorization-policy-installed",
    "policy installation is durable evidence",
  );
  assert.deepEqual(
    plan.details.workflow.worktreeBinding.repoParent,
    {
      workspaceId: "w-parent",
      checkoutPath: registeredParentCheckout,
      repoKey: "repo-smoke",
      repoRoot: registeredParentCheckout,
    },
    "planner durably binds the sole registered parent checkout",
  );
  assert.ok(
    plan.details.workflow.evidence.some(
      (item) => item.kind === "worktree-parent-resolved",
    ),
    "registered parent evidence is durable before dispatch",
  );
  const workflowId = plan.details.workflow.id;
  process.env.HERDR_PANE_ID = "w-child:p1";
  const childDispatch = await tools
    .get("herdr_dispatch")
    .execute(
      "child-dispatch",
      { workflowId, execute: true },
      undefined,
      undefined,
      ctx,
    );
  const repeatedChildDispatch = await tools
    .get("herdr_dispatch")
    .execute(
      "child-dispatch-repeat",
      { workflowId, execute: true },
      undefined,
      undefined,
      ctx,
    );
  assert.equal(childDispatch.details.parentApprovalRequired, true);
  assert.equal(repeatedChildDispatch.details.parentApprovalRequired, true);
  assert.equal(
    confirmationCalls,
    0,
    "child dispatch opens no confirmation UI after root bootstrap",
  );
  process.env.HERDR_PANE_ID = rootPaneId;
  assert.equal(
    calls.filter((args) => args[0] === "worktree" && args[1] === "open").length,
    0,
    "child dispatch opens no Herdr resource",
  );

  const manifestPath = join(
    testCwd,
    ".pi",
    "herdr-orchestrator",
    "manifest.json",
  );
  let manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  let workflow = manifest.workflows[0];
  assert.equal(
    workflow.approvalRequests.length,
    1,
    "child dispatch is deduplicated",
  );
  assert.equal(workflow.approvalRequests[0].action, "dispatch");
  assert.equal(workflow.approvalRequests[0].status, "parent-approval-required");
  assert.equal(
    workflow.cwd,
    normalizedWorktreeCwd,
    "manifest preserves target cwd",
  );
  assert.equal(
    workflow.worktree,
    normalizedWorktreeCwd,
    "manifest preserves target worktree",
  );
  assert.equal(
    childDispatch.details.approvalRequest.id,
    repeatedChildDispatch.details.approvalRequest.id,
    "repeated child dispatch returns the single parent request",
  );

  const initializedGoal = await tools
    .get("herdr_goal")
    .execute(
      "goal-initialize",
      { action: "initialize", objective: "Complete BB-029 safely." },
      undefined,
      undefined,
      ctx,
    );
  assert.equal(initializedGoal.details.goal.supervisor.state, "stopped");
  assert.deepEqual(calls.at(-1), [
    "pane",
    "report-metadata",
    rootPaneId,
    "--source",
    "herdr-orchestrator",
    "--token",
    "herdr_goal_status=Goal: active",
    "--token",
    "herdr_goal_next_1=Next: Choose one",
    "--token",
    "herdr_goal_next_2=dependency-ready",
    "--token",
    "herdr_goal_next_3=Herdr action or wait",
    "--clear-token",
    "herdr_queue",
    "--state-label",
    "idle=Goal: active",
    "--state-label",
    "done=Goal: active",
    "--ttl-ms",
    "86400000",
  ]);
  const runningGoal = await tools
    .get("herdr_goal")
    .execute(
      "goal-start",
      { action: "start", nudgeIntervalSeconds: 5 },
      undefined,
      undefined,
      headlessRootCtx,
    );
  assert.equal(runningGoal.details.goal.supervisor.state, "running");
  assert.equal(runningGoal.details.goal.supervisor.intervalSeconds, 5);
  assert.deepEqual(
    runningGoal.details.goal.supervisor.rootActivity?.status,
    "unknown",
  );
  // Exercise the actual extension lifecycle + controller against one shared
  // manifest. Virtual timestamps advance in 5s steps; no live Herdr or sleeps.
  let supervisorPrompts = 0;
  const supervisorApi = {
    async request(method, params) {
      if (method === "agent.get")
        return {
          type: "agent_info",
          agent: {
            name: "smoke-root",
            agent: "pi",
            pane_id: rootPaneId,
            workspace_id: rootWorkspaceId,
            agent_status: "idle",
          },
        };
      assert.equal(method, "agent.prompt");
      assert.equal(params.target, rootPaneId);
      supervisorPrompts += 1;
      return { type: "agent_prompted" };
    },
  };
  const tickBase = Date.parse(runningGoal.details.goal.supervisor.nextNudgeAt);
  const tick = (step) =>
    runSupervisorTick({
      stateDir: controllerConfigDir,
      herdr: supervisorApi,
      timestamp: new Date(tickBase + step * 5000).toISOString(),
    });
  const persistedGoal = async () =>
    JSON.parse(await readFile(manifestPath, "utf8")).parentGoal;
  await eventHandlers.get("agent_start")({}, headlessRootCtx);
  const activeRun = (await persistedGoal()).supervisor.rootTurn.runId;
  for (let step = 0; step < 5; step += 1) {
    await eventHandlers.get("tool_execution_end")?.({}, headlessRootCtx);
    await eventHandlers.get("turn_end")?.({}, headlessRootCtx);
    await eventHandlers.get("agent_end")?.({}, headlessRootCtx);
    await handleHook({
      stateDir: controllerConfigDir,
      herdr: supervisorApi,
      eventName: "pane.agent_status_changed",
      eventJson: {
        event: "pane_agent_status_changed",
        data: {
          type: "pane_agent_status_changed",
          pane_id: rootPaneId,
          workspace_id: rootWorkspaceId,
          agent: "pi",
          agent_status: "idle",
        },
      },
    });
    assert.equal((await tick(step)).results[0].status, "root-turn-not-idle");
    assert.equal((await persistedGoal()).supervisor.rootTurn.runId, activeRun);
  }
  assert.equal(
    supervisorPrompts,
    0,
    "tool/turn/run-end gaps and Herdr idle hooks never authorize a wake",
  );
  await eventHandlers.get("agent_settled")({}, headlessRootCtx);
  assert.equal(
    (await persistedGoal()).supervisor.rootTurn.state,
    "active",
    "settled while retrying is ignored",
  );
  rootIdle = true;
  await eventHandlers.get("agent_settled")({}, headlessRootCtx);
  assert.equal((await tick(5)).results[0].status, "delivered");
  assert.equal((await persistedGoal()).supervisor.nextNudgeAt, null);
  rootIdle = false;
  await eventHandlers.get("agent_start")({}, headlessRootCtx);
  assert.ok((await persistedGoal()).supervisor.lastDelivery.acknowledgedAt);
  for (let step = 6; step < 10; step += 1) await tick(step);
  rootIdle = true;
  await eventHandlers.get("agent_settled")({}, headlessRootCtx);
  await tick(10);
  assert.equal(
    supervisorPrompts,
    1,
    "acknowledging and settling a delivered wake do not re-arm it",
  );
  await tools
    .get("herdr_goal")
    .execute(
      "goal-noop",
      { action: "set-state", status: "active" },
      undefined,
      undefined,
      headlessRootCtx,
    );
  await tools
    .get("herdr_goal")
    .execute(
      "goal-start-noop",
      { action: "start" },
      undefined,
      undefined,
      headlessRootCtx,
    );
  await eventHandlers.get("agent_settled")({}, headlessRootCtx);
  await tick(11);
  assert.equal(
    supervisorPrompts,
    1,
    "idempotent state/start calls cannot reset the wake latch",
  );
  await eventHandlers.get("session_shutdown")(
    { reason: "reload" },
    headlessRootCtx,
  );
  await eventHandlers.get("session_start")(
    { reason: "reload" },
    headlessRootCtx,
  );
  await eventHandlers.get("agent_settled")({}, headlessRootCtx);
  assert.equal(
    (await persistedGoal()).supervisor.rootTurn.state,
    "unknown",
    "reload cannot manufacture a settled run",
  );
  await tick(12);
  assert.equal(supervisorPrompts, 1, "reload preserves delivered dedupe");
  rootIdle = false;
  await eventHandlers.get("agent_start")({}, headlessRootCtx);
  await tools
    .get("herdr_goal")
    .execute(
      "goal-wait",
      { action: "set-state", status: "waiting-for-event" },
      undefined,
      undefined,
      headlessRootCtx,
    );
  assert.equal((await tick(13)).results[0].status, "not-active");
  await tools.get("herdr_goal").execute(
    "goal-next",
    {
      action: "set-state",
      status: "active",
      nextAction: "Verify the next dependency.",
    },
    undefined,
    undefined,
    headlessRootCtx,
  );
  assert.equal((await tick(14)).results[0].status, "root-turn-not-idle");
  rootIdle = true;
  await eventHandlers.get("agent_settled")({}, headlessRootCtx);
  assert.equal((await tick(15)).results[0].status, "delivered");
  assert.equal(
    supervisorPrompts,
    2,
    "a real durable work transition authorizes one later wake",
  );
  const rootBeforeChild = await persistedGoal();
  process.env.HERDR_PANE_ID = "w-child:p1";
  await eventHandlers.get("agent_start")({}, headlessRootCtx);
  await eventHandlers.get("agent_settled")({}, headlessRootCtx);
  assert.deepEqual(
    await persistedGoal(),
    rootBeforeChild,
    "child lifecycle cannot write root authority",
  );
  process.env.HERDR_PANE_ID = rootPaneId;
  const pausedGoal = await tools
    .get("herdr_goal")
    .execute(
      "goal-pause",
      { action: "pause", pauseReason: "Waiting for explicit user direction." },
      undefined,
      undefined,
      headlessRootCtx,
    );
  assert.equal(pausedGoal.details.goal.status, "paused");
  assert.equal(
    pausedGoal.details.goal.supervisor.pauseReason,
    "Waiting for explicit user direction.",
  );
  await eventHandlers.get("agent_start")({}, headlessRootCtx);
  await eventHandlers.get("agent_settled")({}, headlessRootCtx);
  for (let step = 16; step < 21; step += 1)
    assert.equal((await tick(step)).results[0].status, "not-active");
  assert.equal(
    supervisorPrompts,
    2,
    "pause disarms all future nudges despite lifecycle activity",
  );
  assert.equal((await persistedGoal()).supervisor.nextNudgeAt, null);
  // Ambiguous sends require explicit recovery; work edits and idempotent start
  // must not replay them. Explicit stop/start is the reviewed reset path.
  const savedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  savedManifest.parentGoal.status = "active";
  savedManifest.parentGoal.supervisor.state = "running";
  savedManifest.parentGoal.supervisor.lastDelivery = {
    status: "uncertain",
    attemptedAt: new Date(tickBase).toISOString(),
  };
  await writeFile(manifestPath, JSON.stringify(savedManifest));
  await tools.get("herdr_goal").execute(
    "ambiguous-work-edit",
    {
      action: "set-state",
      status: "active",
      nextAction: "Review uncertainty.",
    },
    undefined,
    undefined,
    headlessRootCtx,
  );
  await tools
    .get("herdr_goal")
    .execute(
      "ambiguous-start-noop",
      { action: "start" },
      undefined,
      undefined,
      headlessRootCtx,
    );
  assert.equal(
    (await persistedGoal()).supervisor.lastDelivery.status,
    "uncertain",
  );
  await tools
    .get("herdr_goal")
    .execute(
      "reviewed-stop",
      { action: "stop" },
      undefined,
      undefined,
      headlessRootCtx,
    );
  await tools
    .get("herdr_goal")
    .execute(
      "reviewed-start",
      { action: "start" },
      undefined,
      undefined,
      headlessRootCtx,
    );
  assert.equal((await persistedGoal()).supervisor.lastDelivery, undefined);
  assert.ok((await persistedGoal()).supervisor.nextNudgeAt);
  await tools
    .get("herdr_goal")
    .execute(
      "re-pause",
      { action: "pause", pauseReason: "Test complete." },
      undefined,
      undefined,
      headlessRootCtx,
    );

  const lifecycleLockPath = join(
    dirname(manifestPath),
    ".manifest.json.herdr-orchestrator.lock",
  );
  await mkdir(lifecycleLockPath);
  let lifecycleFinished = false;
  const contendedStart = eventHandlers
    .get("agent_start")({}, headlessRootCtx)
    .then(() => {
      lifecycleFinished = true;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    lifecycleFinished,
    false,
    "lifecycle writer respects a held controller lock",
  );
  await rm(lifecycleLockPath, { recursive: true });
  await contendedStart;
  assert.equal(
    (await persistedGoal()).supervisor.rootTurn.state,
    "active",
    "lifecycle resumes after bounded lock contention",
  );
  const beforeFailure = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, "invalid manifest");
  await assert.rejects(
    eventHandlers.get("agent_start")({}, headlessRootCtx),
    /Cannot read Herdr manifest/,
  );
  assert.equal(
    abortedRuns,
    1,
    "failed active persistence aborts instead of silently running with stale idle authority",
  );
  await writeFile(manifestPath, beforeFailure);
  assert.doesNotMatch(
    source,
    /one-turn work signals|then stop\.|do not poll or auto-continue/,
    "injected guidance does not force one-action stops",
  );
  await assert.rejects(
    tools
      .get("herdr_goal")
      .execute(
        "goal-invalid-pause",
        { action: "pause" },
        undefined,
        undefined,
        headlessRootCtx,
      ),
    /pauseReason is required/,
  );
  // Corrected topology/startup behavior is exercised in test/dispatch-task.test.mjs.
  // Legacy plans without explicit model selection must never create resources.
  await assert.rejects(
    tools
      .get("herdr_dispatch")
      .execute(
        "root-dispatch",
        { workflowId, execute: true },
        undefined,
        undefined,
        headlessRootCtx,
      ),
    /explicit launchProfile/,
  );
  const bound = JSON.parse(await readFile(manifestPath, "utf8")).workflows[0];
  assert.equal(bound.taskBinding.workspaceId, rootWorkspaceId);
  assert.equal(bound.taskBinding.rootPaneId, rootPaneId);
  assert.equal(
    calls.some(
      (args) =>
        (args[0] === "workspace" && args[1] === "create") ||
        (args[0] === "worktree" && args[1] === "open"),
    ),
    false,
  );
} finally {
  if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = previousHerdrEnv;
  if (previousRootEnv === undefined) delete process.env.HERDR_ORCHESTRATOR_ROOT;
  else process.env.HERDR_ORCHESTRATOR_ROOT = previousRootEnv;
  if (previousPaneEnv === undefined) delete process.env.HERDR_PANE_ID;
  else process.env.HERDR_PANE_ID = previousPaneEnv;
  if (previousWorkspaceEnv === undefined) delete process.env.HERDR_WORKSPACE_ID;
  else process.env.HERDR_WORKSPACE_ID = previousWorkspaceEnv;
  if (previousPluginConfigDir === undefined)
    delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  else process.env.HERDR_PLUGIN_CONFIG_DIR = previousPluginConfigDir;
  await rm(testCwd, { recursive: true, force: true });
}

process.stdout.write("herdr-orchestrator smoke check passed\n");
