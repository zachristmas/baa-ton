import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const {
  childAgentName,
  dispatchTask,
  laneSlug,
  laneTabLabel,
  resumeTask,
} = await jiti.import("../dispatch-task.ts");
const { piLaunchAdapter } = await jiti.import("../pi-launch-adapter.ts");
const { claudeLaunchAdapter } = await jiti.import(
  "../claude-launch-adapter.ts",
);
const { HarnessAdapterRegistry, PROTOCOL_OPERATIONS } = await jiti.import(
  "../harness-adapter.ts",
);
const profile = {
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  thinking: "high",
  auth: "subscription",
};
async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "baa-dispatch-"));
  const calls = [],
    panes = new Map();
  const launchProfile = options.profile ?? profile;
  const laneProfiles = options.laneProfiles ?? [];
  const profileForLane = (index) => laneProfiles[index] ?? launchProfile;
  let number = 0,
    registered = false;
  let state = {
    id: "wf",
    status: "planned",
    outcome: "planned",
    cwd: "/different/checkout",
    taskBinding: { workspaceId: "task-space", rootPaneId: "root-pane" },
    launchProfile,
    lanes: [1, 2].map((i) => ({
      id: `lane-${i}`,
      objective: i === 1
        ? "Review startup handshake sequencing"
        : "Verify durable assignment routing",
      agentKind: options.adapter?.kind ?? "pi",
      status: "planned",
      ...(laneProfiles[i - 1]
        ? { launchProfile: laneProfiles[i - 1], launchProfileVersion: 1 }
        : {}),
    })),
    ownership: { createdBy: "herdr-orchestrator", tabIds: [], paneIds: [] },
    evidence: [],
  };
  const ctx = {
    modelRegistry: {
      refresh: async () => ({
        errors: options.discoveryFailure
          ? new Map([[launchProfile.provider, new Error("provider unavailable")]])
          : new Map(),
      }),
      find: (provider, model) =>
      provider === launchProfile.provider && model === launchProfile.model
        || laneProfiles.some(
          (laneProfile) =>
            provider === laneProfile.provider && model === laneProfile.model,
        )
          ? {
              reasoning: true,
              thinkingLevelMap: options.thinkingLevelMap ?? {
                high: "high",
                xhigh: "xhigh",
                max: "max",
              },
            }
          : undefined,
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => options.oauth !== false,
    },
  };
  const registry = new HarnessAdapterRegistry();
  registry.register(options.adapter ?? piLaunchAdapter(ctx, "/native/pi.ts"));
  const ports = {
    directory,
    source: "/source/index.ts",
    adapter: (kind) => registry.resolve(kind),
    busyRetryDelayMs: 1,
    update: async (_id, change) => {
      change(state);
      return structuredClone(state);
    },
    verifyRoot: async (w) => {
      if (w.taskBinding?.workspaceId !== "task-space")
        throw new Error("root workspace mismatch");
    },
    authorize: async () => true,
    register: async () => {
      calls.push(["register"]);
      if (options.noRouting) throw new Error("routing unavailable");
      registered = true;
    },
    contract: (_w, lane) => `assignment:${lane.id}`,
    async run(args) {
      calls.push(args);
      if (args[0] === "workspace" && args[1] === "get") {
        if (options.missingWorkspace) throw new Error("workspace_not_found");
        return { result: { workspace: { workspace_id: "task-space" } } };
      }
      if (args[0] === "tab" && args[1] === "create") {
        assert.equal(args[args.indexOf("--workspace") + 1], "task-space");
        assert.equal(args[args.indexOf("--cwd") + 1], "/different/checkout");
        const paneId = `opaque-pane-${++number}`,
          tabId = `opaque-tab-${number}`;
        panes.set(paneId, {
          paneId,
          tabId,
          intentPath: args[args.indexOf("--env") + 1].slice(
            "BAA_STARTUP_INTENT=".length,
          ),
        });
        return {
          result: { tab: { tab_id: tabId }, root_pane: { pane_id: paneId } },
        };
      }
      if (args[0] === "pane" && args[1] === "get") {
        const p = panes.get(args[2]);
        return {
          result: {
            pane: {
              pane_id: p.paneId,
              tab_id: p.tabId,
              workspace_id: options.wrongWorkspace ? "other" : "task-space",
            },
          },
        };
      }
      if (args[0] === "pane" && args[1] === "process-info") {
        const p = panes.get(args[3]);
        p.processInfoCalls = (p.processInfoCalls ?? 0) + 1;
        if (p.processInfoCalls <= (options.shellInits ?? 0))
          return {
            result: {
              process_info: {
                foreground_processes: [{ pid: 999, name: "bash" }],
              },
            },
          };
        return {
          result: {
            process_info: {
              shell_pid: 123,
              foreground_processes: [{ pid: 123, name: "zsh" }],
            },
          },
        };
      }
      if (args[0] === "agent" && args[1] === "start") {
        assert.equal(
          registered,
          true,
          "route is established before start, not after assignment",
        );
        const p = panes.get(args[args.indexOf("--pane") + 1]);
        const laneIndex = [...panes.values()].indexOf(p);
        const selectedProfile = profileForLane(laneIndex);
        assert.equal(args[args.indexOf("--model") + 1], selectedProfile.model);
        if (args.includes("--provider"))
          assert.equal(
            args[args.indexOf("--provider") + 1],
            selectedProfile.provider,
          );
        for (const flag of ["--thinking", "--effort"])
          if (args.includes(flag))
            assert.equal(args[args.indexOf(flag) + 1], selectedProfile.thinking);
        if (p.unrelated) throw new Error("agent_pane_busy: unrelated occupant");
        if (options.startSilentOnce) {
          options.startSilentOnce = false;
          p.absent = true;
          return {};
        }
        if (options.startCrashesOnce) {
          options.startCrashesOnce = false;
          p.absent = true;
          throw new Error("spawn crashed: unexpected server error");
        }
        if (options.busy) {
          options.busy = false;
          throw new Error("agent_pane_busy");
        }
        if (options.busyAlways) throw new Error("agent_pane_busy");
        if (options.notReadyOnce) {
          options.notReadyOnce = false;
          throw new Error(
            "agent_not_ready: agent is blocked during startup and is not ready for prompts",
          );
        }
        const intent = JSON.parse(await readFile(p.intentPath, "utf8"));
        p.sessionGeneration = (p.sessionGeneration ?? 0) + 1;
        const hello = {
          nonce: intent.nonce,
          paneId: p.paneId,
          workspaceId: "task-space",
          source: ports.source,
          sessionPath: `/sessions/${p.paneId}-${p.sessionGeneration}.jsonl`,
          profile: selectedProfile,
          tools: options.nativeTools ?? [
            "herdr_complete",
            "herdr_plan",
            "herdr_dispatch",
          ],
        };
        options.changeHello?.(hello);
        p.session = hello.sessionId ?? hello.sessionPath;
        p.sessionKind = hello.sessionId && !hello.sessionPath ? "id" : "path";
        delete p.absent;
        await writeFile(`${p.intentPath}.ready`, JSON.stringify(hello));
        return {};
      }
      if (args[0] === "agent" && args[1] === "send-keys") {
        const p = panes.get(args[2]);
        assert.equal(args[3], "ctrl+c");
        if (options.unrelatedAfterRestart) {
          p.unrelated = true;
          p.absent = false;
          p.session = "/sessions/unrelated.jsonl";
          p.sessionKind = "path";
        } else p.absent = true;
        return {};
      }
      if (args[0] === "agent" && args[1] === "get") {
        const p = panes.get(args[2]);
        if (p.absent) throw new Error("agent_not_found");
        return {
          result: {
            agent: {
              pane_id: p.paneId,
              workspace_id: "task-space",
              agent: options.adapter?.kind ?? "pi",
              agent_session: {
                kind: p.sessionKind ?? "path",
                value: options.unrelatedSession
                  ? "/sessions/unrelated"
                  : p.session,
              },
            },
          },
        };
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        assert.equal(registered, true);
        if (args[3]?.startsWith("assignment:"))
          assert.ok(
            state.lanes.every((l) => l.nativeSession),
            "all startup proofs precede every assignment",
          );
        if (args[3]?.startsWith("assignment:")) {
          assert.deepEqual(args.slice(4), ["--wait", "--until", "working",
            "--until", "blocked", "--until", "done", "--timeout", "10000"]);
          if (options.stalledPrompt)
            throw new Error("agent_prompt_stalled: no working or blocked state observed");
        }
        if (options.lostPrompt)
          throw new Error("socket_timeout after submitted");
        return {};
      }
      throw new Error(
        `Forbidden/unexpected native mutation: ${args.join(" ")}`,
      );
    },
  };
  return {
    options,
    get state() {
      return state;
    },
    set state(value) {
      state = value;
    },
    calls,
    panes,
    ctx,
    ports,
    run: (options = {}) =>
      dispatchTask(structuredClone(state), true, ports, undefined, options),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("lane slugs strip stopwords, keep five significant words, and stay capped", () => {
  assert.equal(
    laneSlug("Add a deterministic lane tab label for review"),
    "add-deterministic-lane-tab-label",
  );
  assert.equal(laneSlug("the and with"), "lane");
  assert.equal(
    laneSlug("A very long objective with enough words to exceed the label cap"),
    "very-long-objective-enough-words",
  );
  assert.ok(laneSlug("A remarkably lengthy objective that should be capped").length <= 32);
});

test("workflow short IDs use the generated UUID prefix in child agent names", () => {
  assert.equal(childAgentName("herdr-b5cc61d5-ignored-suffix", 1), "child-b5cc61d5-1");
});

test("a retryable workflow observed as unknown remains dispatchable", async () => {
  const f = await fixture();
  try {
    f.state.status = "unknown";
    f.state.outcome = "unknown";
    f.state.retry = {
      state: "retryable",
      attempt: 1,
      retryCommand: "herdr_dispatch wf execute=true",
      failedStage: "startup-proof",
      error: "startup proof mismatch",
    };
    assert.equal((await f.run()).dispatched, true);
  } finally {
    await f.close();
  }
});

test("opaque IDs and different checkout still produce only tabs in one designated workspace", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run()).dispatched, true);
    assert.equal(f.state.ownership.workspaceId, "task-space");
    assert.equal(f.state.ownership.paneIds.length, 2);
    assert.deepEqual(
      f.calls
        .filter((call) => call[0] === "tab" && call[1] === "create")
        .map((call) => call[call.indexOf("--label") + 1]),
      [
        laneTabLabel("Review startup handshake sequencing"),
        laneTabLabel("Verify durable assignment routing"),
      ],
    );
    assert.deepEqual(
      f.state.lanes.map((lane) => lane.agentName),
      ["child-wf-1", "child-wf-2"],
    );
    assert.ok(f.state.lanes.every((lane) => lane.sessionLog));
    assert.deepEqual(
      f.state.lanes.map((lane) => lane.sessionLog.sessionRef),
      f.state.lanes.map((lane) => lane.persistenceHandle),
    );
    assert.ok(
      f.state.lanes.every(
        (lane) => lane.sessionLog.startedAt === lane.agentStartedAt,
      ),
    );
    assert.ok(f.state.lanes.every((lane) => lane.sessionLog.status === "working"));
    assert.equal(f.calls.filter((c) => c[1] === "prompt").length, 2);
    assert.equal(
      f.calls.some((c) => c[0] === "workspace" && c[1] !== "get"),
      false,
    );
  } finally {
    await f.close();
  }
});
test("shell-init race and a busy rejection self-heal within one dispatch", async () => {
  const f = await fixture({ busy: true, shellInits: 3 });
  try {
    assert.equal((await f.run()).dispatched, true);
    assert.equal(f.state.ownership.paneIds.length, 2);
    assert.equal(
      f.calls.filter((c) => c[0] === "tab" && c[1] === "create").length,
      2,
    );
    assert.equal(f.calls.filter((c) => c[1] === "prompt").length, 2);
  } finally {
    await f.close();
  }
});

test("adapter startup handshakes are sent exactly once before startup proof and assignment", async () => {
  const base = piLaunchAdapter(
    {
      modelRegistry: {
        refresh: async () => ({ errors: new Map() }),
        find: () => ({ reasoning: true, thinkingLevelMap: { high: "high" } }),
        hasConfiguredAuth: () => true,
        isUsingOAuth: () => true,
      },
    },
    "/native/pi.ts",
  );
  const f = await fixture({
    adapter: { ...base, startupHandshake: "Reply with exactly: READY" },
  });
  try {
    assert.equal((await f.run()).dispatched, true);
    const prompts = f.calls.filter(
      (call) => call[0] === "agent" && call[1] === "prompt",
    );
    assert.deepEqual(prompts.map((call) => call[3]), [
      "Reply with exactly: READY",
      "Reply with exactly: READY",
      "assignment:lane-1",
      "assignment:lane-2",
    ]);
    assert.equal(f.state.lanes[0].startupHandshakeAttemptedAt !== undefined, true);
    assert.equal(f.state.lanes[0].startupHandshakeSentAt !== undefined, true);
  } finally {
    await f.close();
  }
});

test("an uncertain startup handshake is fenced and never submitted twice", async () => {
  const base = piLaunchAdapter(
    {
      modelRegistry: {
        refresh: async () => ({ errors: new Map() }),
        find: () => ({ reasoning: true, thinkingLevelMap: { high: "high" } }),
        hasConfiguredAuth: () => true,
        isUsingOAuth: () => true,
      },
    },
    "/native/pi.ts",
  );
  const f = await fixture({
    adapter: { ...base, startupHandshake: "Reply with exactly: READY" },
    lostPrompt: true,
  });
  try {
    await assert.rejects(f.run(), /socket_timeout after submitted/);
    const handshakePrompts = () =>
      f.calls.filter(
        (call) =>
          call[0] === "agent" &&
          call[1] === "prompt" &&
          call[3] === "Reply with exactly: READY",
      );
    assert.equal(handshakePrompts().length, 1);
    f.options.lostPrompt = false;
    await assert.rejects(
      f.run(),
      /Startup handshake submission is uncertain; do not repeat terminal input/,
    );
    assert.equal(handshakePrompts().length, 1);
  } finally {
    await f.close();
  }
});

test("persistent busy still fails closed and remains retryable in the same tabs", async () => {
  const f = await fixture({ busyAlways: true });
  try {
    await assert.rejects(f.run(), /agent_pane_busy/);
    assert.equal(
      f.calls.some((c) => c[1] === "prompt"),
      false,
    );
    const ids = [...f.state.ownership.paneIds];
    f.options.busyAlways = false;
    assert.equal((await f.run()).dispatched, true);
    assert.deepEqual(f.state.ownership.paneIds, ids);
    assert.equal(
      f.calls.filter((c) => c[0] === "tab" && c[1] === "create").length,
      2,
    );
  } finally {
    await f.close();
  }
});
for (const [label, options, message] of [
  ["missing workspace", { missingWorkspace: true }, /workspace_not_found/],
  ["workspace drift", { wrongWorkspace: true }, /outside its designated/],
  ["routing unavailable", { noRouting: true }, /routing unavailable/],
  ["unrelated replacement", { unrelatedSession: true }, /mismatch/],
  [
    "model mismatch",
    { changeHello: (h) => (h.profile = { ...profile, model: "not-luna" }) },
    /mismatch/,
  ],
  ["missing tools", { changeHello: (h) => (h.tools = []) }, /mismatch/],
  ["API-key fallback", { oauth: false }, /subscription authentication/],
])
  test(`${label} fails closed before work assignment`, async () => {
    const f = await fixture(options);
    try {
      await assert.rejects(f.run(), message);
      assert.equal(
        f.calls.some((c) => c[1] === "prompt"),
        false,
      );
    } finally {
      await f.close();
    }
  });
test("uncertain assignment retry does not type a second prompt or create replacement topology", async () => {
  const f = await fixture({ lostPrompt: true });
  try {
    await assert.rejects(f.run(), /socket_timeout/);
    await assert.rejects(f.run(), /submission is uncertain/);
    assert.equal(f.calls.filter((c) => c[1] === "prompt").length, 1);
    assert.equal(
      f.calls.filter((c) => c[0] === "tab" && c[1] === "create").length,
      2,
    );
  } finally {
    await f.close();
  }
});
test("explicitly unsupported thinking level fails closed before topology", async () => {
  const f = await fixture({ thinkingLevelMap: { high: null } });
  try {
    await assert.rejects(f.run(), /Thinking level high is unsupported/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.state.ownership.paneIds, []);
  } finally {
    await f.close();
  }
});

test("absent thinking level dispatches under runtime attestation", async () => {
  // Live-proven 2026-09-15: gpt-5.6-luna served a turn at "high" though its
  // catalog map lacks the entry. Only explicit null declares unsupported.
  const f = await fixture({
    thinkingLevelMap: { minimal: "minimal", xhigh: "xhigh", max: "max" },
  });
  try {
    assert.equal((await f.run()).dispatched, true);
    assert.equal(f.calls.filter((c) => c[1] === "prompt").length, 2);
    assert.equal(
      f.state.evidence.filter((entry) => entry.kind === "capability-discovery").length,
      2,
    );
  } finally {
    await f.close();
  }
});

test("a live capability discovery failure fails closed before topology", async () => {
  const f = await fixture({ discoveryFailure: true });
  try {
    await assert.rejects(f.run(), /Capability discovery failed.*provider unavailable/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.state.ownership.paneIds, []);
  } finally {
    await f.close();
  }
});

test("lane launch profiles override the version-1 workflow fallback independently", async () => {
  const f = await fixture({
    laneProfiles: [
      { ...profile, thinking: "xhigh" },
      { ...profile, thinking: "max" },
    ],
  });
  try {
    assert.equal((await f.run()).dispatched, true);
    const starts = f.calls.filter((call) => call[0] === "agent" && call[1] === "start");
    assert.deepEqual(
      starts.map((call) => call[call.indexOf("--thinking") + 1]),
      ["xhigh", "max"],
    );
    assert.deepEqual(
      f.state.lanes.map((lane) => lane.launchProfile.thinking),
      ["xhigh", "max"],
    );
  } finally {
    await f.close();
  }
});

test("an orchestrator restart rebinds every lane to a fresh incarnation", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run()).dispatched, true);
    const before = f.state.lanes.map((lane) => lane.nativeSession.value);
    assert.equal((await f.run({ restart: true })).dispatched, true);
    const after = f.state.lanes.map((lane) => lane.nativeSession.value);
    assert.notDeepEqual(after, before);
    assert.equal(
      f.calls.filter((call) => call[0] === "agent" && call[1] === "send-keys").length,
      2,
    );
    assert.ok(f.state.lanes.every((lane) => lane.restart.status === "bound"));
    assert.ok(
      f.state.lanes.every((lane) => lane.incarnationRevision === 2),
      "the new sessions are a durable authorized incarnation, not a pane alias",
    );
  } finally {
    await f.close();
  }
});

test("an unrelated occupant after restart authorization never inherits the lane", async () => {
  const f = await fixture({ unrelatedAfterRestart: true });
  try {
    assert.equal((await f.run()).dispatched, true);
    await assert.rejects(
      f.run({ restart: true }),
      /agent_pane_busy|unrelated occupant/,
    );
    assert.equal(f.calls.filter((call) => call[1] === "prompt").length, 2);
    assert.equal(
      f.state.lanes.some((lane) => lane.status === "running"),
      false,
      "the failed rebind must not assign work to the unrelated process",
    );
  } finally {
    await f.close();
  }
});

test("unqualified harnesses and unsupported exact profiles never launch", async () => {
  const f = await fixture();
  try {
    f.state.lanes[0].agentKind = "claude";
    await assert.rejects(f.run(), /no qualified startup adapter/);
    f.state.lanes[0].agentKind = "pi";
    f.state.launchProfile = { ...profile, model: "made-up" };
    await assert.rejects(f.run(), /Exact installed model not found/);
    f.state.launchProfile = { ...profile, provider: "openai" };
    await assert.rejects(f.run(), /subscription launch adapter/);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("registry rejects an adapter missing session persistence before topology mutation", async () => {
  const adapter = {
    version: 1,
    kind: "missing-persistence",
    capabilities: { startupAttestation: true },
    lifecycle: "unavailable",
    preflight: () => {},
    launchArguments: () => [],
    verifyStartup: () => {
      throw new Error("startup proof must not be reached");
    },
  };
  const f = await fixture({ adapter });
  try {
    await assert.rejects(f.run(), /supportsSessionPersistence/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.state.ownership.paneIds, []);
  } finally {
    await f.close();
  }
});

test("a non-Pi ID-session adapter with native tool names plugs into unchanged dispatch sequencing", async () => {
  // Synthetic adapter contract proof; NOT live Codex qualification.
  let preflights = 0,
    proofs = 0;
  const nativeToolOperations = {
    "codex.plan": PROTOCOL_OPERATIONS.plan,
    "codex.dispatch": PROTOCOL_OPERATIONS.dispatch,
    "codex.complete": PROTOCOL_OPERATIONS.complete,
  };
  const adapter = {
    version: 1,
    kind: "codex",
    capabilities: {
      startupAttestation: true,
      supportsSessionPersistence: true,
      supportsNativeSessionIdentity: true,
      supportsSyntheticNativeTools: true,
    },
    lifecycle: "screen",
    preflight: () => {
      preflights++;
    },
    launchArguments: (p) => [
      "--model",
      p.model,
      "--provider",
      p.provider,
      "--thinking",
      p.thinking,
    ],
    verifyStartup: (native, hello) => {
      assert.equal(native.agent, "codex");
      assert.equal(native.agent_session.kind, "id");
      assert.equal(native.agent_session.value, hello.sessionId);
      proofs++;
      return {
        ...hello,
        operations: hello.tools
          .map((tool) => nativeToolOperations[tool])
          .filter(Boolean),
        session: { kind: "id", value: hello.sessionId },
      };
    },
  };
  const f = await fixture({
    adapter,
    nativeTools: ["codex.plan", "codex.dispatch", "codex.complete"],
    changeHello: (h) => {
      h.sessionId = `native-id:${h.paneId}`;
      delete h.sessionPath;
    },
  });
  try {
    await f.run();
    assert.equal(preflights, 2);
    assert.equal(proofs, 2);
    assert.ok(
      f.state.lanes.every(
        (l) => l.nativeSession.kind === "id" && !l.agentSessionPath,
      ),
    );
    assert.equal(f.calls.filter((c) => c[1] === "prompt").length, 2);
    assert.equal(
      f.calls.some((c) => c[0] === "workspace" && c[1] !== "get"),
      false,
    );
  } finally {
    await f.close();
  }
});

test("claude adapter dispatches through unchanged sequencing with its own attestation", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "baa-claude-scratch-"));
  const adapter = claudeLaunchAdapter({
    bridge: "/bridge/mcp-server.mjs",
    attestHelper: "/bridge/claude-startup-attest.mjs",
    scratchDirectory: scratch,
  });
  const f = await fixture({
    adapter,
    profile: {
      provider: "claude-code",
      model: "claude-sonnet-5",
      thinking: "high",
      auth: "subscription",
    },
    changeHello: (hello) => {
      // Claude attestation shape: SessionStart hook identity + bridge-merged
      // protocol operations, no Pi tool names anywhere.
      delete hello.tools;
      hello.operations = ["plan", "dispatch", "complete"];
    },
  });
  try {
    assert.equal((await f.run()).dispatched, true);
    assert.ok(f.state.lanes.every((l) => l.nativeSession.kind === "path"));
    const start = f.calls.find((c) => c[1] === "start");
    assert.equal(start[start.indexOf("--model") + 1], "claude-sonnet-5");
    assert.equal(start[start.indexOf("--effort") + 1], "high");
    const settings = JSON.parse(
      await readFile(start[start.indexOf("--settings") + 1], "utf8"),
    );
    assert.match(
      settings.hooks.SessionStart[0].hooks[0].command,
      /claude-startup-attest\.mjs/,
    );
    assert.equal(f.calls.filter((c) => c[1] === "prompt").length, 2);
  } finally {
    await f.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("startup-blocked lane is adopted on retry once its attestation appears", async () => {
  const f = await fixture({ notReadyOnce: true });
  try {
    await assert.rejects(f.run(), /agent_not_ready/);
    assert.equal(
      f.calls.some((c) => c[1] === "prompt"),
      false,
    );
    // Operator unblocks the harness; its SessionStart hook writes the
    // attestation for the blocked lane and its native session appears.
    const blocked = f.state.lanes[0];
    const pane = [...f.panes.values()].find((p) => p.paneId === blocked.paneId);
    const intent = JSON.parse(
      await readFile(blocked.startupIntentPath, "utf8"),
    );
    pane.session = `/sessions/${pane.paneId}.jsonl`;
    await writeFile(
      `${blocked.startupIntentPath}.ready`,
      JSON.stringify({
        nonce: intent.nonce,
        paneId: pane.paneId,
        workspaceId: "task-space",
        source: f.ports.source,
        profile: { ...profile },
        sessionPath: pane.session,
        tools: ["herdr_complete", "herdr_plan", "herdr_dispatch"],
      }),
    );
    assert.equal((await f.run()).dispatched, true);
    // One blocked attempt plus one fresh start for the untouched lane.
    assert.equal(f.calls.filter((c) => c[1] === "start").length, 2);
    assert.equal(f.calls.filter((c) => c[1] === "prompt").length, 2);
    assert.equal(f.state.ownership.paneIds.length, 2);
  } finally {
    await f.close();
  }
});

test("started-then-vanished lane restarts fresh once when unattested", async () => {
  const f = await fixture({ startSilentOnce: true });
  try {
    await assert.rejects(f.run(), /agent_not_found/);
    assert.equal((await f.run()).dispatched, true);
    assert.equal(f.calls.filter((c) => c[1] === "start").length, 3);
    assert.equal(f.calls.filter((c) => c[1] === "prompt").length, 2);
  } finally {
    await f.close();
  }
});

test("attested lane that vanished fails closed", async () => {
  const f = await fixture({ startSilentOnce: true });
  try {
    await assert.rejects(f.run(), /agent_not_found/);
    const lane = f.state.lanes[0];
    const intent = JSON.parse(await readFile(lane.startupIntentPath, "utf8"));
    await writeFile(
      `${lane.startupIntentPath}.ready`,
      JSON.stringify({
        nonce: intent.nonce,
        paneId: lane.paneId,
        workspaceId: "task-space",
        source: f.ports.source,
        profile: { ...profile },
        sessionPath: `/sessions/${lane.paneId}.jsonl`,
        tools: ["herdr_complete", "herdr_plan", "herdr_dispatch"],
      }),
    );
    await assert.rejects(f.run(), /attested but its agent vanished/);
  } finally {
    await f.close();
  }
});

test("dispatch lock reclaims a dead owner and fails closed on live or unknown owners", async () => {
  const deadOwner = await fixture();
  try {
    const lockDir = join(deadOwner.ports.directory, "wf.dispatch-lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: 999_999_999 }),
    );
    assert.equal((await deadOwner.run()).dispatched, true);
  } finally {
    await deadOwner.close();
  }
  const liveOwner = await fixture();
  try {
    const lockDir = join(liveOwner.ports.directory, "wf.dispatch-lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: process.pid }),
    );
    await assert.rejects(liveOwner.run(), /already active/);
  } finally {
    await liveOwner.close();
  }
  const unknownOwner = await fixture();
  try {
    const lockDir = join(unknownOwner.ports.directory, "wf.dispatch-lock");
    await mkdir(lockDir, { recursive: true });
    await assert.rejects(unknownOwner.run(), /verifiable owner/);
  } finally {
    await unknownOwner.close();
  }
});

test("crashed lane start retries fresh when the pane holds no agent", async () => {
  const f = await fixture({ startCrashesOnce: true });
  try {
    await assert.rejects(f.run(), /spawn crashed/);
    assert.equal(
      f.calls.some((c) => c[1] === "prompt"),
      false,
    );
    // The retry finds no attestation and no live occupant: fresh start.
    assert.equal((await f.run()).dispatched, true);
    assert.equal(f.calls.filter((c) => c[1] === "start").length, 3);
    assert.equal(f.calls.filter((c) => c[1] === "prompt").length, 2);
    assert.equal(f.state.ownership.paneIds.length, 2);
  } finally {
    await f.close();
  }
});

test("stalled assignment remains uncertain and cannot be automatically resubmitted", async () => {
  const f = await fixture({ stalledPrompt: true });
  try {
    await assert.rejects(f.run(), /agent_prompt_stalled/);
    assert.equal(f.state.status, "dispatch-failed");
    assert.equal(f.state.outcome, "unknown");
    assert.ok(f.state.lanes[0].promptAttemptedAt);
    assert.equal(f.state.lanes[0].promptedAt, undefined);
    assert.equal(f.state.lanes[1].promptAttemptedAt, undefined);
    const topology = structuredClone(f.state.ownership);
    await assert.rejects(f.run(), /submission is uncertain/);
    assert.equal(f.calls.filter(c => c[1] === "prompt").length, 1);
    assert.deepEqual(f.state.ownership, topology);
  } finally { await f.close(); }
});
