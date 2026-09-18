import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
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
} from "../controller.mjs";
import { configureSidebar } from "../sidebar-configure.mjs";
import { readStore, storePath } from "../../herdr-tools/inbox/index.mjs";

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
  const panes = [];
  let current = top;
  for (const untrimmed of raw.split(/\r?\n/)) {
    const line = untrimmed.trim();
    if (!line || line.startsWith("#")) continue;
    if (["[[events]]", "[[startup]]", "[[actions]]", "[[panes]]"].includes(line)) {
      current = {};
      (line === "[[events]]"
        ? events
        : line === "[[actions]]"
          ? actions
          : line === "[[panes]]"
            ? panes
            : (top.startup ??= [])
      ).push(current);
      continue;
    }
    const match =
      /^(id|name|version|min_herdr_version|description|platforms|on|command|title|placement) = (.+)$/.exec(
        line,
      );
    assert.ok(match, `unsupported or malformed manifest line: ${line}`);
    current[match[1]] = JSON.parse(match[2]);
  }
  return { top, events, actions, panes };
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
  assert.deepEqual(manifest.panes, [{
    id: "supervisor", title: "Baa-ton controller supervisor", placement: "tab",
    command: ["node", "controller.mjs", "supervisor"],
  }]);
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

test("durable child messages wake the root after lane completion and remain distinct", async () => {
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
    const prompts = requestsFor(mock, "agent.prompt");
    assert.equal(prompts.length, 2);
    assert.match(prompts[0].params.text, /lane lane-child/);
    assert.match(prompts[0].params.text, /The user asked for more work/);
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

test("the Herdr-owned supervisor nudges only a due running parent goal and records delivery", async () => {
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
        /Parent goal parent-bb029 remains active/,
      );
      assert.match(
        request.params.text,
        /Continue the active goal autonomously through as many safe local actions as needed/,
      );
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
    assert.equal(goal.supervisor.nextNudgeAt, null);
    const second = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: client(mock),
      timestamp: "2026-09-14T00:00:01.000Z",
    });
    assert.equal(second.results[0].status, "wake-suppressed");
    assert.equal(requestsFor(mock, "agent.prompt").length, 1);
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
      intervalSeconds: 5,
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

test("concurrent overdue ticks and process-style restarts consume exactly one idle wake", async () => {
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
      null,
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

test("legacy delivered/uncertain and interrupted sending receipts cannot be retried by ticks", async () => {
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
      if (status === "sending") assert.equal(control.nextNudgeAt, null);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("definite unavailable-root recovery retries once but ambiguous delivery stays latched", async () => {
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
      "2026-09-14T00:00:05.000Z",
    );
    api.available = true;
    assert.equal(
      (await recoveryTick(fixture, api, 1)).results[0].status,
      "delivered",
    );
    await recoveryTick(fixture, api, 2);
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
    assert.equal(
      (await recoveryTick(fixture, ambiguousApi, 3)).results[0].status,
      "uncertain",
    );
    for (let step = 4; step < 8; step += 1)
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
    assert.equal(supervisor.nextNudgeAt, null);
    const second = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr,
      timestamp: "2026-09-14T00:05:00.000Z",
    });
    assert.equal(second.results[0].status, "wake-suppressed");
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
      await assert.rejects(
        recoveryTick(fixture, api, 0),
        /rootTurn|acknowledgedAt/,
      );
      assert.equal(api.prompts, 0);
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

test("a stale working lane emits one durable advisory stall signal and wakes its root", async () => {
  const fixture = await createFixture({
    piGoalPauseDetection: false,
    parentGoal: {
      version: 1,
      id: "parent-stall",
      objective: "Inspect a stalled lane.",
      status: "active",
      nextAction: "Continue the lane.",
      signals: [],
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    },
  });
  const transitionAt = "2026-09-14T00:00:00.000Z";
  await seedWorkingTransition(fixture, transitionAt);
  const prompts = [];
  const lanePrompts = [];
  const api = rootWakeApi(prompts, undefined, lanePrompts);
  try {
    const first = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: api,
      timestamp: "2026-09-14T00:06:00.000Z",
    });
    assert.deepEqual(first.pendingWakes, [
      {
        manifestPath: fixture.manifestPath,
        workflowId: "herdr-bb029",
        laneId: CHILD.lane_id,
        status: "delivered",
      },
    ]);
    let manifest = await fixture.manifest();
    let stalls = manifest.workflows[0].eventController.events.filter(
      (event) => event.classification === "stall-suspected",
    );
    assert.equal(stalls.length, 1);
    assert.equal(stalls[0].wake.status, "delivered");
    assert.equal(stalls[0].received_at, transitionAt);
    assert.equal(stalls[0].detected_at, "2026-09-14T00:06:00.000Z");
    assert.equal(stalls[0].nudge.status, "delivered");
    assert.equal(lanePrompts.length, 1);
    assert.equal(lanePrompts[0].target, CHILD.target);
    assert.match(
      lanePrompts[0].text,
      /you may be stalled\. Continue your assigned work now \(objective: /,
    );
    assert.match(
      lanePrompts[0].text,
      /file your herdr_complete receipt\./,
    );
    assert.equal(manifest.parentGoal.status, "review-requested");
    assert.equal(manifest.parentGoal.signals[0].classification, "stall-suspected");
    assert.match(
      prompts[0],
      /\[Herdr Orchestrator stall-suspected\] workflow herdr-bb029, lane lane-child has had no recorded status transition for 6 minutes\./,
    );
    assert.match(
      prompts[0],
      /advisory only and may be a false positive on a genuinely slow turn; inspect the lane and workflow rather than assuming the lane is dead\./,
    );

    const second = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: api,
      timestamp: "2026-09-14T00:07:00.000Z",
    });
    assert.deepEqual(second.pendingWakes, []);
    manifest = await fixture.manifest();
    stalls = manifest.workflows[0].eventController.events.filter(
      (event) => event.classification === "stall-suspected",
    );
    assert.equal(stalls.length, 1);
    assert.equal(prompts.length, 1);
    assert.equal(lanePrompts.length, 1, "nudge dedupes with the stall period");
  } finally {
    await fixture.cleanup();
  }
});

test("a stall signal records an uncertain nudge when the lane prompt fails", async () => {
  const fixture = await createFixture({ piGoalPauseDetection: false });
  await seedWorkingTransition(fixture, "2026-09-14T00:00:00.000Z");
  const prompts = [];
  const api = {
    ...rootWakeApi(prompts),
    async request(method, params = {}) {
      if (method === "pane.report_metadata") return { result: {} };
      if (method === "agent.prompt") {
        if (params.target === ROOT.target) {
          prompts.push(params.text);
          return { result: { type: "agent_prompted" } };
        }
        throw new Error("socket_timeout after submission");
      }
      return {
        type: "agent_info",
        agent: {
          agent: ROOT.agent_kind,
          name: ROOT.target,
          pane_id: ROOT.pane_id,
          workspace_id: ROOT.workspace_id,
        },
      };
    },
  };
  try {
    const result = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: api,
      timestamp: "2026-09-14T00:06:00.000Z",
    });
    assert.deepEqual(result.pendingWakes, [
      {
        manifestPath: fixture.manifestPath,
        workflowId: "herdr-bb029",
        laneId: CHILD.lane_id,
        status: "delivered",
      },
    ]);
    const manifest = await fixture.manifest();
    const stalls = manifest.workflows[0].eventController.events.filter(
      (event) => event.classification === "stall-suspected",
    );
    assert.equal(stalls.length, 1);
    assert.equal(stalls[0].nudge.status, "uncertain");
    assert.match(stalls[0].nudge.reason, /socket_timeout/);
  } finally {
    await fixture.cleanup();
  }
});

test("a working lane that transitions before the threshold does not emit a stall signal", async () => {
  const fixture = await createFixture({ piGoalPauseDetection: false });
  await seedWorkingTransition(fixture, "2026-09-14T00:00:00.000Z");
  const prompts = [];
  try {
    const result = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: rootWakeApi(prompts),
      timestamp: "2026-09-14T00:04:59.000Z",
    });
    assert.deepEqual(result.pendingWakes, []);
    const events = (await fixture.manifest()).workflows[0].eventController.events;
    assert.equal(events.length, 1);
    assert.equal(prompts.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("a lane that goes stale, transitions, and goes stale again emits a distinct second signal", async () => {
  const fixture = await createFixture({ piGoalPauseDetection: false });
  const prompts = [];
  const api = rootWakeApi(prompts);
  await seedWorkingTransition(fixture, "2026-09-14T00:00:00.000Z");
  try {
    await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: api,
      timestamp: "2026-09-14T00:06:00.000Z",
    });
    await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("blocked"),
      stateDir: fixture.stateDir,
      herdr: api,
    });
    await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("working"),
      stateDir: fixture.stateDir,
      herdr: api,
    });
    const manifest = await fixture.manifest();
    const resumed = manifest.workflows[0].eventController.events.at(-1);
    resumed.received_at = "2026-09-14T00:08:00.000Z";
    await writeFile(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const second = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: api,
      timestamp: "2026-09-14T00:14:00.000Z",
    });
    assert.equal(
      second.pendingWakes.filter((wake) => wake.status === "delivered").length,
      1,
    );
    const events = (await fixture.manifest()).workflows[0].eventController.events;
    const stalls = events.filter((event) => event.classification === "stall-suspected");
    assert.equal(stalls.length, 2);
    assert.notEqual(stalls[0].identity, stalls[1].identity);
    assert.equal(
      prompts.filter((text) => text.includes("stall-suspected")).length,
      2,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a terminal lane never emits a stall signal from an old working transition", async () => {
  const fixture = await createFixture({
    piGoalPauseDetection: false,
    completionReceipt: {
      id: "incarnation-stall-terminal",
      summary: "lane completed",
      delivery: "delivered",
    },
  });
  await seedWorkingTransition(fixture, "2026-09-14T00:00:00.000Z");
  const prompts = [];
  try {
    const result = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: rootWakeApi(prompts),
      timestamp: "2026-09-14T01:00:00.000Z",
    });
    assert.deepEqual(result.pendingWakes, []);
    const events = (await fixture.manifest()).workflows[0].eventController.events;
    assert.equal(events.some((event) => event.classification === "stall-suspected"), false);
    assert.equal(prompts.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("stalls are isolated to each routed root in a multi-root supervisor tick", async () => {
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
  await seedWorkingTransition(fixture, "2026-09-14T00:00:00.000Z");
  const secondManifestPath = join(fixture.directory, "second-stall", "manifest.json");
  await mkdir(dirname(secondManifestPath), { recursive: true });
  await writeFile(
    secondManifestPath,
    `${JSON.stringify(
      {
        version: 2,
        workflows: [
          {
            id: "herdr-b",
            ownership: { createdBy: "herdr-orchestrator" },
            lanes: [
              {
                id: childB.lane_id,
                paneId: childB.pane_id,
                agentName: childB.target,
              },
            ],
            eventController: {
              version: 1,
              events: [
                {
                  identity: "working-b",
                  received_at: "2026-09-14T00:00:00.000Z",
                  event: "pane.agent_status_changed",
                  workflow_id: "herdr-b",
                  lane_id: childB.lane_id,
                  pane_id: childB.pane_id,
                  workspace_id: childB.workspace_id,
                  classification: "unclassified",
                  source: { agent_status: "working" },
                  wake: { status: "not-required", attempts: 0 },
                },
              ],
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(fixture.stateDir, "config.json"),
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
                manifest_path: secondManifestPath,
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
  );
  const prompts = [];
  const api = {
    async request(method, params = {}) {
      if (method === "pane.report_metadata") return { result: {} };
      if (method === "agent.prompt") {
        prompts.push({ target: params.target, text: params.text });
        return { result: { type: "agent_prompted" } };
      }
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
    },
  };
  try {
    await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: api,
      timestamp: "2026-09-14T00:06:00.000Z",
    });
    assert.deepEqual(
      prompts.map((prompt) => prompt.target).sort(),
      [ROOT.target, CHILD.target, rootB.target, childB.target].sort(),
    );
    assert.equal(
      prompts.some((prompt) => prompt.text.includes("workflow herdr-bb029")),
      true,
    );
    assert.equal(
      prompts.some((prompt) => prompt.text.includes("workflow herdr-b")),
      true,
    );
    const second = JSON.parse(await readFile(secondManifestPath, "utf8"));
    assert.equal(
      second.workflows[0].eventController.events.filter(
        (event) => event.classification === "stall-suspected",
      ).length,
      1,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("the supervisor never overwrites waiting, paused, blocked, or completed parent goals", async () => {
  for (const status of [
    "waiting-for-event",
    "action-required",
    "paused",
    "blocked",
    "completed",
  ]) {
    const fixture = await createFixture({
      parentGoal: {
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
      },
    });
    try {
      const result = await runSupervisorTick({
        stateDir: fixture.stateDir,
        herdr: {
          async request() {
            throw new Error("terminal goals must not wake");
          },
        },
        timestamp: "2026-09-14T00:00:00.000Z",
      });
      assert.equal(result.results[0].status, "not-active");
      const goal = (await fixture.manifest()).parentGoal;
      assert.equal(
        goal.status,
        status,
        "a stale tick must not overwrite parent lifecycle state",
      );
      assert.equal(
        goal.supervisor.lastDelivery,
        undefined,
        "inactive goals are never nudged",
      );
    } finally {
      await fixture.cleanup();
    }
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
    assert.equal(events[0].wake.attempts, 2);
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
    // and a routine tick should be needed to recover the pending wake, even
    // though the supervisor itself skips a review-requested goal.
    const tick = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: client(mock),
      timestamp: "2026-09-14T00:05:00.000Z",
    });
    assert.equal(tick.results[0].status, "not-active");
    assert.deepEqual(tick.pendingWakes, [
      {
        manifestPath: fixture.manifestPath,
        workflowId: "herdr-bb029",
        laneId: CHILD.lane_id,
        status: "delivered",
      },
    ]);
    assert.equal(requestsFor(mock, "agent.prompt").length, 1);
    const manifest = await fixture.manifest();
    const events = manifest.workflows[0].eventController.events;
    assert.equal(events.length, 1);
    assert.equal(events[0].wake.status, "delivered");
    assert.equal(events[0].wake.attempts, 2);

    // A second tick must not redeliver an already-drained wake.
    await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: client(mock),
      timestamp: "2026-09-14T00:10:00.000Z",
    });
    assert.equal(requestsFor(mock, "agent.prompt").length, 1);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

async function receiptFixture(delivery = "pending", parentGoal) {
  const fixture = await createFixture({ parentGoal, workflowStatus: "completed", workflowOutcome: "completed",
    completionReceipt: { id: "incarnation-receipt", summary: "Verified output in lane", delivery } });
  const manifest = await fixture.manifest();
  manifest.workflows[0].taskBinding = { rootPaneId: ROOT.pane_id, workspaceId: ROOT.workspace_id, rootSessionPath: "/sessions/owning-root.jsonl" };
  manifest.workflows[0].lanes[0].incarnationId = "incarnation-receipt";
  await writeFile(fixture.manifestPath, JSON.stringify(manifest));
  return fixture;
}

test("completed receipt retries after a busy root without another hook and is delivered once across concurrent ticks", async () => {
  for (const withGoal of [false, true]) {
    const fixture = await receiptFixture("pending", withGoal ? { ...dueParentGoal(), status: "review-requested" } : undefined);
    let status = "working", session = "/sessions/owning-root.jsonl", prompts = 0;
    const api = { async request(method) {
      if (method === "pane.report_metadata") return {};
      if (method === "agent.get") {
        const info = rootAgentInfo().result;
        Object.assign(info.agent, { agent_status: status, agent_session: { kind: "path", value: session } });
        return info;
      }
      if (method === "agent.prompt") {
        assert.equal((await fixture.manifest()).workflows[0].lanes[0].completionReceipt.delivery, "sending", "claim is durable before prompt I/O");
        prompts++; return {};
      }
      throw new Error(`Unexpected method ${method}`);
    } };
    const tick = () => runSupervisorTick({ stateDir: fixture.stateDir, herdr: api });
    try {
      await tick(); assert.equal(prompts, 0);
      assert.equal((await fixture.manifest()).workflows[0].lanes[0].completionReceipt.delivery, "pending");
      status = "idle"; session = "/sessions/replacement-root.jsonl";
      await tick(); assert.equal(prompts, 0, "same pane with foreign session cannot consume receipt");
      session = "/sessions/owning-root.jsonl";
      const outcomes = await Promise.all([tick(), tick()]);
      assert.equal(prompts, 1);
      assert.equal(outcomes.flatMap(item => item.pendingWakes).filter(item => item.kind === "completion-receipt").length, 1);
      const manifest = await fixture.manifest();
      assert.equal(manifest.workflows[0].lanes[0].completionReceipt.delivery, "delivered");
      assert.equal(manifest.workflows[0].status, "completed");
      if (withGoal) assert.equal(manifest.parentGoal.status, "review-requested");
      await tick(); assert.equal(prompts, 1);
    } finally { await fixture.cleanup(); }
  }
});

test("receipt delivery leaves interrupted, ambiguous, and already delivered states untouched", async () => {
  for (const delivery of ["sending", "uncertain", "delivered"]) {
    const fixture = await receiptFixture(delivery);
    try {
      await runSupervisorTick({ stateDir: fixture.stateDir, herdr: { async request(method) {
        assert.equal(method, "pane.report_metadata"); return {};
      } } });
      assert.equal((await fixture.manifest()).workflows[0].lanes[0].completionReceipt.delivery, delivery);
    } finally { await fixture.cleanup(); }
  }
});

test("receipt retries definite prompt rejection but never ambiguous delivery", async () => {
  for (const code of ["agent_blocked", "socket_timeout"]) {
    const fixture = await receiptFixture();
    let rejected = true;
    const mock = await startHerdrMock(request => {
      if (request.method === "pane.report_metadata") return { result: {} };
      if (request.method === "agent.get") {
        const info = rootAgentInfo();
        info.result.agent.agent_session = { kind: "path", value: "/sessions/owning-root.jsonl" };
        return info;
      }
      if (request.method === "agent.prompt") return rejected ? { error: { code, message: "test rejection" } } : { result: {} };
      throw new Error(`Unexpected method ${request.method}`);
    });
    try {
      await runSupervisorTick({ stateDir: fixture.stateDir, herdr: client(mock) });
      assert.equal((await fixture.manifest()).workflows[0].lanes[0].completionReceipt.delivery, code === "agent_blocked" ? "pending" : "uncertain");
      rejected = false;
      await runSupervisorTick({ stateDir: fixture.stateDir, herdr: client(mock) });
      assert.equal(requestsFor(mock, "agent.prompt").length, code === "agent_blocked" ? 2 : 1);
    } finally { await mock.close(); await fixture.cleanup(); }
  }
});

test("receipt drain rejects foreign root bindings and stale lane incarnations", async () => {
  for (const mutate of [
    workflow => { workflow.taskBinding.rootPaneId = "foreign:p1"; },
    workflow => { workflow.taskBinding.workspaceId = "foreign"; },
    workflow => { workflow.lanes[0].completionReceipt.id = "old-incarnation"; },
    workflow => { workflow.lanes[0].completionReceipt.summary = ""; },
  ]) {
    const fixture = await receiptFixture();
    try {
      const manifest = await fixture.manifest(); mutate(manifest.workflows[0]);
      await writeFile(fixture.manifestPath, JSON.stringify(manifest));
      await runSupervisorTick({ stateDir: fixture.stateDir, herdr: { async request(method) {
        assert.equal(method, "pane.report_metadata"); return {};
      } } });
      assert.equal((await fixture.manifest()).workflows[0].lanes[0].completionReceipt.delivery, "pending");
    } finally { await fixture.cleanup(); }
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
