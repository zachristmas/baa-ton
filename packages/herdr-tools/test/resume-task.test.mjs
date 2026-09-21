import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { resumeTask } = await jiti.import("../dispatch-task.ts");

const profile = {
  provider: "fixture-provider",
  model: "fixture-model",
  thinking: "high",
  auth: "subscription",
};

async function fixture({
  unsupported = false,
  badProof = false,
  wrongWorkspace = false,
  busyStarts = 0,
  startFailure = null,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "baa-resume-task-"));
  const calls = [];
  const panes = new Map();
  const sessionId = "fixture-session-1";
  const adapter = {
    version: 1,
    kind: "codex",
    capabilities: {
      startupAttestation: true,
      supportsSessionPersistence: true,
      supportsNativeSessionIdentity: true,
      ...(unsupported ? {} : { supportsSessionResume: true }),
    },
    lifecycle: "screen",
    preflight() {},
    launchArguments() {
      return [];
    },
    ...(unsupported
      ? {}
      : {
          resumeSessionId(session) {
            return session.sessionId;
          },
          resumeArguments(p, session) {
            return ["resume", session.sessionId, "--model", p.model];
          },
        }),
    verifyStartup(native, hello) {
      assert.equal(native.agent, "codex");
      return {
        paneId: hello.paneId,
        workspaceId: hello.workspaceId,
        nonce: hello.nonce,
        source: hello.source,
        profile: hello.profile,
        operations: badProof ? [] : ["plan", "dispatch", "complete"],
        session: { kind: "id", value: sessionId },
        persistence: {
          provider: profile.provider,
          sessionId,
          nativeHandle: { kind: "id", value: sessionId },
        },
      };
    },
  };
  let state = {
    id: "resume-workflow",
    objective: "Resume one native session",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "running",
    outcome: "running",
    cwd: root,
    worktree: root,
    taskBinding: { workspaceId: "task-workspace", rootPaneId: "root-pane" },
    launchProfile: profile,
    lanes: [
      {
        id: "lane-1",
        objective: "Continue the prior lane",
        readOnly: false,
        agentKind: "codex",
        agentName: "child-resume-1",
        paneId: "old-pane",
        tabId: "old-tab",
        status: "gone",
        persistenceHandle: { provider: profile.provider, sessionId },
        sessionLog: {
          kind: "lane",
          sessionRef: { provider: profile.provider, sessionId },
          startedAt: "2026-01-01T00:00:00.000Z",
          status: "gone",
          workflowId: "resume-workflow",
          laneId: "lane-1",
          paneId: "old-pane",
          tabId: "old-tab",
          workspaceId: "task-workspace",
          worktree: root,
        },
      },
    ],
    ownership: {
      createdBy: "herdr-orchestrator",
      workspaceId: "task-workspace",
      tabIds: ["old-tab"],
      paneIds: ["old-pane"],
    },
    evidence: [],
  };
  const ports = {
    directory: root,
    busyRetryDelayMs: 1,
    source: "/source/index.ts",
    adapter: () => adapter,
    verifyRoot: async () => {},
    authorize: async () => true,
    register: async (workflow, options) => {
      calls.push(["register", options, workflow.lanes[0].paneId]);
    },
    update: async (_id, mutate) => {
      mutate(state);
      return structuredClone(state);
    },
    async run(args) {
      calls.push(args);
      if (args[0] === "workspace")
        return {
          result: {
            workspace: {
              workspace_id: wrongWorkspace ? "other-workspace" : "task-workspace",
            },
          },
        };
      if (args[0] === "tab" && args[1] === "create") {
        const paneId = "new-pane";
        const tabId = "new-tab";
        panes.set(paneId, {
          paneId,
          tabId,
          intentPath: args[args.indexOf("--env") + 1].slice(
            "BAA_STARTUP_INTENT=".length,
          ),
        });
        return {
          result: {
            tab: { tab_id: tabId, workspace_id: "task-workspace" },
            root_pane: { pane_id: paneId, workspace_id: "task-workspace" },
          },
        };
      }
      if (args[0] === "pane" && args[1] === "get") {
        const pane = panes.get(args[2]);
        return {
          result: {
            pane: {
              pane_id: pane.paneId,
              tab_id: pane.tabId,
              workspace_id: "task-workspace",
            },
          },
        };
      }
      if (args[0] === "pane" && args[1] === "process-info")
        return {
          result: {
            process_info: {
              shell_pid: 123,
              foreground_processes: [{ pid: 123, name: "zsh" }],
            },
          },
        };
      if (args[0] === "agent" && args[1] === "start") {
        assert.deepEqual(
          args.slice(args.indexOf("--") + 1, args.indexOf("--") + 3),
          ["resume", sessionId],
        );
        if (busyStarts-- > 0) throw new Error("agent_pane_busy");
        if (startFailure) throw new Error(startFailure);
        const pane = panes.get(args[args.indexOf("--pane") + 1]);
        const intent = JSON.parse(await readFile(pane.intentPath, "utf8"));
        await writeFile(
          `${pane.intentPath}.ready`,
          JSON.stringify({
            nonce: intent.nonce,
            paneId: pane.paneId,
            workspaceId: "task-workspace",
            source: "/source/index.ts",
            profile,
            sessionId,
            operations: ["plan", "dispatch", "complete"],
          }),
        );
        return {};
      }
      if (args[0] === "agent" && args[1] === "get") {
        const pane = panes.get(args[2]);
        if (!pane) throw new Error("agent_not_found");
        return {
          result: {
            agent: {
              agent: "codex",
              pane_id: pane.paneId,
              workspace_id: "task-workspace",
              agent_status: "idle",
              agent_session: { kind: "id", value: sessionId },
            },
          },
        };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  };
  return { root, calls, ports, get state() { return state; }, set badProof(value) { badProof = value; }, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("native resume dry-run lists the durable session without topology effects", async () => {
  const f = await fixture();
  try {
    const result = await resumeTask(f.state, false, f.ports);
    assert.equal(result.dryRun, true);
    assert.equal(result.resumableLanes[0].sessionId, "fixture-session-1");
    assert.match(result.commands[0], /codex native resume/);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("native resume binds a fresh pane only after exact startup proof", async () => {
  const f = await fixture();
  try {
    const result = await resumeTask(f.state, true, f.ports);
    assert.equal(result.resumed, true);
    assert.deepEqual(result.resumedLanes, [{ laneId: "lane-1", sessionId: "fixture-session-1" }]);
    assert.equal(f.state.lanes[0].resume.status, "bound");
    assert.equal(f.state.lanes[0].sessionLog.status, "dispatched");
    assert.equal(f.state.lanes[0].sessionLog.startedAt, "2026-01-01T00:00:00.000Z");
    assert.notEqual(f.state.lanes[0].sessionLog.incarnationStartedAt, undefined);
    assert.equal(f.state.lanes[0].paneId, "new-pane");
    assert.equal(f.calls.some((call) => call[0] === "register" && call[1].allowLaneRebind), true);
  } finally {
    await f.cleanup();
  }
});

test("workspace identity mismatch fails closed before creating a tab", async () => {
  const f = await fixture({ wrongWorkspace: true });
  try {
    await assert.rejects(
      resumeTask(f.state, true, f.ports),
      /designated task workspace/,
    );
    assert.equal(f.calls.some((call) => call[0] === "tab"), false);
  } finally {
    await f.cleanup();
  }
});

test("missing native resume methods fail closed before creating a tab", async () => {
  const f = await fixture({ unsupported: true });
  try {
    await assert.rejects(
      resumeTask(f.state, true, f.ports),
      /native session resume is unsupported/,
    );
    assert.equal(f.calls.some((call) => call[0] === "tab"), false);
  } finally {
    await f.cleanup();
  }
});

test("startup proof gates native reattachment", async () => {
  const f = await fixture({ badProof: true });
  try {
    await assert.rejects(
      resumeTask(f.state, true, f.ports),
      /native resume startup proof does not match/,
    );
    assert.notEqual(f.state.lanes[0].resume.status, "bound");
    assert.equal(f.state.lanes[0].sessionLog.status, "gone");
  } finally {
    await f.cleanup();
  }
});

test("resume rechecks shell readiness after a pre-launch busy rejection in the same pane", async () => {
  const f = await fixture({ busyStarts: 1 });
  try {
    assert.equal((await resumeTask(f.state, true, f.ports)).resumed, true);
    const starts = f.calls.filter(c => c[0] === "agent" && c[1] === "start");
    assert.equal(starts.length, 2);
    assert.deepEqual(starts[0], starts[1]);
    for (const start of starts) {
      const prior = f.calls[f.calls.indexOf(start) - 1];
      assert.deepEqual(prior, ["pane", "process-info", "--pane", "new-pane"]);
    }
    assert.equal(f.calls.filter(c => c[0] === "tab" && c[1] === "create").length, 1);
    assert.equal(f.calls.some(c => c[1] === "prompt"), false);
  } finally { await f.cleanup(); }
});

for (const [failure, attempts] of [["agent_pane_busy", 3], ["socket_timeout after launch", 1], ["agent_not_ready", 1]]) {
  test(`resume bounds starts and never resends an assignment after ${failure}`, async () => {
    const f = await fixture({ startFailure: failure });
    try {
      await assert.rejects(resumeTask(f.state, true, f.ports), e => e.message.includes(failure));
      assert.equal(f.calls.filter(c => c[0] === "agent" && c[1] === "start").length, attempts);
      assert.equal(f.calls.filter(c => c[0] === "tab" && c[1] === "create").length, 1);
      assert.equal(f.calls.some(c => c[1] === "prompt"), false);
      assert.ok(f.state.lanes[0].resumeAgentStartAttemptedAt);
    } finally { await f.cleanup(); }
  });
}
