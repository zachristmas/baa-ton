import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const helper = fileURLToPath(new URL("../claude-startup-attest.mjs", import.meta.url));
const profile = { provider: "claude-code", model: "claude-sonnet-5", thinking: "high", auth: "subscription" };

async function fixture(run, mutate = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "baa-startup-context-"));
  try {
    const intentPath = join(directory, "intent.json");
    const intent = {
      version: 1, workflowId: "herdr-test", laneId: "lane-1",
      manifestDirectory: directory, workspaceId: "w22", paneId: "w22:p6",
      nonce: "test-nonce", source: "/source/index.ts", profile,
    };
    const lane = {
      id: "lane-1", agentKind: "claude", readOnly: false,
      paneId: intent.paneId, startupIntentPath: intentPath,
      startupNonce: intent.nonce, objective: "Implement the bounded local task. No deployment.",
    };
    const manifest = { version: 2, workflows: [{
      id: intent.workflowId, taskBinding: { workspaceId: "w22", rootPaneId: "w22:p1" },
      lanes: [lane],
    }] };
    mutate({ intent, lane, manifest });
    await writeFile(intentPath, JSON.stringify(intent), { mode: 0o600 });
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    const invoke = (env = {}, input = { session_id: "session-test", transcript_path: "/sessions/test.jsonl" }) => spawnSync(
      process.execPath, [helper], {
        env: { ...process.env, HERDR_ENV: "1", BAA_STARTUP_INTENT: intentPath,
          HERDR_PANE_ID: "w22:p6", HERDR_WORKSPACE_ID: "w22", ...env },
        input: JSON.stringify(input), encoding: "utf8",
        // Generous: the hermetic runner starts test files in parallel, and a
        // loaded machine can take seconds to boot Node. Status is still asserted.
        timeout: 30000,
      },
    );
    await run({ invoke, intentPath, lane });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("validated SessionStart injects the manifest assignment, without blanket paste authority", async () => {
  await fixture(async ({ invoke, intentPath, lane }) => {
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
    const context = output.hookSpecificOutput.additionalContext;
    assert.ok(context.includes(lane.objective));
    assert.match(context, /root pane: w22:p1/);
    assert.match(context, /no blanket trust/);
    assert.match(context, /permission checks remain in force/);
    assert.match(context, /never impersonate the human/);
    assert.equal(context.includes("test-nonce"), false);
    const ready = JSON.parse(await readFile(`${intentPath}.ready`, "utf8"));
    assert.equal(ready.sessionId, "session-test");
    assert.equal(ready.nonce, "test-nonce");
    assert.deepEqual(ready.operations, ["plan", "dispatch", "complete"]);
  });
});

test("startup context lists only this lane's active leases", async () => {
  await fixture(async ({ invoke }) => {
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /Runtime leases reserved for this lane/);
    assert.match(context, /- app = 3600-3603 \(lease-a\)/);
    assert.match(context, /- postgres:test = cic_test_lane_1_test \(lease-b\)/);
    assert.equal(context.includes("lease-other"), false);
    assert.equal(context.includes("lease-old"), false);
  }, ({ manifest, intent }) => {
    const base = { workflowId: intent.workflowId, laneId: intent.laneId, state: "active" };
    manifest.leases = [
      { ...base, id: "lease-a", resource: "app", label: "default", ports: [3600, 3601, 3602, 3603] },
      { ...base, id: "lease-b", resource: "postgres", label: "test", name: "cic_test_lane_1_test" },
      { ...base, id: "lease-old", resource: "redis", label: "default", ports: [6400], state: "released" },
      { ...base, id: "lease-other", laneId: "lane-2", resource: "app", label: "default", ports: [3604, 3605, 3606, 3607] },
    ];
  });
});

test("startup context has no lease section without leases", async () => {
  await fixture(async ({ invoke }) => {
    const context = JSON.parse(invoke().stdout).hookSpecificOutput.additionalContext;
    assert.equal(context.includes("Runtime leases"), false);
  });
});

test("read-only lanes retain their restriction in startup context", async () => {
  await fixture(({ invoke }) => {
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /Declared source-edit mode: read-only/);
  }, ({ lane }) => { lane.readOnly = true; });
});

for (const [name, mutate] of [
  ["nonce", ({ lane }) => { lane.startupNonce = "wrong"; }],
  ["pane", ({ lane }) => { lane.paneId = "w22:p7"; }],
  ["workspace", ({ manifest }) => { manifest.workflows[0].taskBinding.workspaceId = "w99"; }],
  ["intent path", ({ lane }) => { lane.startupIntentPath = "/different.json"; }],
  ["agent kind", ({ lane }) => { lane.agentKind = "codex"; }],
  ["lane id", ({ intent }) => { intent.laneId = "missing"; }],
  ["objective", ({ lane }) => { lane.objective = ""; }],
  ["partial binding", ({ intent }) => { delete intent.manifestDirectory; }],
]) {
  test(`mismatched ${name} cannot attest or inject context`, async () => {
    await fixture(async ({ invoke, intentPath }) => {
      const result = invoke();
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      await assert.rejects(readFile(`${intentPath}.ready`), { code: "ENOENT" });
    }, mutate);
  });
}

test("native pane mismatch or missing session fails without context", async () => {
  await fixture(({ invoke }) => {
    for (const result of [invoke({ HERDR_PANE_ID: "w99:p1" }), invoke({}, {})]) {
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
    }
  });
});

test("legacy unbound intent still attests but cannot authorize a task", async () => {
  await fixture(async ({ invoke, intentPath }) => {
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(await readFile(`${intentPath}.ready`, "utf8")).sessionId, "session-test");
  }, ({ intent }) => {
    delete intent.workflowId; delete intent.laneId; delete intent.manifestDirectory;
  });
});

test("resume without intent pane binds through matching session and manifest", async () => {
  await fixture(async ({ invoke, intentPath }) => {
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /herdr-test/);
    assert.equal(JSON.parse(await readFile(`${intentPath}.ready`, "utf8")).paneId, "w22:p6");
  }, ({ intent }) => {
    delete intent.paneId;
    intent.resumeSessionId = "session-test";
  });
});

for (const wrong of ["session", "manifest-pane", "missing-resume"]) {
  test(`resume cannot infer pane with ${wrong}`, async () => {
    await fixture(({ invoke }) => {
      const result = invoke();
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
    }, ({ intent, lane }) => {
      delete intent.paneId;
      if (wrong !== "missing-resume") intent.resumeSessionId = wrong === "session" ? "other" : "session-test";
      if (wrong === "manifest-pane") lane.paneId = "w22:p99";
    });
  });
}

test("no startup intent produces no task context", () => {
  const env = { ...process.env };
  delete env.BAA_STARTUP_INTENT;
  const result = spawnSync(process.execPath, [helper], { env, input: "{}", encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("a lane in its worktree's own workspace (laneWorkspaceId) attests; another workspace is still refused", async () => {
  // The live failure: the lane joined workspace w2G, where its worktree was
  // already open, while the task binding stays with the root's w22. The hook
  // checked only the root's workspace, refused, and wrote no identity.
  await fixture(async ({ invoke, intentPath }) => {
    const result = invoke({ HERDR_PANE_ID: "w2G:p2", HERDR_WORKSPACE_ID: "w2G" });
    assert.equal(result.status, 0, result.stderr);
    const ready = JSON.parse(await readFile(`${intentPath}.ready`, "utf8"));
    assert.equal(ready.sessionId, "session-test", "identity written: the attestation is complete");
    assert.equal(ready.workspaceId, "w2G");
  }, ({ intent, lane, manifest }) => {
    intent.workspaceId = "w2G";
    intent.paneId = "w2G:p2";
    lane.paneId = "w2G:p2";
    lane.workspaceId = "w2G";
    manifest.workflows[0].laneWorkspaceId = "w2G";
  });
  await fixture(async ({ invoke, intentPath }) => {
    const result = invoke({ HERDR_PANE_ID: "w9:p2", HERDR_WORKSPACE_ID: "w9" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /differs from the recorded manifest lane/);
    await assert.rejects(readFile(`${intentPath}.ready`, "utf8"));
  }, ({ intent, lane, manifest }) => {
    intent.workspaceId = "w9";
    intent.paneId = "w9:p2";
    lane.paneId = "w9:p2";
    manifest.workflows[0].laneWorkspaceId = "w2G";
  });
});
