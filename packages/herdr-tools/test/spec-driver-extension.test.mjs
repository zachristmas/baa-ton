import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");
const { validateApprovalPolicy, approvalPolicyHash } = await jiti.import("../approval-policy.ts");

const launch = (provider, model) => ({ provider, model, thinking: "high", auth: "subscription" });

async function fixture({ grants = ["dispatch", "integrate"], reviewModel = "model-b" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "baa-spec-driver-"));
  const configDir = join(directory, "config");
  const parent = join(directory, "parent");
  const stateDir = join(parent, ".baa-ton", "herdr-orchestrator");
  const manifestPath = join(stateDir, "manifest.json");
  const rootPane = "w-spec:p1";
  const root = { target: rootPane, target_kind: "pane_id", pane_id: rootPane, workspace_id: "w-spec", agent_kind: "pi" };
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const policy = { version: 2, grants };
  await writeFile(
    join(parent, ".baa-ton", "config.json"),
    JSON.stringify({
      version: 1,
      approvalPolicy: policy,
      profiles: {
        implementation: { agentKind: "codex", launchProfile: launch("vendor-a", "model-a") },
        review: { agentKind: "claude", launchProfile: launch("vendor-b", reviewModel === "model-a" ? "model-a" : reviewModel) },
      },
    }),
  );
  if (reviewModel === "model-a") {
    const config = JSON.parse(await readFile(join(parent, ".baa-ton", "config.json"), "utf8"));
    config.profiles.review.launchProfile.provider = "vendor-a";
    await writeFile(join(parent, ".baa-ton", "config.json"), JSON.stringify(config));
  }
  await writeFile(
    join(parent, ".baa-ton", "spec.json"),
    JSON.stringify({
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      stages: { build: { profile: "implementation" }, review: { profile: "review", differentFrom: "build" } },
      items: [
        { id: "A", title: "Shipping discount", owns: ["src/a/**"], acceptance: { text: "Discount applies to shipping only.", tests: ["npm test"] } },
        { id: "B", title: "Report", dependsOn: ["A"], acceptance: { text: "Report lists discounts." } },
      ],
    }),
  );
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 2,
      approvalPolicyAck: { hash: approvalPolicyHash(validateApprovalPolicy(policy)), grants: policy.grants, ackedAt: "t", rootPaneId: rootPane },
      workflows: [],
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      version: 2,
      owner: "herdr-orchestrator",
      orchestrators: [{ id: "orchestrator-spec", root, program: { id: parent, workspace_id: "w-spec", parent_manifest_path: manifestPath }, workflows: [] }],
    }),
    { mode: 0o600 },
  );
  const saved = Object.fromEntries(["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: rootPane, HERDR_WORKSPACE_ID: "w-spec", HERDR_PLUGIN_CONFIG_DIR: configDir });
  const tools = new Map();
  extension({ on() {}, registerCommand() {}, registerTool: (definition) => tools.set(definition.name, definition), async exec() { throw new Error("no herdr in this test"); } });
  const calls = { worktree: [], plan: [], dispatch: [] };
  let planned = 0;
  const ports = {
    async worktree(input) {
      calls.worktree.push(input);
    },
    async plan(input) {
      calls.plan.push(input);
      planned += 1;
      return { id: `herdr-spec${planned}`, lanes: [{ id: "lane-1" }] };
    },
    async dispatch(workflowId) {
      calls.dispatch.push(workflowId);
      return { dispatched: true };
    },
    now: () => "2026-09-24T12:00:00.000Z",
  };
  const ctx = { cwd: parent, mode: "json", hasUI: false, ui: { confirm: async () => false, notify() {} }, specDriverPorts: ports };
  return {
    calls,
    advance: () => tools.get("herdr_spec").execute("spec", { action: "advance" }, undefined, undefined, ctx),
    status: () => tools.get("herdr_spec").execute("spec", { action: "status" }, undefined, undefined, ctx),
    state: async () => JSON.parse(await readFile(join(stateDir, "spec-state.json"), "utf8")),
    manifest: async () => JSON.parse(await readFile(manifestPath, "utf8")),
    async laneReceipt(workflowId, summary) {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.workflows.push({ id: workflowId, status: "completed", lanes: [{ id: "lane-1", status: "completion-reported", completionReceipt: { id: "r", summary, delivery: "delivered" } }], evidence: [] });
      await writeFile(manifestPath, JSON.stringify(manifest));
    },
    async cleanup() {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("the driver builds ready items in their own worktree, then reviews them in a fresh read-only lane", async () => {
  const f = await fixture();
  try {
    const first = await f.advance();
    assert.match(first.content[0].text, /Started: build A -> herdr-spec1\./);
    assert.match(first.content[0].text, /B waits: dependency: A/);
    assert.deepEqual(f.calls.worktree[0], {
      repo: join(f.calls.worktree[0].repo),
      path: f.calls.worktree[0].path,
      branch: "spec/A",
      base: "refs/remotes/origin/feature/release",
    });
    assert.match(f.calls.worktree[0].path, /spec-A$/);
    assert.equal(f.calls.plan[0].taskProfile, "implementation");
    assert.equal(f.calls.plan[0].readOnly, false);
    assert.match(f.calls.plan[0].laneObjective, /Implement spec item A: Shipping discount/);
    assert.deepEqual(f.calls.dispatch, ["herdr-spec1"]);
    let state = await f.state();
    assert.equal(state.items.A.state, "building");
    assert.deepEqual(state.items.A.lane, { workflowId: "herdr-spec1", laneId: "lane-1" });
    assert.equal(state.items.B.wait, "dependency: A");
    assert.match((await f.status()).content[0].text, /B\s+pending\s+-\s+-\s+waits: dependency: A/);

    // Nothing new while A builds.
    await f.advance();
    assert.equal(f.calls.dispatch.length, 1, "no duplicate dispatch while the build lane works");

    await f.laneReceipt("herdr-spec1", "Committed 1a2b3c on spec/A; npm test green.");
    const second = await f.advance();
    assert.match(second.content[0].text, /Started: review A -> herdr-spec2\./);
    assert.equal(f.calls.plan[1].taskProfile, "review");
    assert.equal(f.calls.plan[1].readOnly, true);
    assert.equal(f.calls.plan[1].worktree, f.calls.plan[0].worktree, "the reviewer reads the builder's worktree");
    assert.match(f.calls.plan[1].laneObjective, /The builder reported:\nCommitted 1a2b3c/);
    assert.equal(f.calls.worktree.length, 1, "a review creates no worktree");

    await f.laneReceipt("herdr-spec2", "VERDICT: PASS\nMatches the acceptance.");
    const third = await f.advance();
    assert.match(third.content[0].text, /Started: build B -> herdr-spec3\./, "B starts once A is integrating");
    state = await f.state();
    assert.equal(state.items.A.state, "integrating");
  } finally {
    await f.cleanup();
  }
});

test("a review profile on the builder's model blocks the item and asks the root", async () => {
  const f = await fixture({ reviewModel: "model-a" });
  try {
    await f.advance();
    await f.laneReceipt("herdr-spec1", "Committed.");
    const result = await f.advance();
    assert.match(result.content[0].text, /Needs you: A: the review profile must differ from build/);
    const state = await f.state();
    assert.equal(state.items.A.state, "blocked");
    assert.equal(state.items.A.blockedReason, "human-gate");
    assert.match(state.items.A.note, /same model as build \(vendor-a\/model-a\)/);
    assert.equal(f.calls.dispatch.length, 1, "no review lane was dispatched");
    const alerts = (await f.manifest()).rootSupervision[0].alerts;
    assert.equal(alerts.at(-1).kind, "spec-needs-root");
  } finally {
    await f.cleanup();
  }
});

test("without the dispatch and integrate grants the driver does nothing", async () => {
  const f = await fixture({ grants: ["dispatch"] });
  try {
    const result = await f.advance();
    assert.match(result.content[0].text, /Spec driver skipped: the spec driver needs the dispatch and integrate grants \(approvalPolicy does not grant integrate\)/);
    assert.equal(f.calls.plan.length, 0);
  } finally {
    await f.cleanup();
  }
});
