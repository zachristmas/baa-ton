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

async function fixture({ grants = ["dispatch", "integrate"], reviewModel = "model-b", decide = false } = {}) {
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
      stages: { ...(decide ? { decide: { profile: "planning" } } : {}), build: { profile: "implementation" }, review: { profile: "review", differentFrom: "build" } },
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
  const pushedShas = new Set();
  const ports = {
    async ancestor(_repo, sha, ref) {
      calls.ancestor = [...(calls.ancestor ?? []), ref];
      return pushedShas.has(sha);
    },
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
    pushedShas,
    stateDir,
    tools,
    ctx,
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
    assert.match(third.content[0].text, /Started: integrate A -> herdr-spec3; build B -> herdr-spec4\./, "A's merge and B's build start together");
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

test("integration: one merge lane on spec-integration, then a push prompt, then verification once pushed", async () => {
  const f = await fixture();
  const sha = "c".repeat(40);
  try {
    await f.advance();
    await f.laneReceipt("herdr-spec1", "Committed.");
    await f.advance();
    await f.laneReceipt("herdr-spec2", "VERDICT: PASS");
    await f.advance();
    const merge = f.calls.plan.find((call) => call.specStage === "integrate");
    assert.equal(merge.taskProfile, "balanced");
    assert.equal(merge.readOnly, false);
    assert.match(merge.worktree, /spec-integration$/);
    assert.match(merge.laneObjective, /git merge --no-ff spec\/A/);
    const integration = f.calls.worktree.find((call) => call.branch === "spec-integration");
    assert.equal(integration.base, "refs/remotes/origin/feature/release");
    assert.match(integration.path, /spec-integration$/);

    // A migration slot reserved by A's build lane is released once A is integrated.
    const withLease = await f.manifest();
    withLease.leases = [
      { id: "lease-m1", resource: "migration", label: "default", kind: "sequence", number: 56, digits: 4, workflowId: "herdr-spec1", laneId: "lane-1", state: "active", grantedBy: "lane-policy", grantedAt: "t" },
      { id: "lease-m2", resource: "migration", label: "default", kind: "sequence", number: 57, digits: 4, workflowId: "herdr-other", laneId: "lane-1", state: "active", grantedBy: "lane-policy", grantedAt: "t" },
    ];
    await writeFile(join(f.stateDir, "manifest.json"), JSON.stringify(withLease));
    await f.laneReceipt("herdr-spec3", `INTEGRATED: ${sha}\nSUITE: pass`);
    await f.laneReceipt("herdr-spec4", "B committed.");
    await f.advance();
    let state = await f.state();
    assert.equal(state.items.A.state, "awaiting-push");
    assert.deepEqual((await f.manifest()).leases.map((lease) => [lease.id, lease.state]), [["lease-m1", "released"], ["lease-m2", "active"]]);
    assert.deepEqual(state.items.A.tests.map((run) => [run.command, run.sha, run.result]), [["npm test", sha, "pass"]]);
    // The integration queue has drained, so this round (A) is offered for a
    // push; B, still in review, joins the next round.
    const alerts = (await f.manifest()).rootSupervision[0].alerts.filter((alert) => alert.kind === "spec-push-ready");
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].text, /1 integrated spec item\(s\) ready to push: A \(spec-integration at cccccccccccc\)\. Ask the user/);
    assert.match(alerts[0].text, new RegExp(`push origin ${sha}:refs/heads/feature/release`));
    await f.advance();
    assert.equal(
      (await f.manifest()).rootSupervision[0].alerts.filter((alert) => alert.kind === "spec-push-ready").length,
      1,
      "the same round is offered once",
    );

    f.pushedShas.add(sha);
    await f.advance();
    state = await f.state();
    assert.equal(state.items.A.state, "verifying");
    assert.equal(state.items.A.integratedSha, sha);
  } finally {
    await f.cleanup();
  }
});

test("only a spec integration lane's contract allows local merges", async () => {
  const { laneContract } = await jiti.import("../index.ts");
  const workflow = { id: "herdr-c1", agentKind: "claude", lanes: [] };
  const lane = { id: "lane-1", objective: "x", readOnly: false, agentKind: "claude", status: "planned" };
  const normal = laneContract(workflow, lane);
  const integrate = laneContract(workflow, { ...lane, specStage: "integrate" });
  assert.match(normal, /Never push, merge, deploy, create a PR/);
  assert.match(integrate, /you may merge spec\/\* branches and commit on this worktree's integration branch \(local only\)\. Never push, deploy, create a PR/);
  assert.doesNotMatch(integrate, /Never push, merge/);
  assert.match(laneContract(workflow, { ...lane, specStage: "build" }), /Never push, merge/);
});

test("decide lanes read the project; answers recorded by the root unblock the build", async () => {
  const f = await fixture({ decide: true });
  try {
    await f.advance();
    const decide = f.calls.plan.filter((call) => call.specStage === "decide");
    assert.deepEqual(decide.map((call) => [call.taskProfile, call.readOnly, call.worktree]), [["planning", true, undefined], ["planning", true, undefined]]);
    assert.equal(f.calls.worktree.length, 0, "deciding creates no worktree");
    await f.laneReceipt("herdr-spec1", "QUESTION: Apply the discount before or after tax?");
    await f.laneReceipt("herdr-spec2", "Settled.");
    await f.advance();
    const alerts = (await f.manifest()).rootSupervision[0].alerts.filter((alert) => alert.kind === "spec-decisions");
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].text, /ask the user all of these in one round:\n- A: Apply the discount before or after tax\?/);
    await assert.rejects(
      f.tools.get("herdr_spec").execute("spec", { action: "answer", itemId: "B", text: "x" }, undefined, undefined, f.ctx),
      /not waiting on a decision/,
    );
    const answered = await f.tools.get("herdr_spec").execute("spec", { action: "answer", itemId: "A", text: "After tax." }, undefined, undefined, f.ctx);
    assert.match(answered.content[0].text, /Recorded answers for A/);
    await f.advance();
    const build = f.calls.plan.find((call) => call.specStage === "build");
    assert.match(build.laneObjective, /answers to its open questions:\nAfter tax\./);
  } finally {
    await f.cleanup();
  }
});
