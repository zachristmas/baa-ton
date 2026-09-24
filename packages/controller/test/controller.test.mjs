import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ControllerError,
  JsonLineHerdrClient,
  herdrSocketEndpoint,
  handleHook,
  hookResponse,
  runSupervisorLoop,
  runSupervisorTick,
  routeChildMessage,
  validateConfig,
  postDirective,
  runSupervisorLauncher,
  SUPERVISOR_RESTART_EXIT_CODE,
  nudgeDecision,
} from "../controller.mjs";
import { codeChangeWatcher, codeFingerprint, codeStamp, listRuntime, loadedCode, recordRuntime } from "../code-version.mjs";
import { configureSidebar } from "../sidebar-configure.mjs";
import { validateParentGoal as validateParentGoal974a77d } from "./fixtures/controller-974a77d-goal-validation.mjs";
import { readStore, storePath } from "../../herdr-tools/inbox/index.mjs";

// These tests pin routing and delivery, not timing: deliver each digest as
// soon as the root is ready. The window has its own tests.
process.env.BAA_TON_DIGEST_WINDOW_SECONDS = "0";

const ROOT = {
  target: "bb029-root",
  target_kind: "name",
  agent_kind: "pi",
  pane_id: "w-root:p1",
  workspace_id: "w-root",
};
test("sidebar configuration appends only Baa-ton goal rows and is idempotent", () => {
  const config = `[ui]\n\n[ui.sidebar.agents]\nrows = [[{ token = "$title_idle" }]]\n\n[ui.sidebar.agents.rows_by_agent]\npi = [[{ token = "$title_idle" }], [{ token = "$quota_context_normal" }]] # herdr-agent-quota-provider\ncodex = [[{ token = "$title_idle" }]]\n\n[ui.sidebar.spaces]\nrows = [["workspace"]]\n`;
  const first = configureSidebar(config);
  assert.equal(first.changed, true);
  assert.equal((first.text.match(/# >>> baa-ton goal rows/g) ?? []).length, 2);
  assert.match(first.text, /\$quota_context_normal/);
  assert.match(first.text, /\$herdr_role/);
  assert.match(first.text, /\$herdr_workflow/);
  const second = configureSidebar(first.text);
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
});

const CHILD = {
  lane_id: "lane-child",
  target: "bb029-writer",
  target_kind: "name",
  pane_id: "w-child:p1",
  workspace_id: "w-child",
};

test("supervisor metadata publishes pane-scoped root and child role breadcrumbs", async () => {
  const fixture = await createFixture();
  const metadata = [];
  try {
    const result = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: {
        async request(method, params) {
          assert.equal(method, "pane.report_metadata");
          metadata.push(params);
          return { result: {} };
        },
      },
    });
    assert.equal(result.results[0].status, "no-parent-goal");
    assert.deepEqual(metadata.map((item) => item.tokens), [
      { herdr_role: "🐕 root" },
      { herdr_role: "🐑 child", herdr_workflow: "bb029" },
    ]);
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture({
  root = ROOT,
  child = CHILD,
  piGoalPauseDetection = true,
  parentGoal,
  settledRoot = true,
  workflowStatus,
  workflowOutcome,
  laneStatus,
  completionReceipt,
  approvalRequests,
  questionRequests,
  messageRequests,
  siblingLane,
  // Supervisor nudges need actionable work; by default a supervised goal
  // has one open lane request the root has already seen in a digest.
  laneRequests = parentGoal?.supervisor
    ? [
        {
          id: "request-waiting",
          workflowId: "herdr-bb029",
          laneId: child.lane_id,
          kind: "runtime-launch",
          payload: { command: "npm run dev" },
          summary: "runtime launch: npm run dev",
          status: "open",
          requestedAt: "2026-09-14T00:00:00.000Z",
          delivery: { status: "delivered", attempts: 1, updatedAt: "2026-09-14T00:00:00.000Z" },
        },
      ]
    : undefined,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-controller-"));
  const stateDir = join(directory, "state");
  const manifestPath = join(
    directory,
    "workflow",
    ".pi",
    "herdr-orchestrator",
    "manifest.json",
  );
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
  const manifest = {
    version: 2,
    ...(parentGoal
      ? {
          parentGoal: {
            ...parentGoal,
            ...(parentGoal.supervisor
              ? {
                  supervisor: {
                    ...parentGoal.supervisor,
                    ...(settledRoot
                      ? {
                          rootTurn: {
                            state: "idle",
                            runId: "settled-fixture-run",
                            paneId: root.pane_id,
                            workspaceId: root.workspace_id,
                            updatedAt: "2026-09-14T00:00:00.000Z",
                          },
                        }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    workflows: [
      {
        id: "herdr-bb029",
        ...(workflowStatus ? { status: workflowStatus } : {}),
        ...(workflowOutcome ? { outcome: workflowOutcome } : {}),
        ...(approvalRequests ? { approvalRequests } : {}),
        ...(questionRequests ? { questionRequests } : {}),
        ...(messageRequests ? { messageRequests } : {}),
        ...(laneRequests ? { laneRequests } : {}),
        ownership: {
          createdBy: "herdr-orchestrator",
          workspaceId: child.workspace_id,
        },
        lanes: [
          {
            id: child.lane_id,
            paneId: child.pane_id,
            agentName: child.target,
            ...(laneStatus ? { status: laneStatus } : {}),
            ...(completionReceipt ? { completionReceipt } : {}),
          },
          ...(siblingLane
            ? [
                {
                  id: siblingLane.lane_id,
                  paneId: siblingLane.pane_id,
                  agentName: siblingLane.target,
                },
              ]
            : []),
        ],
      },
    ],
  };
  const config = {
    version: 1,
    owner: "herdr-orchestrator",
    root,
    workflows: [
      {
        workflow_id: "herdr-bb029",
        manifest_path: manifestPath,
        pi_goal_pause_detection: piGoalPauseDetection,
        lanes: [child, ...(siblingLane ? [siblingLane] : [])],
      },
    ],
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  await writeFile(
    join(stateDir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    directory,
    stateDir,
    manifestPath,
    async manifest() {
      return JSON.parse(await readFile(manifestPath, "utf8"));
    },
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function startHerdrMock(respond) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-controller-socket-"));
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\herdr-controller-test-${basename(directory)}`
      : join(directory, "api.sock");
  const requests = [];
  const server = net.createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(input.slice(0, newline));
      requests.push(request);
      const reply = await respond(request);
      socket.end(`${JSON.stringify({ id: request.id, ...reply })}\n`);
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  return {
    socketPath,
    requests,
    async close() {
      await new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function rootAgentInfo() {
  return {
    result: {
      type: "agent_info",
      agent: {
        agent: ROOT.agent_kind,
        name: ROOT.target,
        pane_id: ROOT.pane_id,
        workspace_id: ROOT.workspace_id,
        agent_status: "idle",
      },
    },
  };
}

function statusEvent(status, agent = "pi", child = CHILD) {
  return {
    event: "pane_agent_status_changed",
    data: {
      type: "pane_agent_status_changed",
      pane_id: child.pane_id,
      workspace_id: child.workspace_id,
      agent_status: status,
      agent,
    },
  };
}

function rootStatusEvent(status, agent = "pi") {
  return {
    event: "pane_agent_status_changed",
    data: {
      type: "pane_agent_status_changed",
      pane_id: ROOT.pane_id,
      workspace_id: ROOT.workspace_id,
      agent_status: status,
      agent,
    },
  };
}

function outputEvent(revision = 1) {
  return {
    event: "pane_output_changed",
    data: {
      type: "pane_output_changed",
      pane_id: CHILD.pane_id,
      workspace_id: CHILD.workspace_id,
      revision,
    },
  };
}

function client(mock) {
  return new JsonLineHerdrClient(mock.socketPath, 1_000);
}

function requestsFor(mock, method) {
  return mock.requests.filter((request) => request.method === method);
}

async function seedWorkingTransition(fixture, receivedAt, child = CHILD) {
  await handleHook({
    eventName: "pane.agent_status_changed",
    eventJson: statusEvent("working", "pi", child),
    stateDir: fixture.stateDir,
    herdr: {
      async request(method) {
        assert.equal(method, "pane.report_metadata");
        return { result: {} };
      },
    },
  });
  const manifest = await fixture.manifest();
  const transition = manifest.workflows[0].eventController.events.at(-1);
  transition.received_at = receivedAt;
  await writeFile(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return transition;
}

function rootWakeApi(
  prompts,
  roots = new Map([[ROOT.target, ROOT]]),
  lanePrompts,
) {
  return {
    async request(method, params = {}) {
      if (method === "pane.report_metadata") return { result: {} };
      if (method === "agent.prompt") {
        // Root-directed wakes are recorded as text for existing assertions;
        // lane-directed goal nudges go to the optional capture array.
        if (params.target === ROOT.target) prompts.push(params.text);
        else if (lanePrompts) lanePrompts.push(params);
        return { result: { type: "agent_prompted" } };
      }
      const root = roots.get(params.target);
      assert.ok(root, `unexpected Herdr target ${params.target}`);
      return {
        type: "agent_info",
        agent: {
          agent: root.agent_kind,
          name: root.target,
          pane_id: root.pane_id,
          workspace_id: root.workspace_id,
          agent_status: "idle",
        },
      };
    },
  };
}

function parsePluginManifest(raw) {
  const top = {};
  const events = [];
  const actions = [];
  let current = top;
  for (const untrimmed of raw.split(/\r?\n/)) {
    const line = untrimmed.trim();
    if (!line || line.startsWith("#")) continue;
    if (["[[events]]", "[[startup]]", "[[actions]]"].includes(line)) {
      current = {};
      (line === "[[events]]"
        ? events
        : line === "[[actions]]"
          ? actions
          : (top.startup ??= [])
      ).push(current);
      continue;
    }
    const match =
      /^(id|name|version|min_herdr_version|description|platforms|on|command|title) = (.+)$/.exec(
        line,
      );
    assert.ok(match, `unsupported or malformed manifest line: ${line}`);
    current[match[1]] = JSON.parse(match[2]);
  }
  return { top, events, actions };
}

test("manifest has the required ID, compatible version floor, and supported event hooks", async () => {
  const raw = await readFile(
    new URL("../herdr-plugin.toml", import.meta.url),
    "utf8",
  );
  const manifest = parsePluginManifest(raw);
  assert.deepEqual(manifest.top, {
    id: "herdr-orchestrator-controller",
    name: "herdr-orchestrator-controller",
    version: "0.1.0",
    min_herdr_version: "0.9.0",
    description:
      "Durable, root-only event controller for Herdr Orchestrator workflows.",
    platforms: ["linux", "macos", "windows"],
    startup: [
      {
        platforms: ["linux", "macos"],
        command: ["sh", "supervisor.sh"],
      },
      {
        platforms: ["windows"],
        command: ["node", "controller.mjs", "supervisor"],
      },
    ],
  });
  const startupScript = await readFile(
    new URL("../supervisor.sh", import.meta.url),
    "utf8",
  );
  assert.match(startupScript, /volta" which node/);
  assert.match(
    startupScript,
    /exec "\$\{node_bin\}" controller\.mjs supervisor/,
  );
  assert.deepEqual(manifest.actions, [
    {
      id: "configure-sidebar",
      title: "Install / repair Baa-ton sidebar rows",
      command: [
        "sh",
        "-c",
        'node "$HERDR_PLUGIN_ROOT/sidebar-configure.mjs" --apply && herdr server reload-config',
      ],
    },
  ]);
  assert.deepEqual(manifest.events, [
    {
      on: "pane.agent_status_changed",
      command: ["node", "controller.mjs", "hook"],
    },
  ]);
});

test("legacy v1 config migrates to one isolated orchestrator record", () => {
  const manifestPath = resolve(
    "/tmp/shared/.pi/herdr-orchestrator/manifest.json",
  );
  const secondChild = {
    lane_id: "lane-child-2",
    target: "bb029-reviewer",
    target_kind: "name",
    pane_id: "w-child-2:p1",
    workspace_id: "w-child-2",
  };
  const config = validateConfig({
    version: 1,
    owner: "herdr-orchestrator",
    root: ROOT,
    workflows: [
      {
        workflow_id: "herdr-bb029",
        manifest_path: manifestPath,
        lanes: [CHILD],
      },
      {
        workflow_id: "herdr-bb030",
        manifest_path: manifestPath,
        lanes: [secondChild],
      },
    ],
  });
  assert.deepEqual(
    config.orchestrators[0].workflows.map((workflow) => workflow.manifest_path),
    [manifestPath, manifestPath],
  );
});

test("isolated v2 records route wakes and root activity to only their own root", async () => {
  const fixture = await createFixture({
    parentGoal: {
      version: 1,
      id: "parent-a",
      objective: "A",
      status: "active",
      nextAction: "A",
      signals: [],
      supervisor: {
        version: 1,
        state: "running",
        intervalSeconds: 5,
        nudgeCount: 0,
        nextNudgeAt: null,
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
      },
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    },
  });
  const rootB = {
    target: "root-b",
    target_kind: "name",
    agent_kind: "pi",
    pane_id: "w-b:p1",
    workspace_id: "w-b",
  };
  const childB = {
    lane_id: "lane-b",
    target: "child-b",
    target_kind: "name",
    pane_id: "w-b-child:p1",
    workspace_id: "w-b-child",
  };
  const secondManifestPath = join(fixture.directory, "second", "manifest.json");
  await mkdir(dirname(secondManifestPath), { recursive: true });
  await writeFile(
    secondManifestPath,
    `${JSON.stringify({ version: 2, parentGoal: { version: 1, id: "parent-b", objective: "B", status: "active", nextAction: "B", signals: [], supervisor: { version: 1, state: "running", intervalSeconds: 5, nudgeCount: 0, nextNudgeAt: null, createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" }, createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" }, workflows: [{ id: "herdr-b", ownership: { createdBy: "herdr-orchestrator" }, lanes: [{ id: childB.lane_id, paneId: childB.pane_id, agentName: childB.target }] }] })}\n`,
  );
  const configPath = join(fixture.stateDir, "config.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 2,
        owner: "herdr-orchestrator",
        orchestrators: [
          {
            id: "a",
            root: ROOT,
            program: { id: "program-a", workspace_id: ROOT.workspace_id },
            workflows: [
              {
                workflow_id: "herdr-bb029",
                manifest_path: fixture.manifestPath,
                lanes: [CHILD],
              },
            ],
          },
          {
            id: "b",
            root: rootB,
            program: { id: "program-b", workspace_id: rootB.workspace_id },
            workflows: [
              {
                workflow_id: "herdr-b",
                manifest_path: secondManifestPath,
                lanes: [childB],
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const prompts = [];
  const herdr = {
    async request(method, params) {
      if (method === "agent.get") {
        const root = params.target === ROOT.target ? ROOT : rootB;
        return {
          type: "agent_info",
          agent: {
            agent: "pi",
            name: root.target,
            pane_id: root.pane_id,
            workspace_id: root.workspace_id,
            agent_status: "idle",
          },
        };
      }
      if (method === "agent.prompt") {
        prompts.push(params.target);
        return {};
      }
      throw new Error(`Unexpected ${method}`);
    },
  };
  try {
    await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("done"),
      stateDir: fixture.stateDir,
      herdr,
    });
    assert.deepEqual(
      prompts,
      [ROOT.target],
      "a child event never wakes another root",
    );
    await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: {
        event: "pane_agent_status_changed",
        data: {
          type: "pane_agent_status_changed",
          pane_id: rootB.pane_id,
          workspace_id: rootB.workspace_id,
          agent_status: "working",
        },
      },
      stateDir: fixture.stateDir,
      herdr,
    });
    assert.equal(
      (await fixture.manifest()).parentGoal.supervisor.rootActivity,
      undefined,
      "root B activity never mutates record A",
    );
    const second = JSON.parse(await readFile(secondManifestPath, "utf8"));
    assert.equal(second.parentGoal.supervisor.rootActivity.status, "working");
  } finally {
    await fixture.cleanup();
  }
});

test("socket validation accepts POSIX sockets and Windows named pipes", () => {
  const posix = new JsonLineHerdrClient("/tmp/herdr-controller.sock");
  const windowsPipe = "\\\\.\\pipe\\herdr-controller";
  const windows = new JsonLineHerdrClient(windowsPipe);
  assert.equal(posix.socketPath, "/tmp/herdr-controller.sock");
  assert.equal(
    herdrSocketEndpoint("/tmp/herdr-controller.sock", "linux"),
    "/tmp/herdr-controller.sock",
  );
  assert.equal(windows.socketPath, windowsPipe);
  assert.equal(windows.socketEndpoint, windowsPipe);
  assert.equal(
    herdrSocketEndpoint(
      "C:\\Users\\zchri\\AppData\\Roaming\\herdr\\herdr.sock",
      "win32",
    ),
    "\\\\.\\pipe\\C:\\Users\\zchri\\AppData\\Roaming\\herdr\\herdr.sock",
  );
  assert.throws(
    () => new JsonLineHerdrClient("relative.sock"),
    /absolute POSIX socket path or Windows named pipe/,
  );
});

test("malformed events fail closed, unrelated events are ignored, and ambiguity is rejected", async () => {
  const fixture = await createFixture();
  const mock = await startHerdrMock(() => {
    throw new Error("a rejected event must not reach Herdr");
  });
  try {
    await assert.rejects(
      handleHook({
        eventName: "pane.agent_status_changed",
        eventJson: {
          event: "pane_agent_status_changed",
          data: { type: "pane_agent_status_changed" },
        },
        stateDir: fixture.stateDir,
        herdr: client(mock),
      }),
      ControllerError,
    );
    await assert.rejects(
      handleHook({
        eventName: "pane.output_changed",
        eventJson: outputEvent(),
        stateDir: fixture.stateDir,
        herdr: client(mock),
      }),
      /Unsupported plugin event hook/,
    );
    const ignored = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: {
        ...statusEvent("done"),
        data: { ...statusEvent("done").data, pane_id: "w-unmapped:p1" },
      },
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.deepEqual(ignored, {
      accepted: true,
      ignored: true,
      reason: "unmapped_event",
    });

    const configPath = join(fixture.stateDir, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.workflows.push({
      ...config.workflows[0],
      workflow_id: "herdr-bb030",
    });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    await assert.rejects(
      handleHook({
        eventName: "pane.agent_status_changed",
        eventJson: statusEvent("done"),
        stateDir: fixture.stateDir,
        herdr: client(mock),
      }),
      /matches multiple explicit owner\/workflow\/child-lane mappings/,
    );
    assert.equal(mock.requests.length, 0);
    const manifest = await fixture.manifest();
    assert.equal(manifest.workflows[0].eventController, undefined);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("missing config is an inert hook while malformed config still fails closed", async () => {
  const fixture = await createFixture();
  let requests = 0;
  const herdr = {
    async request() {
      requests += 1;
      throw new Error("a config-only hook must not call Herdr");
    },
  };
  try {
    await rm(join(fixture.stateDir, "config.json"));
    const ignored = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("done"),
      stateDir: fixture.stateDir,
      herdr,
    });
    assert.deepEqual(ignored, {
      accepted: true,
      ignored: true,
      reason: "missing_config",
    });
    assert.equal(requests, 0);
    assert.equal(
      (await fixture.manifest()).workflows[0].eventController,
      undefined,
      "a missing config must not mutate a workflow manifest",
    );

    await writeFile(join(fixture.stateDir, "config.json"), "{invalid\n", {
      mode: 0o600,
    });
    await assert.rejects(
      handleHook({
        eventName: "pane.agent_status_changed",
        eventJson: statusEvent("done"),
        stateDir: fixture.stateDir,
        herdr,
      }),
      /Controller config is not valid JSON/,
    );
    assert.equal(requests, 0, "malformed config must fail before a Herdr call");
  } finally {
    await fixture.cleanup();
  }
});

test("protocol-22 named Pi root accepts agent kind events while serializing duplicates", async () => {
  const fixture = await createFixture();
  let promptCount = 0;
  const mock = await startHerdrMock(async (request) => {
    if (request.method === "agent.get") {
      assert.equal(request.params.target, "bb029-root");
      return rootAgentInfo();
    }
    if (request.method === "agent.prompt") {
      promptCount += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
      return {
        result: { type: "agent_prompted", agent: { name: ROOT.target } },
      };
    }
    throw new Error(`Unexpected method: ${request.method}`);
  });
  try {
    const [first, second] = await Promise.all([
      handleHook({
        eventName: "pane.agent_status_changed",
        eventJson: statusEvent("done"),
        stateDir: fixture.stateDir,
        herdr: client(mock),
      }),
      handleHook({
        eventName: "pane.agent_status_changed",
        eventJson: statusEvent("done"),
        stateDir: fixture.stateDir,
        herdr: client(mock),
      }),
    ]);
    assert.equal(first.accepted, true);
    assert.equal(second.accepted, true);
    assert.deepEqual([first.deduplicated, second.deduplicated].sort(), [
      false,
      true,
    ]);
    assert.equal(promptCount, 1);
    const prompts = requestsFor(mock, "agent.prompt");
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].params.target, ROOT.target);
    assert.equal(
      Object.hasOwn(prompts[0].params, "wait"),
      false,
      "root wake never uses a foreground wait",
    );
    assert.notEqual(
      prompts[0].params.target,
      CHILD.target,
      "a child is never prompted",
    );
    const manifest = await fixture.manifest();
    const events = manifest.workflows[0].eventController.events;
    assert.equal(events.length, 1);
    assert.equal(events[0].classification, "done");
    assert.equal(events[0].wake.status, "delivered");
    assert.equal(events[0].wake.attempts, 1);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("post-completion done and idle transitions are observational and never wake the root", async () => {
  const child = {
    ...CHILD,
    pane_id: "w-root:p2",
    workspace_id: ROOT.workspace_id,
  };
  const fixture = await createFixture({
    child,
    completionReceipt: {
      id: "incarnation-1",
      summary: "lane completed",
      delivery: "delivered",
    },
    parentGoal: {
      version: 1,
      id: "parent-post-completion",
      objective: "Do not wake after completion.",
      status: "waiting-for-event",
      nextAction: "Wait for a durable controller event.",
      signals: [],
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    },
  });
  const requests = [];
  const herdr = {
    async request(method) {
      requests.push(method);
      return { result: {} };
    },
  };
  try {
    const result = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("done", "pi", child),
      stateDir: fixture.stateDir,
      herdr,
    });
    const idle = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("idle", "pi", child),
      stateDir: fixture.stateDir,
      herdr,
    });
    for (const transition of [result, idle]) {
      assert.equal(transition.record.classification, "unclassified");
      assert.equal(transition.record.wake.status, "not-required");
    }
    assert.deepEqual(
      requests.filter((method) => method === "agent.get" || method === "agent.prompt"),
      [],
    );
    const manifest = await fixture.manifest();
    const events = manifest.workflows[0].eventController.events;
    assert.deepEqual(
      events.map((event) => event.classification),
      ["unclassified", "unclassified"],
    );
    assert.deepEqual(manifest.parentGoal.signals, []);
    const inbox = await readStore(storePath({ stateDir: fixture.stateDir }));
    assert.equal(inbox.messages.length, 2, "observational events remain durable");
    assert.equal(inbox.messages[0].states.notified, null);
    assert.deepEqual(inbox.wake_hints, [], "observational events never enqueue a wake");
  } finally {
    await fixture.cleanup();
  }
});

test("durable child messages wake the root after lane completion in one digest and remain distinct", async () => {
  const child = {
    ...CHILD,
    pane_id: "w-root:p5",
    workspace_id: ROOT.workspace_id,
  };
  const messageRequests = [
    {
      version: 1,
      id: "message-late-worktree",
      workflowId: "herdr-bb029",
      laneId: child.lane_id,
      summary: "The user asked for more work; the worktree was removed.",
      kind: "informational",
      requestedAt: "2026-09-16T00:00:00.000Z",
      delivery: { status: "pending", attempts: 0, updatedAt: "2026-09-16T00:00:00.000Z" },
    },
    {
      version: 1,
      id: "message-late-distinct",
      workflowId: "herdr-bb029",
      laneId: child.lane_id,
      summary: "A distinct late fact also needs review.",
      kind: "informational",
      requestedAt: "2026-09-16T00:00:01.000Z",
      delivery: { status: "pending", attempts: 0, updatedAt: "2026-09-16T00:00:01.000Z" },
    },
  ];
  const fixture = await createFixture({
    child,
    workflowStatus: "completed",
    workflowOutcome: "completed",
    completionReceipt: {
      id: "incarnation-1",
      summary: "lane completed",
      delivery: "delivered",
    },
    messageRequests,
    parentGoal: {
      version: 1,
      id: "parent-message",
      objective: "Review late child information.",
      status: "completed",
      nextAction: "No more work.",
      signals: [],
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
    },
  });
  const mock = await startHerdrMock(async (request) => {
    if (request.method === "agent.get") return rootAgentInfo();
    if (request.method === "agent.prompt") return { result: {} };
    throw new Error(`Unexpected ${request.method}`);
  });
  try {
    const first = await routeChildMessage({
      configDir: fixture.stateDir,
      workflowId: "herdr-bb029",
      laneId: child.lane_id,
      messageId: messageRequests[0].id,
      herdr: client(mock),
    });
    const second = await routeChildMessage({
      configDir: fixture.stateDir,
      workflowId: "herdr-bb029",
      laneId: child.lane_id,
      messageId: messageRequests[1].id,
      herdr: client(mock),
    });
    assert.equal(first.delivery, "delivered");
    assert.equal(second.delivery, "delivered");
    // Both messages were pending when the first route ran, so one digest
    // carries both and the second route finds nothing left to send.
    assert.equal(first.digest.count, 2);
    assert.equal(second.digest.status, "empty");
    const prompts = requestsFor(mock, "agent.prompt");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].params.text, /^\[Baa-ton digest\] 2 updates/);
    assert.match(prompts[0].params.text, /herdr-bb029\/lane-child \(message-late-worktree\): The user asked for more work/);
    assert.match(prompts[0].params.text, /\(message-late-distinct\): A distinct late fact/);
    const manifest = await fixture.manifest();
    assert.equal(manifest.parentGoal.status, "review-requested");
    assert.doesNotMatch(manifest.parentGoal.nextAction, /action-required/);
    assert.deepEqual(
      manifest.workflows[0].messageRequests.map((request) => request.delivery.status),
      ["delivered", "delivered"],
    );
    const inbox = await readStore(storePath({ stateDir: fixture.stateDir }));
    assert.deepEqual(
      inbox.messages.map((message) => message.envelope.message.type),
      ["child-message", "child-message"],
    );
    assert.equal(inbox.wake_hints.length, 1);
    assert.deepEqual(
      inbox.wake_hints[0].occurrence_ids,
      [messageRequests[0].id, messageRequests[1].id],
    );
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("sibling completion wakes survive a lane-scoped operator closure", async () => {
  const closedLane = {
    ...CHILD,
    lane_id: "lane-1",
    target: "lane-1-agent",
    pane_id: "w-root:p6",
  };
  const activeSibling = {
    ...CHILD,
    lane_id: "lane-2",
    target: "lane-2-agent",
    pane_id: "w-root:p7",
  };
  const fixture = await createFixture({
    child: closedLane,
    laneStatus: "operator-closed",
    siblingLane: activeSibling,
    piGoalPauseDetection: false,
  });
  const mock = await startHerdrMock(async (request) => {
    if (request.method === "agent.get") return rootAgentInfo();
    if (request.method === "agent.prompt") return { result: {} };
    throw new Error(`Unexpected ${request.method}`);
  });
  try {
    const result = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("done", "pi", activeSibling),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.equal(result.record.classification, "done");
    assert.equal(result.record.wake.status, "delivered");
    assert.equal(requestsFor(mock, "agent.prompt").length, 1);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("post-completion blocked transitions remain actionable", async () => {
  const child = {
    ...CHILD,
    pane_id: "w-root:p3",
    workspace_id: ROOT.workspace_id,
  };
  const fixture = await createFixture({
    child,
    workflowStatus: "operator-closed",
    piGoalPauseDetection: false,
  });
  const mock = await startHerdrMock(async (request) => {
    if (request.method === "agent.get") return rootAgentInfo();
    if (request.method === "agent.prompt") return { result: {} };
    throw new Error(`Unexpected ${request.method}`);
  });
  try {
    const result = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("blocked", "pi", child),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.equal(result.record.classification, "blocked");
    assert.equal(result.record.wake.status, "delivered");
    assert.equal(requestsFor(mock, "agent.prompt").length, 1);
    const inbox = await readStore(storePath({ stateDir: fixture.stateDir }));
    assert.equal(inbox.wake_hints.length, 1);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("pre-completion done transitions remain actionable", async () => {
  const child = {
    ...CHILD,
    pane_id: "w-root:p4",
    workspace_id: ROOT.workspace_id,
  };
  const fixture = await createFixture({
    child,
    piGoalPauseDetection: false,
  });
  const mock = await startHerdrMock(async (request) => {
    if (request.method === "agent.get") return rootAgentInfo();
    if (request.method === "agent.prompt") return { result: {} };
    throw new Error(`Unexpected ${request.method}`);
  });
  try {
    const result = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("done", "pi", child),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.equal(result.record.classification, "done");
    assert.equal(result.record.wake.status, "delivered");
    assert.equal(requestsFor(mock, "agent.prompt").length, 1);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("a genuine repeated status (blocked -> working -> blocked) wakes twice, while an exact repeat still dedupes", async () => {
  const fixture = await createFixture({ piGoalPauseDetection: false });
  const prompts = [];
  const mock = await startHerdrMock(async (request) => {
    if (request.method === "agent.get") return rootAgentInfo();
    if (request.method === "agent.prompt") {
      prompts.push(request.params.target);
      return { result: { type: "agent_prompted", agent: { name: ROOT.target } } };
    }
    throw new Error(`Unexpected method: ${request.method}`);
  });
  try {
    const first = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("blocked"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.equal(first.record.wake.status, "delivered");
    const working = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("working"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.equal(working.record.classification, "unclassified");
    assert.equal(working.record.wake.status, "not-required");
    const second = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("blocked"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.equal(
      second.deduplicated,
      false,
      "a real second blocker is not the same occurrence as the first",
    );
    assert.equal(second.record.wake.status, "delivered");
    assert.notEqual(
      second.record.identity,
      first.record.identity,
      "each genuine transition gets a distinct durable identity",
    );
    const repeat = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("blocked"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.equal(repeat.deduplicated, true);
    assert.equal(repeat.record.identity, second.record.identity);
    assert.deepEqual(prompts, [ROOT.target, ROOT.target]);
    const manifest = await fixture.manifest();
    const events = manifest.workflows[0].eventController.events;
    assert.equal(events.length, 3, "blocked, working, and blocked are three durable transitions");
    assert.equal(manifest.parentGoal, undefined);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("a new actionable lane event requests root review once", async () => {
  const fixture = await createFixture({
    parentGoal: {
      version: 1,
      id: "parent-bb029",
      objective: "Complete BB-029 safely.",
      status: "waiting-for-event",
      nextAction: "Wait for a durable controller event.",
      signals: [],
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    },
  });
  const metadata = [];
  const mock = await startHerdrMock((request) => {
    if (request.method === "agent.get") return rootAgentInfo();
    if (request.method === "agent.prompt") return { result: {} };
    if (request.method === "pane.report_metadata") {
      metadata.push(request.params);
      return { result: {} };
    }
    throw new Error(`Unexpected method: ${request.method}`);
  });
  try {
    await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("done"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("done"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    const goal = (await fixture.manifest()).parentGoal;
    assert.equal(goal.status, "review-requested");
    assert.equal(
      goal.signals.length,
      1,
      "duplicate hooks do not duplicate goal signals",
    );
    assert.equal(goal.signals[0].classification, "done");
    assert.match(goal.nextAction, /Review durable done event/);
    assert.equal(metadata.length, 1);
    assert.equal(metadata[0].pane_id, ROOT.pane_id);
    assert.equal(metadata[0].source, "herdr-orchestrator");
    assert.equal(metadata[0].ttl_ms, 86_400_000);
    assert.deepEqual(metadata[0].tokens, {
      herdr_role: "🐕 root",
      herdr_goal_status: "Goal: review requested",
      herdr_goal_next_1: "Next: Review durable done",
      herdr_goal_next_2: "event",
      herdr_goal_next_3:
        goal.nextAction.match(/event\s+([^\s]+)\s+for/)?.[1] ?? null,
    });
    assert.deepEqual(metadata[0].state_labels, {
      idle: "Goal: review requested",
      done: "Goal: review requested",
    });
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("terminal parent goals emit one durable mismatch signal for active routed workflows", async () => {
  for (const status of ["completed", "blocked", "paused"]) {
    const fixture = await createFixture({
      parentGoal: {
        version: 1,
        id: `parent-mismatch-${status}`,
        objective: "Finish the previous round.",
        status,
        nextAction: "Previous round is complete.",
        signals: [],
        createdAt: "2026-09-16T00:00:00.000Z",
        updatedAt: "2026-09-16T00:00:00.000Z",
      },
      workflowStatus: "running",
      workflowOutcome: "running",
      piGoalPauseDetection: false,
    });
    const mock = await startHerdrMock((request) => {
      if (request.method === "pane.report_metadata") return { result: {} };
      throw new Error(`Unexpected method: ${request.method}`);
    });
    try {
      const event = {
        event: "pane_agent_status_changed",
        data: {
          type: "pane_agent_status_changed",
          pane_id: CHILD.pane_id,
          workspace_id: CHILD.workspace_id,
          agent_status: "working",
          agent: "pi",
        },
      };
      await handleHook({
        eventName: "pane.agent_status_changed",
        eventJson: event,
        stateDir: fixture.stateDir,
        herdr: client(mock),
      });
      await handleHook({
        eventName: "pane.agent_status_changed",
        eventJson: event,
        stateDir: fixture.stateDir,
        herdr: client(mock),
      });
      const goal = (await fixture.manifest()).parentGoal;
      const mismatchSignals = goal.signals.filter((signal) =>
        signal.identity.startsWith("parent-goal-mismatch:"),
      );
      assert.equal(goal.status, "review-requested");
      assert.equal(mismatchSignals.length, 1);
      assert.match(goal.nextAction, /parent-mismatch/);
      assert.match(goal.nextAction, /remain active/);
      assert.match(goal.nextAction, /herdr_goal action=reset/);
    } finally {
      await mock.close();
      await fixture.cleanup();
    }
  }
});

test("non-terminal parent goals do not get a mismatch signal from mapped events", async () => {
  for (const status of ["active", "waiting-for-event", "action-required", "review-requested"]) {
    const fixture = await createFixture({
      parentGoal: {
        version: 1,
        id: `parent-not-mismatch-${status}`,
        objective: "Continue the current round.",
        status,
        nextAction: "Continue current work.",
        signals: [],
        createdAt: "2026-09-16T00:00:00.000Z",
        updatedAt: "2026-09-16T00:00:00.000Z",
      },
      workflowStatus: "running",
      workflowOutcome: "running",
      piGoalPauseDetection: false,
    });
    try {
      await handleHook({
        eventName: "pane.agent_status_changed",
        eventJson: {
          event: "pane_agent_status_changed",
          data: {
            type: "pane_agent_status_changed",
            pane_id: CHILD.pane_id,
            workspace_id: CHILD.workspace_id,
            agent_status: "working",
            agent: "pi",
          },
        },
        stateDir: fixture.stateDir,
        herdr: {
          async request(method) {
            assert.equal(method, "pane.report_metadata");
            return { result: {} };
          },
        },
      });
      const goal = (await fixture.manifest()).parentGoal;
      assert.equal(goal.status, status);
      assert.equal(
        goal.signals.some((signal) => signal.identity.startsWith("parent-goal-mismatch:")),
        false,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("supervisor tick detects a terminal parent goal with a non-terminal routed workflow", async () => {
  const fixture = await createFixture({
    parentGoal: {
      version: 1,
      id: "parent-supervisor-mismatch",
      objective: "Finish the previous round.",
      status: "completed",
      nextAction: "Previous round is complete.",
      signals: [],
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
    },
    workflowStatus: "running",
    workflowOutcome: "running",
    piGoalPauseDetection: false,
  });
  const mock = await startHerdrMock((request) => {
    if (request.method === "pane.report_metadata") return { result: {} };
    throw new Error(`Unexpected method: ${request.method}`);
  });
  try {
    const first = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: client(mock),
      timestamp: "2026-09-16T00:00:01.000Z",
    });
    const second = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: client(mock),
      timestamp: "2026-09-16T00:00:02.000Z",
    });
    assert.equal(first.results[0].status, "supervisor-stopped");
    assert.equal(second.results[0].status, "supervisor-stopped");
    const goal = (await fixture.manifest()).parentGoal;
    assert.equal(goal.status, "review-requested");
    assert.equal(
      goal.signals.filter((signal) => signal.identity.startsWith("parent-goal-mismatch:")).length,
      1,
    );
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("persisted parent questions and approvals mark the goal as user-action-required", async () => {
  const cases = [
    {
      field: "questionRequests",
      request: {
        id: "question-pending-1",
        kind: "question",
        status: "parent-question-required",
        requestedAt: "2026-09-14T00:00:00.000Z",
        question: "Which release channel should I use?",
      },
      expected: /parent question question-pending-1/,
    },
    {
      field: "approvalRequests",
      request: {
        id: "approval-pending-1",
        action: "dispatch",
        status: "parent-approval-required",
        requestedAt: "2026-09-14T00:00:01.000Z",
        request: "Parent approval is required.",
      },
      expected: /parent approval approval-pending-1/,
    },
  ];
  for (const item of cases) {
    const fixture = await createFixture({
      piGoalPauseDetection: false,
      parentGoal: {
        version: 1,
        id: `parent-${item.field}`,
        objective: "Wait for a user decision.",
        status: "review-requested",
        nextAction: "Review the lane breadcrumb.",
        signals: [],
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
      },
      [item.field]: [item.request],
    });
    const herdr = {
      async request(method) {
        assert.equal(method, "pane.report_metadata");
        return { result: {} };
      },
    };
    try {
      await handleHook({
        eventName: "pane.agent_status_changed",
        eventJson: statusEvent("working"),
        stateDir: fixture.stateDir,
        herdr,
      });
      const goal = (await fixture.manifest()).parentGoal;
      assert.equal(goal.status, "action-required");
      assert.match(goal.nextAction, item.expected);
      assert.match(goal.nextAction, /required before/);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("a bootstrapped root supervises its parent manifest before any lane exists", async () => {
  const fixture = await createFixture({
    parentGoal: {
      version: 1,
      id: "parent-bootstrap",
      objective: "Prove root bootstrap.",
      status: "active",
      nextAction: "Wait for a root nudge.",
      signals: [],
      supervisor: {
        version: 1,
        state: "running",
        intervalSeconds: 5,
        nudgeCount: 0,
        nextNudgeAt: "2026-09-14T00:00:00.000Z",
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
      },
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    },
  });
  const configPath = join(fixture.stateDir, "config.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 2,
        owner: "herdr-orchestrator",
        orchestrators: [
          {
            id: "bootstrap-root",
            root: ROOT,
            program: {
              id: fixture.directory,
              workspace_id: ROOT.workspace_id,
              parent_manifest_path: fixture.manifestPath,
            },
            workflows: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  // No lane yet, but a planned workflow is waiting to be dispatched.
  const bootstrapManifest = await fixture.manifest();
  bootstrapManifest.workflows.push({
    id: "herdr-planned",
    status: "planned",
    taskBinding: { workspaceId: ROOT.workspace_id, rootPaneId: ROOT.pane_id, rootSessionPath: "root" },
    lanes: [],
  });
  await writeFile(fixture.manifestPath, JSON.stringify(bootstrapManifest));
  const mock = await startHerdrMock((request) => {
    if (request.method === "agent.get") return rootAgentInfo();
    if (request.method === "agent.prompt") return { result: {} };
    if (request.method === "pane.report_metadata") return { result: {} };
    throw new Error(`Unexpected method: ${request.method}`);
  });
  try {
    const result = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: client(mock),
      timestamp: "2026-09-14T00:00:00.000Z",
    });
    assert.deepEqual(result.results, [
      { manifestPath: fixture.manifestPath, status: "delivered" },
    ]);
    assert.equal(
      (await fixture.manifest()).parentGoal.supervisor.nudgeCount,
      1,
    );
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("the Herdr-owned supervisor nudges a due running parent goal, names why, and repeats each interval", async () => {
  const fixture = await createFixture({
    parentGoal: {
      version: 1,
      id: "parent-bb029",
      objective: "Complete BB-029 safely.",
      status: "active",
      nextAction: "Review the next dependency-ready lane.",
      signals: [],
      supervisor: {
        version: 1,
        state: "running",
        intervalSeconds: 15,
        nudgeCount: 0,
        nextNudgeAt: "2026-09-14T00:00:00.000Z",
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
      },
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    },
  });
  const mock = await startHerdrMock((request) => {
    if (request.method === "agent.get") return rootAgentInfo();
    if (request.method === "pane.report_metadata") return { result: {} };
    if (request.method === "agent.prompt") {
      assert.equal(Object.hasOwn(request.params, "wait"), false);
      assert.match(
        request.params.text,
        /Parent goal parent-bb029 is active and work is waiting on you:\n1\) lane herdr-bb029\/lane-child \(status unknown\) waits on request request-waiting: runtime launch: npm run dev/,
      );
      assert.match(request.params.text, /record a truthful goal state/);
      assert.doesNotMatch(request.params.text, /observational only/);
      assert.doesNotMatch(
        request.params.text,
        /take at most one allowed parent action/,
      );
      return { result: { type: "agent_prompted" } };
    }
    throw new Error(`Unexpected method: ${request.method}`);
  });
  try {
    const first = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: client(mock),
      timestamp: "2026-09-14T00:00:00.000Z",
    });
    assert.deepEqual(first.results, [
      { manifestPath: fixture.manifestPath, status: "delivered" },
    ]);
    const goal = (await fixture.manifest()).parentGoal;
    assert.equal(goal.supervisor.nudgeCount, 1);
    assert.equal(goal.supervisor.lastDelivery.status, "delivered");
    assert.equal(goal.supervisor.nextNudgeAt, "2026-09-14T00:00:15.000Z");
    const second = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: client(mock),
      timestamp: "2026-09-14T00:00:01.000Z",
    });
    assert.equal(second.results[0].status, "not-due");
    assert.equal(requestsFor(mock, "agent.prompt").length, 1);
    const third = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: client(mock),
      timestamp: "2026-09-14T00:00:15.000Z",
    });
    assert.equal(third.results[0].status, "delivered", "repeats one interval later while work waits");
    assert.equal(requestsFor(mock, "agent.prompt").length, 2);
    assert.equal((await fixture.manifest()).parentGoal.supervisor.nudgeCount, 2);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("live root activity can veto delivery even after an authoritative settled transition", async () => {
  const fixture = await createFixture({
    parentGoal: {
      version: 1,
      id: "parent-bb029",
      objective: "Complete BB-029 safely.",
      status: "active",
      nextAction: "Review the next dependency-ready lane.",
      signals: [],
      supervisor: {
        version: 1,
        state: "running",
        intervalSeconds: 5,
        nudgeCount: 0,
        nextNudgeAt: "2026-09-14T00:00:00.000Z",
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
      },
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    },
  });
  let rootStatus = "working";
  const mock = await startHerdrMock((request) => {
    if (request.method === "agent.get") {
      const info = rootAgentInfo();
      info.result.agent.agent_status = rootStatus;
      return info;
    }
    if (request.method === "agent.prompt")
      return { result: { type: "agent_prompted" } };
    if (request.method === "pane.report_metadata") return { result: {} };
    throw new Error(`Unexpected method: ${request.method}`);
  });
  try {
    const deferred = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: client(mock),
      timestamp: "2026-09-14T00:00:00.000Z",
    });
    assert.equal(deferred.results[0].status, "root-not-idle");
    let goal = (await fixture.manifest()).parentGoal;
    assert.deepEqual(goal.supervisor.rootActivity, {
      status: "working",
      observedAt: "2026-09-14T00:00:00.000Z",
    });
    assert.equal(goal.supervisor.nextNudgeAt, "2026-09-14T00:00:05.000Z");
    assert.equal(requestsFor(mock, "agent.prompt").length, 0);

    const rootActivity = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: rootStatusEvent("idle"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.equal(rootActivity.rootActivity[0].status, "recorded");
    assert.deepEqual(
      hookResponse(rootActivity),
      {
        accepted: true,
        rootActivity: rootActivity.rootActivity,
      },
      "a root-activity hook response never reads a lane record identity",
    );
    goal = (await fixture.manifest()).parentGoal;
    assert.equal(goal.supervisor.rootActivity.status, "idle");

    rootStatus = "idle";
    const delivered = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: client(mock),
      timestamp: "2026-09-14T00:00:05.000Z",
    });
    assert.equal(delivered.results[0].status, "delivered");
    assert.equal(requestsFor(mock, "agent.prompt").length, 1);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

function dueParentGoal() {
  const timestamp = "2026-09-14T00:00:00.000Z";
  return {
    version: 1,
    id: "parent-recovery",
    objective: "Recover once.",
    status: "active",
    nextAction: "Perform authorized work.",
    signals: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    supervisor: {
      version: 1,
      state: "running",
      // Longer than the 5 s recovery-tick steps: one nudge per window.
      intervalSeconds: 60,
      nudgeCount: 0,
      nextNudgeAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

async function patchSupervisor(fixture, patch) {
  const manifest = await fixture.manifest();
  Object.assign(manifest.parentGoal.supervisor, patch);
  await writeFile(fixture.manifestPath, JSON.stringify(manifest));
}

// Mirrors the audit's "ambiguous socket delivery" fault probe: the server
// receives the prompt over a real socket but withholds its reply, so the
// client's own timeout fires. Corrected behavior must treat that as durable
// uncertainty, not a retryable non-delivery.
async function startAmbiguousPromptMock() {
  const directory = await mkdtemp(
    join(tmpdir(), "herdr-controller-ambiguous-"),
  );
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\herdr-controller-ambiguous-${basename(directory)}`
      : join(directory, "api.sock");
  let prompts = 0;
  const server = net.createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(input.slice(0, newline));
      if (request.method === "agent.prompt") {
        prompts += 1;
        return;
      }
      socket.end(
        `${JSON.stringify({ id: request.id, ...rootAgentInfo() })}\n`,
      );
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  return {
    socketPath,
    get prompts() {
      return prompts;
    },
    async close() {
      await new Promise((resolveClose) => server.close(resolveClose));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function recoveryApi() {
  const api = {
    prompts: 0,
    gets: 0,
    status: "idle",
    available: true,
    async request(method) {
      if (method === "agent.get") {
        api.gets += 1;
        if (!api.available)
          throw Object.assign(new Error("missing root"), {
            code: "agent_not_found",
          });
        const info = rootAgentInfo().result;
        info.agent.agent_status = api.status;
        return info;
      }
      assert.equal(method, "agent.prompt");
      api.prompts += 1;
      return { type: "agent_prompted" };
    },
  };
  return api;
}

const recoveryTick = (fixture, api, step) =>
  runSupervisorTick({
    stateDir: fixture.stateDir,
    herdr: api,
    timestamp: new Date(
      Date.parse("2026-09-14T00:00:00.000Z") + step * 5000,
    ).toISOString(),
  });

test("missing, active, unknown and mismatched root turns fail closed despite idle snapshots/hooks", async () => {
  const fixture = await createFixture({
    parentGoal: dueParentGoal(),
    settledRoot: false,
  });
  const api = recoveryApi();
  try {
    for (const turn of [
      undefined,
      { state: "active", paneId: ROOT.pane_id, workspaceId: ROOT.workspace_id },
      {
        state: "unknown",
        paneId: ROOT.pane_id,
        workspaceId: ROOT.workspace_id,
      },
      { state: "idle", paneId: "wrong-pane", workspaceId: ROOT.workspace_id },
      { state: "idle", paneId: ROOT.pane_id, workspaceId: "wrong-workspace" },
    ]) {
      if (turn)
        await patchSupervisor(fixture, {
          rootTurn: {
            ...turn,
            runId: "run-1",
            updatedAt: "2026-09-14T00:00:00.000Z",
          },
        });
      for (let step = 0; step < 5; step += 1) {
        await handleHook({
          stateDir: fixture.stateDir,
          herdr: api,
          eventName: "pane.agent_status_changed",
          eventJson: rootStatusEvent("idle"),
        });
        assert.equal(
          (await recoveryTick(fixture, api, step)).results[0].status,
          "root-turn-not-idle",
        );
      }
    }
    assert.equal(api.prompts, 0);
    assert.equal(
      api.gets,
      0,
      "ticks never infer idle by repeatedly reading a busy/missing run",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("concurrent overdue ticks and process-style restarts consume exactly one idle wake per interval", async () => {
  const fixture = await createFixture({ parentGoal: dueParentGoal() });
  const api = recoveryApi();
  try {
    await Promise.all([
      recoveryTick(fixture, api, 0),
      recoveryTick(fixture, api, 0),
    ]);
    for (let step = 1; step < 8; step += 1)
      await recoveryTick(fixture, api, step);
    assert.equal(api.prompts, 1);
    assert.equal(
      (await fixture.manifest()).parentGoal.supervisor.nudgeCount,
      1,
    );
    assert.equal(
      (await fixture.manifest()).parentGoal.supervisor.nextNudgeAt,
      "2026-09-14T00:01:00.000Z",
      "the next nudge waits one full interval",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a settled but unseen done root gets one wake without requiring user focus", async () => {
  const fixture = await createFixture({ parentGoal: dueParentGoal() });
  const api = recoveryApi();
  api.status = "done";
  try {
    assert.equal(
      (await recoveryTick(fixture, api, 0)).results[0].status,
      "delivered",
    );
    await recoveryTick(fixture, api, 1);
    assert.equal(api.prompts, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("delivered/uncertain and interrupted sending receipts are never followed within one interval", async () => {
  for (const status of ["delivered", "uncertain", "sending"]) {
    const fixture = await createFixture({ parentGoal: dueParentGoal() });
    const api = recoveryApi();
    try {
      await patchSupervisor(fixture, {
        lastDelivery: { status, attemptedAt: "2026-09-14T00:00:00.000Z" },
      });
      for (let step = 0; step < 6; step += 1)
        await recoveryTick(fixture, api, step);
      assert.equal(api.prompts, 0, status);
      const control = (await fixture.manifest()).parentGoal.supervisor;
      assert.equal(
        control.lastDelivery.status,
        status === "sending" ? "uncertain" : status,
      );
      if (status === "sending") assert.equal(control.nextNudgeAt, "2026-09-14T00:01:00.000Z");
      await recoveryTick(fixture, api, 12);
      assert.equal(api.prompts, 1, `${status}: the next nudge comes one interval later`);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("an unavailable root is retried after an interval and an ambiguous send is never replayed early", async () => {
  const fixture = await createFixture({ parentGoal: dueParentGoal() });
  const api = recoveryApi();
  try {
    api.available = false;
    assert.equal(
      (await recoveryTick(fixture, api, 0)).results[0].status,
      "pending",
    );
    assert.equal(
      (await fixture.manifest()).parentGoal.supervisor.nextNudgeAt,
      "2026-09-14T00:01:00.000Z",
    );
    api.available = true;
    assert.equal((await recoveryTick(fixture, api, 1)).results[0].status, "not-due");
    assert.equal(
      (await recoveryTick(fixture, api, 12)).results[0].status,
      "delivered",
    );
    await recoveryTick(fixture, api, 13);
    assert.equal(api.prompts, 1);
    await patchSupervisor(fixture, {
      lastDelivery: {
        status: "pending",
        attemptedAt: "2026-09-14T00:00:00.000Z",
      },
      nextNudgeAt: "2026-09-14T00:00:00.000Z",
    });
    const ambiguousApi = {
      async request(method, params) {
        if (method === "agent.prompt") {
          api.prompts += 1;
          throw new Error("reply lost after send");
        }
        return api.request(method, params);
      },
    };
    await patchSupervisor(fixture, { nextNudgeAt: "2026-09-14T00:00:00.000Z" });
    assert.equal(
      (await recoveryTick(fixture, ambiguousApi, 24)).results[0].status,
      "uncertain",
    );
    for (let step = 25; step < 30; step += 1)
      await recoveryTick(fixture, ambiguousApi, step);
    assert.equal(
      api.prompts,
      2,
      "an ambiguous accepted send must not be replayed",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a real socket timeout after the supervisor nudge is sent yields one logical prompt, never a retry", async () => {
  const mock = await startAmbiguousPromptMock();
  const fixture = await createFixture({ parentGoal: dueParentGoal() });
  try {
    const herdr = new JsonLineHerdrClient(mock.socketPath, 50);
    const first = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr,
      timestamp: "2026-09-14T00:00:00.000Z",
    });
    assert.equal(first.results[0].status, "uncertain");
    const supervisor = (await fixture.manifest()).parentGoal.supervisor;
    assert.equal(supervisor.lastDelivery.status, "uncertain");
    assert.equal(supervisor.nextNudgeAt, "2026-09-14T00:01:00.000Z");
    const second = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr,
      timestamp: "2026-09-14T00:00:30.000Z",
    });
    assert.equal(second.results[0].status, "not-due");
    assert.equal(
      mock.prompts,
      1,
      "an ambiguous accepted send must not be replayed",
    );
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("a real socket timeout after a lane wake prompt is sent yields one logical delivery, never a duplicate", async () => {
  const mock = await startAmbiguousPromptMock();
  const fixture = await createFixture({});
  try {
    const herdr = new JsonLineHerdrClient(mock.socketPath, 50);
    const first = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("done"),
      stateDir: fixture.stateDir,
      herdr,
    });
    assert.equal(first.record.wake.status, "uncertain");
    const second = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("done"),
      stateDir: fixture.stateDir,
      herdr,
    });
    assert.equal(second.deduplicated, true);
    assert.equal(second.record.wake.status, "uncertain");
    assert.equal(
      mock.prompts,
      1,
      "a lost reply after a real send must not duplicate the wake prompt",
    );
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("live root identity and final pre-send status checks still veto a settled root", async () => {
  for (const mode of ["mismatched", "busy-on-recheck"]) {
    const fixture = await createFixture({ parentGoal: dueParentGoal() });
    let gets = 0;
    let prompts = 0;
    const api = {
      async request(method) {
        if (method === "agent.prompt") {
          prompts += 1;
          return {};
        }
        gets += 1;
        const info = rootAgentInfo().result;
        if (mode === "mismatched") info.agent.pane_id = "wrong-pane";
        else if (gets > 1) info.agent.agent_status = "working";
        return info;
      },
    };
    try {
      assert.equal(
        (await recoveryTick(fixture, api, 0)).results[0].status,
        "pending",
      );
      assert.equal(prompts, 0);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("malformed root-turn and acknowledgement fields fail strict manifest validation", async () => {
  for (const patch of [
    { rootTurn: { state: "idle" } },
    {
      rootTurn: {
        state: "idle",
        runId: "r",
        paneId: ROOT.pane_id,
        workspaceId: ROOT.workspace_id,
        updatedAt: "invalid",
      },
    },
    {
      lastDelivery: {
        status: "delivered",
        attemptedAt: "now",
        acknowledgedAt: 7,
      },
    },
  ]) {
    const fixture = await createFixture({ parentGoal: dueParentGoal() });
    const api = recoveryApi();
    try {
      await patchSupervisor(fixture, patch);
      const before = await readFile(fixture.manifestPath, "utf8");
      // Fail closed for this manifest only: skipped with the reason, never
      // prompted, never rewritten.
      const result = await recoveryTick(fixture, api, 0);
      assert.equal(result.results[0].status, "skipped");
      assert.match(result.results[0].error, /rootTurn|acknowledgedAt/);
      assert.equal(api.prompts, 0);
      assert.equal(await readFile(fixture.manifestPath, "utf8"), before);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("the supervisor lease allows only one process loop and releases for restart", async () => {
  const fixture = await createFixture();
  try {
    const first = await runSupervisorLoop({
      stateDir: fixture.stateDir,
      configDir: fixture.stateDir,
    });
    assert.equal(first.started, true);
    const duplicate = await runSupervisorLoop({
      stateDir: fixture.stateDir,
      configDir: fixture.stateDir,
    });
    assert.deepEqual(
      { started: duplicate.started, reason: duplicate.reason },
      { started: false, reason: "supervisor_already_running" },
      "a plugin restart must not create a second supervisor loop",
    );
    await first.stop();
    const restarted = await runSupervisorLoop({
      stateDir: fixture.stateDir,
      configDir: fixture.stateDir,
    });
    assert.equal(restarted.started, true, "a stopped supervisor can restart");
    await restarted.stop();
  } finally {
    await fixture.cleanup();
  }
});

test("separate startup state directories still admit one live supervisor", async () => {
  const fixture = await createFixture();
  const secondStateDir = join(fixture.directory, "state-second");
  await mkdir(secondStateDir, { mode: 0o700 });
  try {
    const first = await runSupervisorLoop({
      stateDir: fixture.stateDir,
      configDir: fixture.stateDir,
    });
    assert.equal(first.started, true);
    const duplicate = await runSupervisorLoop({
      stateDir: secondStateDir,
      configDir: fixture.stateDir,
    });
    assert.deepEqual(
      { started: duplicate.started, reason: duplicate.reason },
      { started: false, reason: "supervisor_already_running" },
      "per-invocation state directories must share the plugin-config lease",
    );
    await first.stop();
    const restarted = await runSupervisorLoop({
      stateDir: secondStateDir,
      configDir: fixture.stateDir,
    });
    assert.equal(restarted.started, true);
    await restarted.stop();
  } finally {
    await fixture.cleanup();
  }
});

test(
  "stopping keeps the supervisor lease through an in-flight tick",
  async () => {
    const fixture = await createFixture({
      parentGoal: {
        version: 1,
        id: "parent-bb029",
        objective: "Complete BB-029 safely.",
        status: "active",
        nextAction: "Review the next dependency-ready lane.",
        signals: [],
        supervisor: {
          version: 1,
          state: "running",
          intervalSeconds: 15,
          nudgeCount: 0,
          nextNudgeAt: new Date(Date.now() - 1_000).toISOString(),
          createdAt: "2026-09-14T00:00:00.000Z",
          updatedAt: "2026-09-14T00:00:00.000Z",
        },
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
      },
    });
    let allowGet;
    const getStarted = new Promise((resolveGetStarted) => {
      allowGet = resolveGetStarted;
    });
    let releaseGet;
    const getMayFinish = new Promise((resolveGetMayFinish) => {
      releaseGet = resolveGetMayFinish;
    });
    const herdr = {
      async request(method) {
        if (method === "agent.get") {
          allowGet();
          await getMayFinish;
          return rootAgentInfo().result;
        }
        if (method === "agent.prompt") return { type: "agent_prompted" };
        throw new Error(`Unexpected method: ${method}`);
      },
    };
    try {
      const first = await runSupervisorLoop({
        stateDir: fixture.stateDir,
        configDir: fixture.stateDir,
        herdr,
      });
      await getStarted;
      const stopping = first.stop();
      const duplicate = await runSupervisorLoop({
        stateDir: fixture.stateDir,
        configDir: fixture.stateDir,
        herdr,
      });
      assert.equal(
        duplicate.started,
        false,
        "restart cannot overlap an in-flight tick",
      );
      releaseGet();
      await stopping;
      const restarted = await runSupervisorLoop({
        stateDir: fixture.stateDir,
        configDir: fixture.stateDir,
        herdr,
      });
      assert.equal(
        restarted.started,
        true,
        "lease releases only after the tick settles",
      );
      await restarted.stop();
    } finally {
      await fixture.cleanup();
    }
  },
  { timeout: 25_000 },
);

test("the supervisor waits one normal interval after startup before nudging restored panes", async () => {
  const fixture = await createFixture({
    parentGoal: {
      version: 1,
      id: "parent-bb029",
      objective: "Complete BB-029 safely.",
      status: "active",
      nextAction: "Review the next dependency-ready lane.",
      signals: [],
      supervisor: {
        version: 1,
        state: "running",
        intervalSeconds: 15,
        nudgeCount: 0,
        nextNudgeAt: "2026-09-14T00:00:00.000Z",
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
      },
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    },
  });
  let calls = 0;
  try {
    const loop = await runSupervisorLoop({
      stateDir: fixture.stateDir,
      configDir: fixture.stateDir,
      herdr: {
        async request() {
          calls += 1;
          throw new Error("must not run at startup");
        },
      },
    });
    assert.equal(loop.started, true);
    assert.equal(calls, 0, "startup grants Herdr one full settle interval");
    await loop.stop();
  } finally {
    await fixture.cleanup();
  }
});

test("a long-working lane gets no stall signal, root wake, or lane prompt", async () => {
  const fixture = await createFixture({
    piGoalPauseDetection: false,
    parentGoal: {
      version: 1,
      id: "parent-long-turn",
      objective: "Let a slow lane work.",
      status: "active",
      nextAction: "Continue the lane.",
      signals: [],
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    },
  });
  await seedWorkingTransition(fixture, "2026-09-14T00:00:00.000Z");
  const prompts = [];
  const lanePrompts = [];
  const api = rootWakeApi(prompts, undefined, lanePrompts);
  try {
    for (const timestamp of ["2026-09-14T00:06:00.000Z", "2026-09-14T02:00:00.000Z"]) {
      const tick = await runSupervisorTick({ stateDir: fixture.stateDir, herdr: api, timestamp });
      assert.deepEqual(tick.pendingWakes, []);
    }
    const manifest = await fixture.manifest();
    assert.equal(
      manifest.workflows[0].eventController.events.some(
        (event) => event.classification === "stall-suspected",
      ),
      false,
    );
    assert.equal(prompts.length, 0, "a working lane never wakes the root on a timer");
    assert.equal(lanePrompts.length, 0, "a working lane is never interrupted on a timer");
    assert.equal(manifest.parentGoal.status, "active");
  } finally {
    await fixture.cleanup();
  }
});

function statusGoal(status) {
  return {
    version: 1,
    id: "parent-bb029",
    objective: "Complete BB-029 safely.",
    status,
    nextAction: "Wait.",
    signals: [],
    supervisor: {
      version: 1,
      state: status === "paused" ? "paused" : "running",
      intervalSeconds: 15,
      nudgeCount: 0,
      nextNudgeAt: "2026-09-14T00:00:00.000Z",
      ...(status === "paused" ? { pauseReason: "Waiting for Zach." } : {}),
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    },
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
  };
}

const pendingQuestion = [{
  id: "question-for-zach",
  kind: "question",
  status: "parent-question-required",
  requestedAt: "2026-09-14T00:00:00.000Z",
  question: "Which tenant should D19 use?",
}];

for (const [label, status, options, expected] of [
  ["active with waiting work", "active", {}, "delivered"],
  ["waiting-for-event with waiting work", "waiting-for-event", {}, "delivered"],
  ["review-requested with waiting work", "review-requested", {}, "delivered"],
  ["blocked with nothing pending for Zach", "blocked", {}, "delivered"],
  ["action-required with nothing pending for Zach", "action-required", {}, "delivered"],
  ["action-required while Zach owes an answer", "action-required", { questionRequests: pendingQuestion }, "quiet:awaiting-user"],
  ["blocked even with a pending question when work waits", "blocked", { questionRequests: pendingQuestion }, "delivered"],
  ["completed", "completed", {}, "quiet:goal-completed"],
  ["paused", "paused", {}, "not-running"],
  ["waiting-for-event with no actionable work", "waiting-for-event", { laneRequests: [] }, "quiet:no-actionable-work"],
]) {
  test(`supervisor nudge rule: ${label} -> ${expected}`, async () => {
    const fixture = await createFixture({ parentGoal: statusGoal(status), ...options });
    const api = recoveryApi();
    try {
      const result = await runSupervisorTick({
        stateDir: fixture.stateDir,
        herdr: api,
        timestamp: "2026-09-14T00:00:00.000Z",
      });
      const [kind, reason] = expected.split(":");
      assert.equal(result.results[0].status, kind);
      if (reason) assert.equal(result.results[0].reason, reason);
      assert.equal(api.prompts, kind === "delivered" ? 1 : 0);
      const goal = (await fixture.manifest()).parentGoal;
      assert.equal(goal.status, status, "a tick never rewrites the goal's lifecycle state");
    } finally {
      await fixture.cleanup();
    }
  });
}

test("a nudge names each waiting item: lane requests, lease asks, unread messages, plans, queue and directives", async () => {
  const fixture = await createFixture({
    parentGoal: statusGoal("waiting-for-event"),
    laneRequests: [
      { id: "request-lease", workflowId: "herdr-bb029", laneId: CHILD.lane_id, kind: "lease", payload: { resource: "app" }, summary: "lease app", status: "open", requestedAt: "t", delivery: { status: "delivered", updatedAt: "t" } },
    ],
    messageRequests: [
      { ...pendingMessage("message-uncertain", "Port 3610 busy.", "2026-09-13T23:00:00.000Z"), delivery: { status: "uncertain", attempts: 1, updatedAt: "2026-09-13T23:00:01.000Z" } },
    ],
  });
  const manifest = await fixture.manifest();
  manifest.workflows.push({ id: "herdr-next", status: "planned", taskBinding: { workspaceId: ROOT.workspace_id, rootPaneId: ROOT.pane_id, rootSessionPath: "root" }, lanes: [] });
  const config = validateConfig(JSON.parse(await readFile(join(fixture.stateDir, "config.json"), "utf8")));
  manifest.directives = [{ id: "directive-sweep", rootId: config.orchestrators[0].id, from: "zach", text: "Sweep finished lanes.", createdAt: "t", status: "open", sends: 1, sentAt: "2026-09-14T00:00:00.000Z", delivery: { status: "delivered", attempts: 1, updatedAt: "t" } }];
  await writeFile(fixture.manifestPath, JSON.stringify(manifest));
  const texts = [];
  const api = recoveryApi();
  const capture = {
    async request(method, params) {
      if (method === "agent.prompt") texts.push(params.text);
      return api.request(method, params);
    },
  };
  try {
    await runSupervisorTick({ stateDir: fixture.stateDir, herdr: capture, timestamp: "2026-09-14T00:00:00.000Z" });
    const nudge = texts.find((text) => text.startsWith("[Baa-ton supervisor]"));
    assert.ok(nudge);
    assert.match(nudge, /is waiting-for-event and work is waiting on you/);
    assert.match(nudge, /lane herdr-bb029\/lane-child \(status unknown\) waits on lease ask request-lease: lease app/);
    assert.match(nudge, /child message message-uncertain from herdr-bb029\/lane-child is possibly unseen: Port 3610 busy\./);
    assert.match(nudge, /workflow herdr-next is planned but not dispatched/);
    assert.match(nudge, /directive directive-sweep from zach is open: Sweep finished lanes\./);
    assert.doesNotMatch(nudge, /observational only/);
  } finally {
    await fixture.cleanup();
  }
});

test("a lane that is working on its own request does not count as waiting", async () => {
  const fixture = await createFixture({ parentGoal: statusGoal("active") });
  const manifest = await fixture.manifest();
  manifest.workflows[0].eventController = { version: 1, events: [{ identity: "e1", received_at: "2026-09-14T00:00:00.000Z", workflow_id: "herdr-bb029", lane_id: CHILD.lane_id, pane_id: CHILD.pane_id, classification: "unclassified", source: { agent_status: "working" }, wake: { status: "not-required", attempts: 0, updated_at: "t" } }] };
  await writeFile(fixture.manifestPath, JSON.stringify(manifest));
  const api = recoveryApi();
  try {
    const result = await runSupervisorTick({ stateDir: fixture.stateDir, herdr: api, timestamp: "2026-09-14T00:00:00.000Z" });
    assert.deepEqual([result.results[0].status, result.results[0].reason], ["quiet", "no-actionable-work"]);
    assert.equal(api.prompts, 0);
  } finally {
    await fixture.cleanup();
  }
});

async function markChosenInterval(fixture) {
  const config = validateConfig(JSON.parse(await readFile(join(fixture.stateDir, "config.json"), "utf8")));
  const manifest = await fixture.manifest();
  manifest.rootSupervision = [{ rootId: config.orchestrators[0].id, alerts: [], nudgeIntervalPolicy: 2 }];
  await writeFile(fixture.manifestPath, JSON.stringify(manifest));
}

const longGoal = (extra = {}) => ({
  ...statusGoal("active"),
  supervisor: { ...statusGoal("active").supervisor, intervalSeconds: 1200, nextNudgeAt: "2026-09-14T00:20:00.000Z", ...extra },
});

test("a pre-repeat goal with a long interval is capped to 300 s once; a chosen interval is kept", async () => {
  const legacy = await createFixture({ parentGoal: longGoal() });
  const chosen = await createFixture({ parentGoal: longGoal() });
  await markChosenInterval(chosen);
  const api = recoveryApi();
  try {
    await runSupervisorTick({ stateDir: legacy.stateDir, herdr: api, timestamp: "2026-09-14T00:00:00.000Z" });
    await runSupervisorTick({ stateDir: chosen.stateDir, herdr: api, timestamp: "2026-09-14T00:00:00.000Z" });
    const legacyManifest = await legacy.manifest();
    assert.deepEqual(
      [legacyManifest.parentGoal.supervisor.intervalSeconds, legacyManifest.parentGoal.supervisor.nextNudgeAt],
      [300, "2026-09-14T00:05:00.000Z"],
    );
    assert.equal(legacyManifest.rootSupervision[0].nudgeIntervalPolicy, 2, "the marker lives in rootSupervision");
    assert.equal("intervalPolicy" in legacyManifest.parentGoal.supervisor, false);
    const chosenControl = (await chosen.manifest()).parentGoal.supervisor;
    assert.deepEqual([chosenControl.intervalSeconds, chosenControl.nextNudgeAt], [1200, "2026-09-14T00:20:00.000Z"]);
  } finally {
    await legacy.cleanup();
    await chosen.cleanup();
  }
});

test("a goal written by #28 loses supervisor.intervalPolicy and keeps its chosen interval", async () => {
  const fixture = await createFixture({ parentGoal: longGoal({ intervalPolicy: 2 }) });
  const manifest = await fixture.manifest();
  // #28 also wrote the key into the per-root store and goal history copies.
  manifest.parentGoals = { "root-x": { ...structuredClone(manifest.parentGoal), rootId: "root-x", root: ROOT } };
  manifest.goalHistory = [{ goal: structuredClone(manifest.parentGoal), archivedAt: "t" }];
  await writeFile(fixture.manifestPath, JSON.stringify(manifest));
  const api = recoveryApi();
  try {
    await runSupervisorTick({ stateDir: fixture.stateDir, herdr: api, timestamp: "2026-09-14T00:00:00.000Z" });
    const stored = await fixture.manifest();
    assert.equal(JSON.stringify(stored).includes("intervalPolicy"), false, "no copy keeps the key");
    assert.equal(stored.parentGoal.supervisor.intervalSeconds, 1200, "the marker moved, so the interval is kept");
    assert.equal(stored.rootSupervision[0].nudgeIntervalPolicy, 2);
    assert.doesNotThrow(() => validateParentGoal974a77d(stored.parentGoal));
  } finally {
    await fixture.cleanup();
  }
});

test("forward compatibility: goals written by current code pass the 974a77d strict validators", async () => {
  // Lanes dispatched before an upgrade run bridges loaded from older code,
  // whose controller validates every parent goal with a strict key allowlist
  // (test/fixtures/controller-974a77d-goal-validation.mjs). Exercise every
  // current writer that touches parent goals, then validate each copy.
  const fixture = await createFixture({
    parentGoal: statusGoal("waiting-for-event"),
    messageRequests: [pendingMessage("message-compat", "Ready for review.", "2026-09-14T00:00:00.000Z")],
  });
  const config = validateConfig(JSON.parse(await readFile(join(fixture.stateDir, "config.json"), "utf8")));
  await postDirective({ manifestPath: fixture.manifestPath, rootId: config.orchestrators[0].id, from: "zach", text: "Sweep.", timestamp: "2026-09-14T00:00:00.000Z" });
  const manifest = await fixture.manifest();
  manifest.rootSupervision = [{
    rootId: config.orchestrators[0].id,
    alerts: [],
    capacityGate: { id: "capacity-1", status: "waiting", reason: "r", minFreeMemoryGb: 1, createdAt: "2026-09-14T00:00:00.000Z" },
  }];
  await writeFile(fixture.manifestPath, JSON.stringify(manifest));
  const api = recoveryApi();
  // Check after every write: a key written late in one tick and stripped
  // early in the next is exactly what an old lane reads in between.
  const assertReadableByOldBridges = async (step) => {
    const stored = await fixture.manifest();
    const goals = [stored.parentGoal, ...Object.values(stored.parentGoals ?? {})].filter(Boolean);
    assert.ok(goals.length > 0);
    for (const goal of goals)
      assert.doesNotThrow(() => validateParentGoal974a77d(goal), `after ${step}`);
  };
  try {
    for (const second of [0, 5, 10, 40 * 60]) {
      await runSupervisorTick({
        stateDir: fixture.stateDir,
        herdr: api,
        notify: async () => ({ status: "sent" }),
        sample: async () => ({ freeMemoryGb: 2, swapUsedGb: 0, load1PerCpu: 0.1 }),
        topUsers: async () => [],
        timestamp: new Date(Date.parse("2026-09-14T00:00:00.000Z") + second * 1000).toISOString(),
      });
      await assertReadableByOldBridges(`tick +${second}s`);
    }
    await routeChildMessage({
      configDir: fixture.stateDir,
      workflowId: "herdr-bb029",
      laneId: CHILD.lane_id,
      messageId: "message-compat",
      herdr: api,
    }).catch(() => {});
    await assertReadableByOldBridges("child message routing");
    assert.ok(api.prompts > 0, "the scenario really exercised the supervisor writers");
  } finally {
    await fixture.cleanup();
  }
});

test("an unavailable root leaves a durable pending event that an identical hook may deliver later", async () => {
  const fixture = await createFixture();
  let rootAvailable = false;
  const mock = await startHerdrMock((request) => {
    if (request.method === "agent.get")
      return rootAvailable
        ? rootAgentInfo()
        : { error: { code: "agent_not_found", message: "root is gone" } };
    if (request.method === "agent.prompt")
      return {
        result: { type: "agent_prompted", agent: { name: ROOT.target } },
      };
    throw new Error(`Unexpected method: ${request.method}`);
  });
  try {
    const pending = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("blocked"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.equal(pending.record.wake.status, "pending");
    assert.equal(requestsFor(mock, "agent.prompt").length, 0);
    let manifest = await fixture.manifest();
    let events = manifest.workflows[0].eventController.events;
    assert.equal(events.length, 1);
    assert.equal(events[0].classification, "blocked");
    assert.match(events[0].wake.reason, /root_unavailable/);

    rootAvailable = true;
    const delivered = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("blocked"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.equal(delivered.deduplicated, true);
    assert.equal(delivered.record.wake.status, "delivered");
    assert.equal(requestsFor(mock, "agent.prompt").length, 1);
    manifest = await fixture.manifest();
    events = manifest.workflows[0].eventController.events;
    assert.equal(
      events.length,
      1,
      "a retry updates the existing durable event record",
    );
    // A deferral is not a send attempt; only the delivered digest counts.
    assert.equal(events[0].wake.attempts, 1);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("a supervisor tick drains a pending lane wake once the root is ready, even while the goal requests review", async () => {
  const fixture = await createFixture({ parentGoal: dueParentGoal() });
  let rootAvailable = false;
  const mock = await startHerdrMock((request) => {
    if (request.method === "agent.get")
      return rootAvailable
        ? rootAgentInfo()
        : { error: { code: "agent_not_found", message: "root is gone" } };
    if (request.method === "agent.prompt")
      return {
        result: { type: "agent_prompted", agent: { name: ROOT.target } },
      };
    if (request.method === "pane.report_metadata") return { result: {} };
    throw new Error(`Unexpected method: ${request.method}`);
  });
  try {
    const pending = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("blocked"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.equal(pending.record.wake.status, "pending");
    const afterHook = (await fixture.manifest()).parentGoal;
    assert.equal(
      afterHook.status,
      "review-requested",
      "an undelivered actionable event records a review request",
    );

    rootAvailable = true;
    // No new hook recurs for this pane; only the root becoming ready again
    // and a routine tick should be needed to recover the pending wake. The
    // digest is this tick's wake, so the supervisor does not also nudge.
    const tick = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: client(mock),
      timestamp: "2026-09-14T00:05:00.000Z",
    });
    assert.equal(tick.results[0].status, "digest-delivered");
    assert.deepEqual(tick.pendingWakes, [
      {
        manifestPath: fixture.manifestPath,
        kind: "digest",
        status: "delivered",
        count: 1,
        reason: "agent_prompt_accepted",
      },
    ]);
    assert.equal(requestsFor(mock, "agent.prompt").length, 1);
    assert.match(
      requestsFor(mock, "agent.prompt")[0].params.text,
      /^\[Baa-ton digest\] 1 update since your last turn:\n1\. blocked: herdr-bb029\/lane-child/,
    );
    const manifest = await fixture.manifest();
    const events = manifest.workflows[0].eventController.events;
    assert.equal(events.length, 1);
    assert.equal(events[0].wake.status, "delivered");
    assert.equal(events[0].wake.attempts, 1);

    // A second tick must not redeliver an already-drained wake. (It may
    // send a supervisor nudge: the fixture's open lane request still waits.)
    await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: client(mock),
      timestamp: "2026-09-14T00:10:00.000Z",
    });
    assert.equal(
      requestsFor(mock, "agent.prompt").filter((request) => request.params.text.startsWith("[Baa-ton digest]")).length,
      1,
    );
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("a non-Pi named root receives done and blocked wakes without Pi semantics", async () => {
  const root = {
    target: "codex-review-root",
    target_kind: "name",
    agent_kind: "codex",
    pane_id: "w-codex-root:p1",
    workspace_id: "w-codex-root",
  };
  const child = {
    lane_id: "lane-claude-review",
    target: "claude-review-worker",
    target_kind: "name",
    pane_id: "w-claude-child:p1",
    workspace_id: "w-claude-child",
  };
  const fixture = await createFixture({
    root,
    child,
    piGoalPauseDetection: false,
  });
  const mock = await startHerdrMock((request) => {
    if (request.method === "agent.get") {
      assert.equal(request.params.target, root.target);
      return {
        result: {
          type: "agent_info",
          agent: {
            agent: root.agent_kind,
            name: root.target,
            pane_id: root.pane_id,
            workspace_id: root.workspace_id,
            agent_status: "idle",
          },
        },
      };
    }
    if (request.method === "agent.prompt") {
      assert.equal(request.params.target, root.target);
      assert.equal(Object.hasOwn(request.params, "wait"), false);
      return {
        result: { type: "agent_prompted", agent: { name: root.target } },
      };
    }
    throw new Error(`Non-Pi state hooks must not call ${request.method}`);
  });
  const eventFor = (agent_status) => ({
    event: "pane_agent_status_changed",
    data: {
      type: "pane_agent_status_changed",
      pane_id: child.pane_id,
      workspace_id: child.workspace_id,
      agent_status,
      agent: "claude",
    },
  });
  try {
    await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: eventFor("done"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: eventFor("blocked"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    const working = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: eventFor("working"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.equal(working.record.classification, "unclassified");
    assert.equal(working.record.wake.status, "not-required");
    assert.deepEqual(
      requestsFor(mock, "agent.prompt").map((request) => request.params.target),
      [root.target, root.target],
    );
    assert.equal(requestsFor(mock, "agent.read").length, 0);
    const events = (await fixture.manifest()).workflows[0].eventController
      .events;
    assert.deepEqual(
      events.map((event) => event.classification),
      ["done", "blocked", "unclassified"],
    );
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("a documented pane-ID root target is accepted without an agent name", async () => {
  const root = {
    target: "w-pane-root:p1",
    target_kind: "pane_id",
    agent_kind: "pi",
    pane_id: "w-pane-root:p1",
    workspace_id: "w-pane-root",
  };
  const child = {
    lane_id: "lane-pane-child",
    target: "w-pane-child:p1",
    target_kind: "pane_id",
    pane_id: "w-pane-child:p1",
    workspace_id: "w-pane-child",
  };
  const fixture = await createFixture({ root, child });
  const mock = await startHerdrMock((request) => {
    if (request.method === "agent.get") {
      assert.equal(request.params.target, root.pane_id);
      return {
        result: {
          type: "agent_info",
          agent: {
            agent: "pi",
            name: null,
            pane_id: root.pane_id,
            workspace_id: root.workspace_id,
            agent_status: "idle",
          },
        },
      };
    }
    if (request.method === "agent.prompt") {
      assert.equal(request.params.target, root.pane_id);
      assert.equal(Object.hasOwn(request.params, "wait"), false);
      return { result: { type: "agent_prompted", agent: { name: null } } };
    }
    throw new Error(`Unexpected method: ${request.method}`);
  });
  try {
    const result = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: {
        event: "pane_agent_status_changed",
        data: {
          type: "pane_agent_status_changed",
          pane_id: child.pane_id,
          workspace_id: child.workspace_id,
          agent_status: "done",
          agent: "pi",
        },
      },
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.equal(result.record.wake.status, "delivered");
    assert.equal(result.record.agent_target, child.target);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("shared manifests isolate routed completion signals, mismatch checks, and supervisor nudges per root", async () => {
  const fixture = await createFixture({ piGoalPauseDetection: false });
  const rootB = {
    target: "root-b",
    target_kind: "name",
    agent_kind: "pi",
    pane_id: "w-b:p1",
    workspace_id: "w-b",
  };
  const childB = {
    lane_id: "lane-b",
    target: "child-b",
    target_kind: "name",
    pane_id: "w-b-child:p1",
    workspace_id: "w-b-child",
  };
  const timestamp = "2026-09-16T00:00:00.000Z";
  const goal = (id) => ({
    version: 1,
    id,
    objective: id,
    status: "active",
    nextAction: "Continue.",
    signals: [],
    supervisor: {
      version: 1,
      state: "running",
      intervalSeconds: 5,
      nudgeCount: 0,
      nextNudgeAt: timestamp,
      rootTurn: {
        state: "idle",
        runId: `${id}-run`,
        paneId: id === "parent-a" ? ROOT.pane_id : rootB.pane_id,
        workspaceId: id === "parent-a" ? ROOT.workspace_id : rootB.workspace_id,
        updatedAt: timestamp,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const prompts = [];
  const configPath = join(fixture.stateDir, "config.json");
  try {
    const manifest = await fixture.manifest();
    manifest.parentGoals = {
      "root-a": goal("parent-a"),
      "root-b": goal("parent-b"),
    };
    manifest.workflows.push({
      id: "herdr-b",
      status: "running",
      outcome: "running",
      ownership: { createdBy: "herdr-orchestrator", workspaceId: rootB.workspace_id },
      lanes: [{ id: childB.lane_id, paneId: childB.pane_id, agentName: childB.target }],
    });
    manifest.workflows[0].status = "running";
    manifest.workflows[0].outcome = "running";
    await writeFile(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: 2,
          owner: "herdr-orchestrator",
          orchestrators: [
            {
              id: "root-a",
              root: ROOT,
              program: { id: "program-a", workspace_id: ROOT.workspace_id },
              workflows: [
                {
                  workflow_id: "herdr-bb029",
                  manifest_path: fixture.manifestPath,
                  pi_goal_pause_detection: false,
                  lanes: [CHILD],
                },
              ],
            },
            {
              id: "root-b",
              root: rootB,
              program: { id: "program-b", workspace_id: rootB.workspace_id },
              workflows: [
                {
                  workflow_id: "herdr-b",
                  manifest_path: fixture.manifestPath,
                  pi_goal_pause_detection: false,
                  lanes: [childB],
                },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    const herdr = {
      async request(method, params = {}) {
        if (method === "pane.report_metadata") return { result: {} };
        if (method === "agent.get") {
          const root = params.target === ROOT.target ? ROOT : rootB;
          return {
            type: "agent_info",
            agent: {
              agent: root.agent_kind,
              name: root.target,
              pane_id: root.pane_id,
              workspace_id: root.workspace_id,
              agent_status: "idle",
            },
          };
        }
        if (method === "agent.prompt") {
          prompts.push(params);
          return { result: { type: "agent_prompted" } };
        }
        throw new Error(`Unexpected ${method}`);
      },
    };

    const first = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("done"),
      stateDir: fixture.stateDir,
      herdr,
    });
    assert.equal(first.record.wake.status, "delivered");
    let after = await fixture.manifest();
    assert.equal(after.parentGoals["root-a"].signals.length, 1);
    assert.equal(after.parentGoals["root-b"].signals.length, 0);
    assert.deepEqual(prompts.map((item) => item.target), [ROOT.target]);

    const second = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("done", "pi", childB),
      stateDir: fixture.stateDir,
      herdr,
    });
    assert.equal(second.record.wake.status, "delivered");
    after = await fixture.manifest();
    assert.equal(after.parentGoals["root-a"].signals.length, 1);
    assert.equal(after.parentGoals["root-b"].signals.length, 1);
    assert.deepEqual(
      prompts.slice(0, 2).map((item) => item.target),
      [ROOT.target, rootB.target],
      "each completion wakes only its mapped root",
    );

    // Both routed workflows are active while each root's own goal is terminal.
    // The mismatch signal must be additive to that root's goal only.
    after.parentGoals["root-a"].status = "completed";
    after.parentGoals["root-b"].status = "blocked";
    after.parentGoals["root-a"].signals = [];
    after.parentGoals["root-b"].signals = [];
    await writeFile(fixture.manifestPath, `${JSON.stringify(after, null, 2)}\n`);
    await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr,
      timestamp: "2026-09-16T00:00:01.000Z",
    });
    after = await fixture.manifest();
    assert.equal(after.parentGoals["root-a"].signals.length, 1);
    assert.equal(after.parentGoals["root-b"].signals.length, 1);
    assert.match(after.parentGoals["root-a"].nextAction, /herdr_goal action=reset/);
    assert.match(after.parentGoals["root-b"].nextAction, /herdr_goal action=reset/);

    // Re-arm independent supervisors and verify each due nudge is delivered to
    // its own root, not to the root that happened to be processed first.
    // Each root has one waiting request in its own workflow.
    for (const [workflowId, laneId] of [["herdr-bb029", CHILD.lane_id], ["herdr-b", childB.lane_id]])
      after.workflows.find((workflow) => workflow.id === workflowId).laneRequests = [{
        id: `request-${workflowId}`, workflowId, laneId, kind: "approval", payload: { text: "ok?" },
        summary: "approval: ok?", status: "open", requestedAt: timestamp,
        delivery: { status: "delivered", attempts: 1, updatedAt: timestamp },
      }];
    for (const [key, root] of [["root-a", ROOT], ["root-b", rootB]]) {
      const scopedGoal = after.parentGoals[key];
      scopedGoal.status = "active";
      scopedGoal.signals = [];
      scopedGoal.supervisor.nextNudgeAt = timestamp;
      scopedGoal.supervisor.lastDelivery = undefined;
      scopedGoal.supervisor.rootTurn = {
        ...scopedGoal.supervisor.rootTurn,
        state: "idle",
        paneId: root.pane_id,
        workspaceId: root.workspace_id,
      };
    }
    await writeFile(fixture.manifestPath, `${JSON.stringify(after, null, 2)}\n`);
    const beforeNudges = prompts.length;
    const tick = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr,
      timestamp: "2026-09-16T00:00:02.000Z",
    });
    assert.deepEqual(
      tick.results.map((result) => result.status),
      ["delivered", "delivered"],
    );
    assert.deepEqual(
      prompts.slice(beforeNudges).map((item) => item.target),
      [ROOT.target, rootB.target],
      "supervisor nudges remain root-scoped",
    );
    after = await fixture.manifest();
    assert.equal(after.parentGoals["root-a"].supervisor.nudgeCount, 1);
    assert.equal(after.parentGoals["root-b"].supervisor.nudgeCount, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("supported working and idle status hooks classify an opt-in paused Pi goal", async () => {
  const fixture = await createFixture();
  const mock = await startHerdrMock((request) => {
    if (request.method === "agent.read") {
      assert.equal(request.params.target, CHILD.target);
      assert.equal(request.params.source, "recent_unwrapped");
      assert.equal(request.params.lines, 120);
      return {
        result: {
          type: "pane_read",
          read: {
            pane_id: CHILD.pane_id,
            text: "pi-goal-bb029 paused after a parent question; do not continue without /goal-resume.",
          },
        },
      };
    }
    if (request.method === "agent.get") return rootAgentInfo();
    if (request.method === "agent.prompt")
      return {
        result: { type: "agent_prompted", agent: { name: ROOT.target } },
      };
    throw new Error(`Unexpected method: ${request.method}`);
  });
  try {
    const working = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("working"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    const idle = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("idle"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    for (const result of [working, idle]) {
      assert.equal(result.record.classification, "goal-paused");
      assert.deepEqual(result.record.source.goal_ids, ["pi-goal-bb029"]);
      assert.equal(result.record.wake.status, "delivered");
    }
    assert.equal(requestsFor(mock, "agent.read").length, 2);
    assert.deepEqual(
      requestsFor(mock, "agent.prompt").map((request) => request.params.target),
      [ROOT.target, ROOT.target],
    );
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

function digestApi({ rootStatus = () => "idle" } = {}) {
  const prompts = [];
  return {
    prompts,
    async request(method, params = {}) {
      if (method === "pane.report_metadata") return { result: {} };
      if (method === "agent.prompt") {
        prompts.push(params);
        return { result: { type: "agent_prompted" } };
      }
      if (method === "agent.get")
        return {
          type: "agent_info",
          agent: {
            agent: ROOT.agent_kind,
            name: ROOT.target,
            pane_id: ROOT.pane_id,
            workspace_id: ROOT.workspace_id,
            agent_status: rootStatus(),
          },
        };
      throw new Error(`Unexpected Herdr method ${method}`);
    },
  };
}

function pendingMessage(id, summary, requestedAt) {
  return {
    version: 1,
    id,
    workflowId: "herdr-bb029",
    laneId: CHILD.lane_id,
    summary,
    kind: "informational",
    requestedAt,
    delivery: { status: "pending", attempts: 0, updatedAt: requestedAt },
  };
}

function rootTurn(state) {
  return {
    state,
    runId: `run-${state}`,
    paneId: ROOT.pane_id,
    workspaceId: ROOT.workspace_id,
    updatedAt: "2026-09-14T00:00:00.000Z",
  };
}

test("a busy root collects lane events and child messages into one digest when its turn settles", async () => {
  const messageRequests = [
    pendingMessage("message-progress", "Typecheck clean, starting E2E.", "2026-09-14T00:01:00.000Z"),
    pendingMessage("message-port", "Need a second DB for the fixture.", "2026-09-14T00:02:00.000Z"),
  ];
  const fixture = await createFixture({ parentGoal: dueParentGoal(), messageRequests });
  await patchSupervisor(fixture, { rootTurn: rootTurn("active") });
  const api = digestApi();
  try {
    const blocked = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("blocked"),
      stateDir: fixture.stateDir,
      herdr: api,
    });
    assert.equal(blocked.digest.status, "deferred");
    assert.equal(blocked.digest.reason, "awaiting_root_idle");
    await routeChildMessage({
      configDir: fixture.stateDir,
      workflowId: "herdr-bb029",
      laneId: CHILD.lane_id,
      messageId: "message-progress",
      herdr: api,
    });
    await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("done"),
      stateDir: fixture.stateDir,
      herdr: api,
    });
    const busyTick = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: api,
      timestamp: "2026-09-14T00:03:00.000Z",
    });
    assert.deepEqual(busyTick.pendingWakes, [
      {
        manifestPath: fixture.manifestPath,
        kind: "digest",
        status: "deferred",
        count: 4,
        reason: "awaiting_root_idle",
      },
    ]);
    assert.equal(api.prompts.length, 0, "a working root is never prompted");
    let manifest = await fixture.manifest();
    assert.equal(manifest.parentGoal.status, "review-requested");
    assert.ok(
      manifest.workflows[0].messageRequests.every(
        (request) => request.delivery.status === "pending" && request.delivery.attempts === 0,
      ),
    );

    await patchSupervisor(fixture, { rootTurn: rootTurn("idle") });
    const settledTick = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: api,
      timestamp: "2026-09-14T00:04:00.000Z",
    });
    assert.equal(api.prompts.length, 1, "four updates arrive as one prompt");
    assert.equal(api.prompts[0].target, ROOT.target);
    const text = api.prompts[0].text;
    assert.match(text, /^\[Baa-ton digest\] 4 updates since your last turn:/);
    assert.match(text, /\n1\. blocked: herdr-bb029\/lane-child/);
    assert.match(text, /\n2\. done: herdr-bb029\/lane-child/);
    assert.match(text, /message-progress\): Typecheck clean, starting E2E\./);
    assert.match(text, /message-port\): Need a second DB for the fixture\./);
    assert.doesNotMatch(text, /observational only|do not dispatch/);
    assert.notEqual(
      settledTick.results[0].status,
      "delivered",
      "the supervisor does not also nudge on the tick that sent a digest",
    );
    manifest = await fixture.manifest();
    const actionable = manifest.workflows[0].eventController.events.filter((event) =>
      ["blocked", "done"].includes(event.classification),
    );
    assert.deepEqual(
      actionable.map((event) => [event.wake.status, event.wake.attempts]),
      [["delivered", 1], ["delivered", 1]],
    );
    assert.deepEqual(
      manifest.workflows[0].messageRequests.map((request) => [request.delivery.status, request.delivery.attempts]),
      [["delivered", 1], ["delivered", 1]],
    );

    await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: api,
      timestamp: "2026-09-14T00:05:00.000Z",
    });
    assert.equal(
      api.prompts.filter((prompt) => prompt.text.startsWith("[Baa-ton digest]")).length,
      1,
      "delivered items are never sent again",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a root Herdr reports as working defers the digest even without a turn record", async () => {
  const fixture = await createFixture({
    parentGoal: {
      version: 1,
      id: "parent-no-supervisor",
      objective: "Review lane results.",
      status: "active",
      nextAction: "Wait for lanes.",
      signals: [],
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    },
  });
  let status = "working";
  const api = digestApi({ rootStatus: () => status });
  try {
    const hook = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("done"),
      stateDir: fixture.stateDir,
      herdr: api,
    });
    assert.equal(hook.digest.status, "deferred");
    assert.equal(api.prompts.length, 0);
    status = "done";
    const tick = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: api,
      timestamp: "2026-09-14T00:01:00.000Z",
    });
    assert.equal(tick.pendingWakes[0].status, "delivered");
    assert.equal(api.prompts.length, 1);
    assert.match(api.prompts[0].text, /1 update since your last turn:\n1\. done: herdr-bb029\/lane-child/);
  } finally {
    await fixture.cleanup();
  }
});

test("an interrupted digest becomes uncertain and is never replayed", async () => {
  const messageRequests = [
    pendingMessage("message-interrupted", "Half-sent before a crash.", "2026-09-14T00:01:00.000Z"),
  ];
  const fixture = await createFixture({ parentGoal: dueParentGoal(), messageRequests });
  const busy = digestApi({ rootStatus: () => "working" });
  try {
    await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("done"),
      stateDir: fixture.stateDir,
      herdr: busy,
    });
    const manifest = await fixture.manifest();
    const done = manifest.workflows[0].eventController.events.find((event) => event.classification === "done");
    done.wake = { ...done.wake, status: "sending", attempts: 1 };
    manifest.workflows[0].messageRequests[0].delivery = {
      status: "sending",
      attempts: 1,
      updatedAt: "2026-09-14T00:02:00.000Z",
    };
    await writeFile(fixture.manifestPath, JSON.stringify(manifest));

    const api = digestApi();
    const tick = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: api,
      timestamp: "2026-09-14T00:03:00.000Z",
    });
    assert.deepEqual(tick.pendingWakes, []);
    assert.equal(
      api.prompts.filter((prompt) => prompt.text.startsWith("[Baa-ton digest]")).length,
      0,
    );
    const after = await fixture.manifest();
    assert.equal(
      after.workflows[0].eventController.events.find((event) => event.classification === "done").wake.status,
      "uncertain",
    );
    assert.equal(after.workflows[0].messageRequests[0].delivery.status, "uncertain");
  } finally {
    await fixture.cleanup();
  }
});

async function withDigestWindow(seconds, run) {
  const saved = process.env.BAA_TON_DIGEST_WINDOW_SECONDS;
  process.env.BAA_TON_DIGEST_WINDOW_SECONDS = String(seconds);
  try {
    return await run();
  } finally {
    process.env.BAA_TON_DIGEST_WINDOW_SECONDS = saved;
  }
}

test("non-urgent updates wait out the collection window, then arrive as one digest", async () => {
  const arrivedAt = new Date().toISOString();
  const later = (seconds) => new Date(Date.parse(arrivedAt) + seconds * 1_000).toISOString();
  const fixture = await createFixture({
    parentGoal: dueParentGoal(),
    messageRequests: [pendingMessage("message-with-done", "Finished the fixture; details in the report.", arrivedAt)],
  });
  const api = digestApi();
  try {
    await withDigestWindow(60, async () => {
      const done = await handleHook({
        eventName: "pane.agent_status_changed",
        eventJson: statusEvent("done"),
        stateDir: fixture.stateDir,
        herdr: api,
      });
      assert.equal(done.digest.status, "deferred");
      assert.equal(done.digest.reason, "collecting_updates");
      const early = await runSupervisorTick({ stateDir: fixture.stateDir, herdr: api, timestamp: later(30) });
      assert.equal(early.pendingWakes[0].reason, "collecting_updates");
      assert.equal(api.prompts.length, 0);
      const due = await runSupervisorTick({ stateDir: fixture.stateDir, herdr: api, timestamp: later(61) });
      assert.equal(due.pendingWakes[0].status, "delivered");
      assert.equal(api.prompts.length, 1);
      assert.match(api.prompts[0].text, /2 updates since your last turn:/);
      assert.match(api.prompts[0].text, /done: herdr-bb029\/lane-child/);
      assert.match(api.prompts[0].text, /message-with-done\): Finished the fixture/);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("a blocked lane skips the collection window", async () => {
  const fixture = await createFixture({ parentGoal: dueParentGoal() });
  const api = digestApi();
  try {
    await withDigestWindow(600, async () => {
      const blocked = await handleHook({
        eventName: "pane.agent_status_changed",
        eventJson: statusEvent("blocked"),
        stateDir: fixture.stateDir,
        herdr: api,
      });
      assert.equal(blocked.digest.status, "delivered");
      assert.equal(api.prompts.length, 1);
      assert.match(api.prompts[0].text, /1\. blocked: herdr-bb029\/lane-child/);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("a project digest window is validated and preserved", () => {
  const orchestrator = (window) => ({
    id: "root-window",
    root: ROOT,
    program: {
      id: "/project",
      workspace_id: ROOT.workspace_id,
      ...(window === undefined ? {} : { digest_window_seconds: window }),
    },
    workflows: [],
  });
  const config = (window) => ({ version: 2, owner: "herdr-orchestrator", orchestrators: [orchestrator(window)] });
  assert.equal(validateConfig(config(0)).orchestrators[0].program.digest_window_seconds, 0);
  assert.equal(validateConfig(config(300)).orchestrators[0].program.digest_window_seconds, 300);
  assert.equal("digest_window_seconds" in validateConfig(config()).orchestrators[0].program, false);
  for (const invalid of [-1, 3_601, 1.5, "60"])
    assert.throws(() => validateConfig(config(invalid)), /digest_window_seconds must be an integer from 0 to 3600/);
});

test("open lane requests skip the collection window and every digest lists what is still unanswered", async () => {
  const arrivedAt = new Date().toISOString();
  const later = (seconds) => new Date(Date.parse(arrivedAt) + seconds * 1_000).toISOString();
  const laneRequest = (id, summary, extra = {}) => ({
    id,
    workflowId: "herdr-bb029",
    laneId: CHILD.lane_id,
    kind: "runtime-launch",
    payload: { command: summary },
    summary: `runtime launch: ${summary}`,
    status: "open",
    requestedAt: arrivedAt,
    delivery: { status: "pending", updatedAt: arrivedAt },
    ...extra,
  });
  const fixture = await createFixture({ parentGoal: dueParentGoal() });
  const manifest = await fixture.manifest();
  manifest.workflows[0].laneRequests = [
    laneRequest("request-new", "use ports 3610/3611 and launch", { note: "not answered by policy: no template" }),
    laneRequest("request-earlier", "npm run seed", {
      delivery: { status: "delivered", attempts: 1, updatedAt: arrivedAt },
    }),
    laneRequest("request-done", "npm run dev", { status: "granted", answeredBy: "policy" }),
  ];
  await writeFile(fixture.manifestPath, JSON.stringify(manifest));
  const api = digestApi();
  try {
    await withDigestWindow(60, async () => {
      await runSupervisorTick({ stateDir: fixture.stateDir, herdr: api, timestamp: later(1) });
    });
    const digests = api.prompts.filter((prompt) => prompt.text.startsWith("[Baa-ton digest]"));
    assert.equal(digests.length, 1, "a lane waiting on an answer is urgent");
    const text = digests[0].text;
    assert.match(
      text,
      /\n1\. request from herdr-bb029\/lane-child \(request-new\): runtime launch: use ports 3610\/3611 and launch \[not answered by policy: no template\]/,
    );
    assert.match(text, /Open lane requests awaiting your answer \(herdr_request action=answer\): request-new .*; request-earlier /);
    assert.doesNotMatch(text, /request-done/);
    const stored = await fixture.manifest();
    const byId = Object.fromEntries(stored.workflows[0].laneRequests.map((request) => [request.id, request]));
    assert.deepEqual([byId["request-new"].delivery.status, byId["request-new"].delivery.attempts], ["delivered", 1]);
    assert.equal(byId["request-earlier"].delivery.attempts, 1, "an already delivered request is listed, not re-sent");

    await runSupervisorTick({ stateDir: fixture.stateDir, herdr: api, timestamp: later(10) });
    assert.equal(
      api.prompts.filter((prompt) => prompt.text.startsWith("[Baa-ton digest]")).length,
      1,
      "an open request wakes the root once; later digests only list it",
    );
  } finally {
    await fixture.cleanup();
  }
});

async function directiveFixture() {
  const fixture = await createFixture({ parentGoal: dueParentGoal() });
  const config = validateConfig(JSON.parse(await readFile(join(fixture.stateDir, "config.json"), "utf8")));
  const notices = [];
  const notify = async (notice) => {
    // The no-progress watchdog also runs on these ticks; count directive notices only.
    if (notice.title.includes("directive")) notices.push(notice);
    return { status: "sent" };
  };
  const at = (seconds) => new Date(Date.parse("2026-09-14T01:00:00.000Z") + seconds * 1_000).toISOString();
  const tick = (seconds, api) =>
    runSupervisorTick({ stateDir: fixture.stateDir, herdr: api, notify, timestamp: at(seconds) });
  const settleRoot = (seconds) =>
    patchSupervisor(fixture, { rootTurn: { ...rootTurn("idle"), runId: `run-${seconds}`, updatedAt: at(seconds) } });
  const directive = async () =>
    (await fixture.manifest()).directives[0];
  return { fixture, rootId: config.orchestrators[0].id, notices, notify, at, tick, settleRoot, directive };
}

test("a directive stays open: delivered, re-sent once after an ignored turn, then escalated once", async () => {
  const d = await directiveFixture();
  const api = digestApi();
  try {
    const posted = await postDirective({
      manifestPath: d.fixture.manifestPath,
      rootId: d.rootId,
      from: "zach",
      text: "Run herdr_sweep for the finished cic lanes.",
      timestamp: d.at(0),
    });
    await d.tick(1, api);
    const digests = () => api.prompts.filter((prompt) => prompt.text.includes("directive from"));
    assert.equal(digests().length, 1);
    assert.match(digests()[0].text, new RegExp(`directive from zach \\(${posted.id}\\): Run herdr_sweep for the finished cic lanes\\.`));
    assert.match(digests()[0].text, /herdr_directive action=ack/);
    assert.deepEqual([(await d.directive()).sends, (await d.directive()).delivery.status], [1, "delivered"]);

    await d.tick(10, api);
    assert.equal(digests().length, 1, "no re-send before the root has finished a turn");

    await d.settleRoot(20);
    await d.tick(30, api);
    assert.equal(digests().length, 2, "re-sent once after a turn without an ack");
    assert.match(digests()[1].text, /\[re-sent: not yet acknowledged\]/);
    assert.equal((await d.directive()).sends, 2);
    assert.equal(d.notices.length, 0);

    await d.settleRoot(40);
    const escalated = await d.tick(50, api);
    assert.equal(digests().length, 2, "never a third send");
    assert.equal(d.notices.length, 1);
    assert.equal(d.notices[0].title, "Baa-ton: directive not acknowledged");
    assert.match(d.notices[0].body, /re-sent once and still not acknowledged\. zach: Run herdr_sweep/);
    assert.ok(escalated.pendingWakes.some((wake) => wake.kind === "directive-escalation" && wake.directiveIds[0] === posted.id));
    assert.equal((await d.directive()).escalation.status, "sent");

    await d.settleRoot(60);
    await d.tick(70, api);
    assert.equal(d.notices.length, 1, "escalated once");
  } finally {
    await d.fixture.cleanup();
  }
});

test("an acknowledged directive is never re-sent or escalated", async () => {
  const d = await directiveFixture();
  const api = digestApi();
  try {
    await postDirective({ manifestPath: d.fixture.manifestPath, rootId: d.rootId, from: "supervisor", text: "Pause lane D13.", timestamp: d.at(0) });
    await d.tick(1, api);
    const manifest = await d.fixture.manifest();
    manifest.directives[0].status = "acked";
    manifest.directives[0].ackedAt = d.at(5);
    await writeFile(d.fixture.manifestPath, JSON.stringify(manifest));
    await d.settleRoot(20);
    await d.tick(30, api);
    await d.tick(60 * 60, api);
    assert.equal(api.prompts.filter((prompt) => prompt.text.includes("directive from")).length, 1);
    assert.equal(d.notices.length, 0);
  } finally {
    await d.fixture.cleanup();
  }
});

test("a directive the busy root never receives escalates after the configured minutes", async () => {
  const d = await directiveFixture();
  const api = digestApi();
  try {
    await patchSupervisor(d.fixture, { rootTurn: rootTurn("active") });
    await postDirective({ manifestPath: d.fixture.manifestPath, rootId: d.rootId, from: "zach", text: "Sweep now.", timestamp: d.at(0) });
    await d.tick(60, api);
    assert.equal(api.prompts.length, 0, "a working root is never prompted");
    assert.equal(d.notices.length, 0);
    await d.tick(16 * 60, api);
    assert.equal(api.prompts.length, 0);
    assert.equal(d.notices.length, 1);
    assert.match(d.notices[0].body, /not acknowledged after 15 min/);
  } finally {
    await d.fixture.cleanup();
  }
});

test("directive_escalate_minutes is validated", () => {
  const base = {
    version: 2,
    owner: "herdr-orchestrator",
    orchestrators: [{ id: "o", root: ROOT, program: { id: "p", workspace_id: ROOT.workspace_id }, workflows: [] }],
  };
  const withMinutes = (value) => ({
    ...base,
    orchestrators: [{ ...base.orchestrators[0], program: { ...base.orchestrators[0].program, directive_escalate_minutes: value } }],
  });
  assert.equal(validateConfig(withMinutes(30)).orchestrators[0].program.directive_escalate_minutes, 30);
  for (const value of [0, 1441, 2.5, "15"])
    assert.throws(() => validateConfig(withMinutes(value)), /directive_escalate_minutes/);
});

test("the directive CLI posts and lists directives", async () => {
  const fixture = await createFixture({ parentGoal: dueParentGoal() });
  const { spawnSync } = await import("node:child_process");
  const cli = fileURLToPath(new URL("../directive.mjs", import.meta.url));
  try {
    const posted = spawnSync(process.execPath, [cli, "post", "--manifest", fixture.manifestPath, "--root", "root-x", "--from", "supervisor", "--text", "Pause D13 until the port fix lands."], { encoding: "utf8" });
    assert.equal(posted.status, 0, posted.stderr);
    const record = JSON.parse(posted.stdout);
    assert.equal(record.status, "open");
    assert.equal(record.delivery.status, "pending");
    const listed = spawnSync(process.execPath, [cli, "list", "--manifest", fixture.manifestPath], { encoding: "utf8" });
    assert.match(listed.stdout, new RegExp(`${record.id} \\[open\\] sends=0 supervisor: Pause D13`));
    const missing = spawnSync(process.execPath, [cli, "post", "--manifest", fixture.manifestPath, "--root", "root-x"], { encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--from is required/);
  } finally {
    await fixture.cleanup();
  }
});

async function supervisionFixture({ gate, events = [], rootTurnState = "idle", rootTurnAt = "2026-09-14T01:00:00.000Z" } = {}) {
  const fixture = await createFixture({ parentGoal: dueParentGoal() });
  const config = validateConfig(JSON.parse(await readFile(join(fixture.stateDir, "config.json"), "utf8")));
  const rootId = config.orchestrators[0].id;
  const manifest = await fixture.manifest();
  manifest.parentGoal.supervisor.rootTurn = { ...rootTurn(rootTurnState), updatedAt: rootTurnAt };
  manifest.workflows[0].eventController = { version: 1, events };
  if (gate) manifest.rootSupervision = [{ rootId, alerts: [], capacityGate: gate }];
  await writeFile(fixture.manifestPath, JSON.stringify(manifest));
  const notices = [];
  let current = { freeMemoryGb: 2, swapUsedGb: 24, load1PerCpu: 0.9 };
  const at = (minutes) => new Date(Date.parse("2026-09-14T01:00:00.000Z") + minutes * 60_000).toISOString();
  const tick = (minutes, api) =>
    runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: api,
      notify: async (notice) => {
        notices.push(notice);
        return { status: "sent" };
      },
      sample: async () => current,
      topUsers: async () => ["claude (101) 2.1 GB", "tsserver (202) 1.4 GB"],
      timestamp: at(minutes),
    });
  return {
    fixture,
    rootId,
    notices,
    at,
    tick,
    setSample(next) {
      current = next;
    },
    async supervision() {
      return (await fixture.manifest()).rootSupervision?.[0];
    },
  };
}

const capacityGate = {
  id: "capacity-1",
  status: "waiting",
  reason: "dispatch D19 needs 8 GB",
  minFreeMemoryGb: 8,
  maxSwapUsedGb: 20,
  createdAt: "2026-09-14T01:00:00.000Z",
};
const workingEvent = (receivedAt, status = "working") => ({
  identity: `event-${receivedAt}-${status}`,
  received_at: receivedAt,
  workflow_id: "herdr-bb029",
  lane_id: CHILD.lane_id,
  pane_id: CHILD.pane_id,
  classification: "unclassified",
  source: { agent_status: status },
  wake: { status: "not-required", attempts: 0, updated_at: receivedAt },
});

test("a capacity gate that clears puts 'capacity available' in the root digest", async () => {
  const s = await supervisionFixture({ gate: capacityGate, events: [workingEvent("2026-09-14T01:00:00.000Z")] });
  const api = digestApi();
  try {
    await s.tick(1, api);
    assert.equal((await s.supervision()).capacityGate.status, "waiting");
    s.setSample({ freeMemoryGb: 11.5, swapUsedGb: 6, load1PerCpu: 0.3 });
    await s.tick(2, api);
    const gate = (await s.supervision()).capacityGate;
    assert.equal(gate.status, "cleared");
    const digest = api.prompts.find((prompt) => prompt.text.includes("capacity-available"));
    assert.ok(digest, "the root is told capacity recovered");
    assert.match(digest.text, /capacity available for "dispatch D19 needs 8 GB": free 11\.5 GB, swap 6 GB, load 0\.3\/CPU \(gate: free >= 8 GB, swap <= 20 GB\)/);
    assert.equal(s.notices.length, 0);
  } finally {
    await s.fixture.cleanup();
  }
});

test("a capacity gate blocked past 15 minutes notifies Zach once with the top memory users", async () => {
  const s = await supervisionFixture({ gate: capacityGate, events: [workingEvent("2026-09-14T01:00:00.000Z")] });
  const api = digestApi();
  try {
    await s.tick(14, api);
    assert.equal(s.notices.filter((notice) => notice.title.includes("capacity")).length, 0);
    await s.tick(16, api);
    const capacity = s.notices.filter((notice) => notice.title.includes("capacity"));
    assert.equal(capacity.length, 1);
    assert.equal(capacity[0].title, "Baa-ton: capacity still blocked");
    assert.match(capacity[0].body, /waited 16 min for "dispatch D19 needs 8 GB"/);
    assert.match(capacity[0].body, /Top memory: claude \(101\) 2\.1 GB; tsserver \(202\) 1\.4 GB/);
    await s.tick(20, api);
    assert.equal(s.notices.filter((notice) => notice.title.includes("capacity")).length, 1, "once per gate");
    assert.equal((await s.supervision()).capacityGate.status, "waiting", "still waiting until it clears");
  } finally {
    await s.fixture.cleanup();
  }
});

test("the watchdog alerts once per idle episode when no lane has worked for 30 minutes", async () => {
  const s = await supervisionFixture({
    events: [workingEvent("2026-09-14T00:50:00.000Z"), workingEvent("2026-09-14T01:00:00.000Z", "idle")],
  });
  const api = digestApi();
  try {
    await s.tick(29, api);
    assert.equal(s.notices.length, 0);
    await s.tick(31, api);
    assert.equal(s.notices.length, 1);
    assert.equal(s.notices[0].title, "Baa-ton: no progress");
    assert.match(s.notices[0].body, /no lane has been working for 31 min while parent goal parent-recovery is active/);
    const nudge = api.prompts.find((prompt) => prompt.text.includes("no-progress"));
    assert.ok(nudge, "the root is nudged with the reason");
    assert.match(nudge.text, /Plan or dispatch the next step, or record a truthful goal state/);
    await s.tick(45, api);
    assert.equal(s.notices.length, 1, "one alert per episode");

    // New activity starts a new episode.
    const manifest = await s.fixture.manifest();
    manifest.workflows[0].eventController.events.push(
      workingEvent(s.at(50)),
      workingEvent(s.at(55), "done"),
    );
    await writeFile(s.fixture.manifestPath, JSON.stringify(manifest));
    await s.tick(60, api);
    assert.equal(s.notices.length, 1, "working recently");
    await s.tick(90, api);
    assert.equal(s.notices.length, 2, "a new idle episode alerts again");
  } finally {
    await s.fixture.cleanup();
  }
});

test("the watchdog stays quiet while a lane or the root is working, or the goal is terminal", async () => {
  const working = await supervisionFixture({ events: [workingEvent("2026-09-14T00:00:00.000Z")] });
  const busyRoot = await supervisionFixture({ rootTurnState: "active" });
  const api = digestApi();
  try {
    await working.tick(120, api);
    await busyRoot.tick(120, api);
    assert.equal(working.notices.length + busyRoot.notices.length, 0);
    const manifest = await working.fixture.manifest();
    manifest.workflows[0].eventController.events.push(workingEvent("2026-09-14T00:10:00.000Z", "idle"));
    manifest.parentGoal.status = "completed";
    await writeFile(working.fixture.manifestPath, JSON.stringify(manifest));
    await working.tick(180, api);
    assert.equal(working.notices.length, 0, "a completed goal is not a stall");
  } finally {
    await working.fixture.cleanup();
    await busyRoot.fixture.cleanup();
  }
});

test("capacity_escalate_minutes and watchdog_minutes are validated and honoured", () => {
  const program = (extra) => ({
    version: 2,
    owner: "herdr-orchestrator",
    orchestrators: [{ id: "o", root: ROOT, program: { id: "p", workspace_id: ROOT.workspace_id, ...extra }, workflows: [] }],
  });
  const parsed = validateConfig(program({ capacity_escalate_minutes: 5, watchdog_minutes: 45 }));
  assert.equal(parsed.orchestrators[0].program.capacity_escalate_minutes, 5);
  assert.equal(parsed.orchestrators[0].program.watchdog_minutes, 45);
  for (const extra of [{ watchdog_minutes: 0 }, { capacity_escalate_minutes: 1441 }, { watchdog_minutes: "30" }])
    assert.throws(() => validateConfig(program(extra)), /must be an integer from 1 to 1440/);
});

async function withHistoricalMapping(fixture, manifestPath) {
  const configPath = join(fixture.stateDir, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.workflows.unshift({
    workflow_id: "herdr-historical",
    manifest_path: manifestPath,
    pi_goal_pause_detection: false,
    lanes: [{ ...CHILD, lane_id: "lane-historical", target: "historical-child", pane_id: "w-old:p9" }],
  });
  await writeFile(configPath, JSON.stringify(config, null, 2));
}

for (const [label, prepare, pattern] of [
  ["a missing historical manifest directory", async () => {}, /ENOENT/],
  [
    "a malformed historical manifest",
    async (path) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "{ not json");
    },
    /Parent manifest/,
  ],
]) {
  test(`${label} is skipped and logged while later manifests are still served`, async () => {
    const fixture = await createFixture({
      parentGoal: dueParentGoal(),
      messageRequests: [pendingMessage("message-after-history", "Lane finished; receipt attached.", "2026-09-14T00:01:00.000Z")],
    });
    const historical = join(dirname(fixture.stateDir), "historical", "gone", "manifest.json");
    await prepare(historical);
    await withHistoricalMapping(fixture, historical);
    const api = digestApi();
    try {
      const first = await runSupervisorTick({ stateDir: fixture.stateDir, herdr: api, timestamp: "2026-09-14T00:02:00.000Z" });
      const skipped = first.results.find((result) => result.manifestPath === historical);
      assert.equal(skipped.status, "skipped");
      assert.match(skipped.error, pattern);
      const digests = () => api.prompts.filter((prompt) => prompt.text.startsWith("[Baa-ton digest]"));
      assert.equal(digests().length, 1, "the valid manifest after the bad one is still served");
      assert.match(digests()[0].text, /message-after-history\): Lane finished; receipt attached\./);

      const diagnostics = JSON.parse(await readFile(join(fixture.stateDir, "supervisor-diagnostics.json"), "utf8"));
      assert.equal(diagnostics.skips.length, 1);
      assert.equal(diagnostics.skips[0].manifestPath, historical);
      assert.match(diagnostics.skips[0].error, pattern);
      assert.equal(diagnostics.skips[0].firstAt, "2026-09-14T00:02:00.000Z");

      await runSupervisorTick({ stateDir: fixture.stateDir, herdr: api, timestamp: "2026-09-14T00:02:05.000Z" });
      await runSupervisorTick({ stateDir: fixture.stateDir, herdr: api, timestamp: "2026-09-14T00:04:00.000Z" });
      assert.equal(digests().length, 1, "a delivered message is never replayed");
      const later = JSON.parse(await readFile(join(fixture.stateDir, "supervisor-diagnostics.json"), "utf8"));
      assert.equal(later.skips.length, 1, "repeats refresh one entry");
      assert.equal(later.skips[0].lastAt, "2026-09-14T00:04:00.000Z");
      const stored = await fixture.manifest();
      assert.deepEqual(
        stored.workflows[0].messageRequests.map((request) => [request.delivery.status, request.delivery.attempts]),
        [["delivered", 1]],
      );
    } finally {
      await fixture.cleanup();
    }
  });
}

test("an interrupted send in a manifest is not replayed after a neighbouring manifest fails", async () => {
  const fixture = await createFixture({
    parentGoal: dueParentGoal(),
    messageRequests: [
      {
        ...pendingMessage("message-interrupted", "Half-sent before a crash.", "2026-09-14T00:01:00.000Z"),
        delivery: { status: "sending", attempts: 1, updatedAt: "2026-09-14T00:01:30.000Z" },
      },
    ],
  });
  const historical = join(dirname(fixture.stateDir), "historical", "gone", "manifest.json");
  await withHistoricalMapping(fixture, historical);
  const api = digestApi();
  try {
    await runSupervisorTick({ stateDir: fixture.stateDir, herdr: api, timestamp: "2026-09-14T00:02:00.000Z" });
    assert.equal(
      api.prompts.filter((prompt) => prompt.text.startsWith("[Baa-ton digest]") && prompt.text.includes("message-interrupted")).length,
      0,
      "the interrupted digest delivery is not replayed (a supervisor nudge may point at it as possibly unseen)",
    );
    const stored = await fixture.manifest();
    assert.equal(stored.workflows[0].messageRequests[0].delivery.status, "uncertain");
  } finally {
    await fixture.cleanup();
  }
});

test("a due nudge never lands mid-turn and goes out on the first tick after the root settles", async () => {
  const fixture = await createFixture({ parentGoal: statusGoal("waiting-for-event") });
  const api = recoveryApi();
  try {
    await patchSupervisor(fixture, { rootTurn: rootTurn("active") });
    for (const second of [0, 5, 10])
      assert.equal(
        (await runSupervisorTick({ stateDir: fixture.stateDir, herdr: api, timestamp: `2026-09-14T00:00:${String(second).padStart(2, "0")}.000Z` })).results[0].status,
        "root-turn-not-idle",
      );
    assert.equal(api.prompts, 0);
    api.status = "working";
    await patchSupervisor(fixture, { rootTurn: { ...rootTurn("idle"), updatedAt: "2026-09-14T00:00:12.000Z" } });
    assert.equal(
      (await runSupervisorTick({ stateDir: fixture.stateDir, herdr: api, timestamp: "2026-09-14T00:00:14.000Z" })).results[0].status,
      "root-not-idle",
      "live Herdr working still vetoes",
    );
    api.status = "idle";
    assert.equal(
      (await runSupervisorTick({ stateDir: fixture.stateDir, herdr: api, timestamp: "2026-09-14T00:00:30.000Z" })).results[0].status,
      "delivered",
    );
    assert.equal(api.prompts, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("the watchdog alerts once when a live goal's supervisor has been stopped past the watchdog delay", async () => {
  const stopped = (status) => ({
    ...statusGoal(status),
    supervisor: { ...statusGoal(status).supervisor, state: "stopped", nextNudgeAt: null, updatedAt: "2026-09-14T00:00:00.000Z" },
  });
  const live = await createFixture({ parentGoal: stopped("active") });
  const done = await createFixture({ parentGoal: stopped("completed") });
  const notices = [];
  const api = recoveryApi();
  const tick = (fixture, minutes) =>
    runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: api,
      notify: async (notice) => {
        notices.push(notice);
        return { status: "sent" };
      },
      sample: async () => ({}),
      topUsers: async () => [],
      timestamp: new Date(Date.parse("2026-09-14T00:00:00.000Z") + minutes * 60_000).toISOString(),
    });
  const stoppedNotices = () => notices.filter((notice) => notice.title === "Baa-ton: supervisor stopped");
  try {
    await tick(live, 0);
    await tick(live, 29);
    assert.equal(stoppedNotices().length, 0, "a short deliberate stop stays quiet");
    await tick(live, 31);
    assert.equal(stoppedNotices().length, 1);
    assert.match(stoppedNotices()[0].body, /supervisor for parent goal parent-bb029 \(active\) has been stopped for 31 min, so the root gets no nudges/);
    assert.equal(api.prompts, 1, "the root gets the alert in its digest");
    await tick(live, 45);
    assert.equal(stoppedNotices().length, 1, "once per stop episode");
    assert.equal((await live.manifest()).parentGoal.supervisor.state, "stopped", "the alert never restarts the supervisor itself");
    // Restarting ends the episode; a later stop starts a new one.
    const restarted = await live.manifest();
    restarted.parentGoal.supervisor.state = "running";
    await writeFile(live.manifestPath, JSON.stringify(restarted));
    await tick(live, 50);
    assert.equal((await live.manifest()).rootSupervision[0].supervisorStopped, undefined);
    restarted.parentGoal.supervisor.state = "stopped";
    await writeFile(live.manifestPath, JSON.stringify({ ...(await live.manifest()), parentGoal: restarted.parentGoal }));
    await tick(live, 51);
    await tick(live, 82);
    assert.equal(stoppedNotices().length, 2, "a new stop episode alerts again");
    await tick(done, 0);
    await tick(done, 120);
    assert.equal(stoppedNotices().length, 2, "a completed goal is not alerted");
  } finally {
    await live.cleanup();
    await done.cleanup();
  }
});

async function fakeCheckout() {
  const root = await mkdtemp(join(tmpdir(), "baa-checkout-"));
  await mkdir(join(root, "packages", "controller"), { recursive: true });
  await mkdir(join(root, "packages", "herdr-tools", "inbox"), { recursive: true });
  await writeFile(join(root, "packages", "controller", "controller.mjs"), "export const v = 1;\n");
  await writeFile(join(root, "packages", "herdr-tools", "index.ts"), "export const v = 1;\n");
  return root;
}

test("code fingerprints change with content and a change is reported only once stable", async () => {
  const root = await fakeCheckout();
  try {
    const loaded = loadedCode(root);
    assert.match(loaded.fingerprint, /^[0-9a-f]{12}$/);
    const changed = codeChangeWatcher(loaded, root);
    assert.equal(changed(), undefined, "unchanged code");
    await writeFile(join(root, "packages", "controller", "controller.mjs"), "export const v = 2;\n");
    assert.notEqual(codeFingerprint(root), loaded.fingerprint);
    assert.equal(changed(), undefined, "the first sighting of new code waits (a pull may be mid-write)");
    assert.equal(changed(), codeFingerprint(root), "stable new code is reported");
    await writeFile(join(root, "packages", "controller", "controller.mjs"), "export const v = 1;\n");
    const back = codeChangeWatcher(loaded, root);
    assert.equal(back(), undefined, "reverting to the loaded code is not a change");
    assert.equal(codeStamp(root).includes("packages/controller/controller.mjs"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the supervisor releases its lease, drops its runtime record and asks for a restart when its code changes", async () => {
  const fixture = await createFixture({});
  let reported = 0;
  const restarts = [];
  const loop = await runSupervisorLoop({
    intervalMs: 3_600_000,
    stateDir: fixture.stateDir,
    configDir: fixture.stateDir,
    herdr: { async request() { return { result: {} }; } },
    loaded: { checkout: "/checkout", fingerprint: "aaaaaaaaaaaa", commit: "0".repeat(40), stamp: "s" },
    codeChanged: () => (++reported >= 2 ? "bbbbbbbbbbbb" : undefined),
    onCodeChange: (fingerprint) => restarts.push(fingerprint),
  });
  try {
    assert.equal(loop.started, true);
    const records = listRuntime(fixture.stateDir);
    assert.deepEqual(records.map((record) => [record.role, record.fingerprint, record.pid]), [["supervisor", "aaaaaaaaaaaa", process.pid]]);
    await loop.tick();
    assert.deepEqual(restarts, [], "no restart while the code is unchanged");
    await loop.tick();
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    assert.deepEqual(restarts, ["bbbbbbbbbbbb"]);
    assert.equal(existsSync(join(fixture.stateDir, "supervisor.lock")), false, "the lease is released before the restart");
    assert.deepEqual(listRuntime(fixture.stateDir), [], "the runtime record is removed");
  } finally {
    await loop.stop();
    await fixture.cleanup();
  }
});

test("the supervisor launcher restarts on the restart exit code, stops on any other, and guards against loops", async () => {
  const exits = [SUPERVISOR_RESTART_EXIT_CODE, SUPERVISOR_RESTART_EXIT_CODE, 0];
  let runs = 0;
  assert.equal(await runSupervisorLauncher({ restartDelayMs: 0, spawnRunner: async () => { runs += 1; return exits.shift(); } }), 0);
  assert.equal(runs, 3, "two code-change restarts, then a normal exit");
  let clock = 0;
  let loops = 0;
  const code = await runSupervisorLauncher({
    restartDelayMs: 0,
    maxRestarts: 3,
    windowMs: 60_000,
    clock: () => (clock += 1_000),
    spawnRunner: async () => { loops += 1; return SUPERVISOR_RESTART_EXIT_CODE; },
  });
  assert.equal(code, SUPERVISOR_RESTART_EXIT_CODE);
  assert.equal(loops, 4, "more than three restarts in a minute stops the launcher");
});

test("runtime records list only live processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baa-runtime-"));
  try {
    const remove = recordRuntime(dir, { role: "bridge", fingerprint: "cccccccccccc", paneId: "w1:p2" });
    await mkdir(join(dir, "runtime"), { recursive: true });
    await writeFile(join(dir, "runtime", "bridge-99999999.json"), JSON.stringify({ role: "bridge", pid: 99999999 }));
    assert.deepEqual(listRuntime(dir).map((record) => record.paneId), ["w1:p2"]);
    remove();
    assert.deepEqual(listRuntime(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the nudge flags a planned workflow from an earlier root session and names herdr_supersede", async () => {
  const fixture = await createFixture({ parentGoal: statusGoal("active"), laneRequests: [] });
  const config = validateConfig(JSON.parse(await readFile(join(fixture.stateDir, "config.json"), "utf8")));
  const manifest = await fixture.manifest();
  const binding = (path) => ({ workspaceId: ROOT.workspace_id, rootPaneId: ROOT.pane_id, rootSessionPath: path });
  manifest.workflows.push(
    { id: "herdr-stale", status: "planned", taskBinding: binding("/sessions/old.jsonl"), lanes: [] },
    { id: "herdr-fresh", status: "planned", taskBinding: binding("/sessions/new.jsonl"), lanes: [] },
    { id: "herdr-gone", status: "superseded", taskBinding: binding("/sessions/old.jsonl"), lanes: [] },
  );
  manifest.rootSessionLogs = [{
    rootId: config.orchestrators[0].id,
    kind: "root",
    status: "working",
    startedAt: "t",
    sessionRef: { provider: "pi", sessionId: "s-new", metadata: { sessionPath: "/sessions/new.jsonl" } },
  }];
  await writeFile(fixture.manifestPath, JSON.stringify(manifest));
  const texts = [];
  const api = recoveryApi();
  try {
    await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: { async request(method, params) { if (method === "agent.prompt") texts.push(params.text); return api.request(method, params); } },
      timestamp: "2026-09-14T00:00:00.000Z",
    });
    const nudge = texts.find((text) => text.startsWith("[Baa-ton supervisor]"));
    assert.match(nudge, /workflow herdr-stale was planned by an earlier root session and cannot be dispatched as is; retire it with herdr_supersede/);
    assert.match(nudge, /workflow herdr-fresh is planned but not dispatched/);
    assert.doesNotMatch(nudge, /herdr-gone/, "superseded workflows are not work");
  } finally {
    await fixture.cleanup();
  }
});

test("a permission request wakes the root even while Herdr reports the lane working", () => {
  const orchestrator = { id: "o-1", root: { pane_id: "w-root:p1", workspace_id: "w-root" }, workflows: [] };
  const request = (id, kind, summary) => ({ id, laneId: "lane-1", kind, status: "open", summary });
  const manifest = {
    workflows: [{
      id: "herdr-perm",
      status: "running",
      taskBinding: { workspaceId: "w-root", rootPaneId: "w-root:p1" },
      eventController: { events: [{ lane_id: "lane-1", source: { agent_status: "working" } }] },
      laneRequests: [
        request("request-perm", "permission", "permission: Bash docker compose up -d db"),
        request("request-lease", "lease", "lease app"),
      ],
    }],
  };
  const decision = nudgeDecision({ goal: { status: "active" }, manifest, orchestrator, manifestPath: "/m.json" });
  const text = JSON.stringify(decision);
  assert.match(text, /lane herdr-perm\/lane-1 \(working\) waits on permission request-perm: permission: Bash docker compose up -d db/);
  assert.doesNotMatch(text, /request-lease/, "other requests from a working lane still wait for the lane to stop");
});
