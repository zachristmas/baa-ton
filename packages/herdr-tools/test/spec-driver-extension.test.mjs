import assert from "node:assert/strict";
import { assembleDemo, TINY_PNG } from "../demo-report.mjs";
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

async function fixture({ grants = ["dispatch", "integrate"], reviewModel = "model-b", decide = false, specDocument, seed } = {}) {
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
    JSON.stringify(specDocument ?? {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      stages: { ...(decide ? { decide: { profile: "planning" } } : {}), build: { profile: "implementation" }, review: { profile: "review", differentFrom: "build" } },
      items: [
        { id: "A", title: "Shipping discount", owns: ["src/a/**"], acceptance: { text: "Discount applies to shipping only.", tests: ["npm test"] } },
        { id: "B", title: "Report", dependsOn: ["A"], acceptance: { text: "Report lists discounts." } },
      ],
    }),
  );
  if (seed) await writeFile(join(stateDir, "spec-state.json"), JSON.stringify(seed));
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
  const handlers = new Map();
  extension({
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand() {},
    registerTool: (definition) => tools.set(definition.name, definition),
    async exec() {
      throw new Error("no herdr in this test");
    },
  });
  const calls = { worktree: [], plan: [], dispatch: [] };
  let planned = 0;
  const pushedShas = new Set();
  const release = { body: "{}" };
  const ports = {
    worktreeRoot: join(directory, "worktrees"),
    async fetchRelease(url) {
      calls.release = [...(calls.release ?? []), url];
      return release.body;
    },
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
    // No lane runs background work unless a test says so.
    backgroundWork: async () => undefined,
    // Every item branch has its own commits unless a test says so.
    aheadOf: async () => 1,
    // No target SHA (no suite baseline) unless a test says so.
    revParse: async () => undefined,
    async detachedWorktree(input) {
      calls.detached = [...(calls.detached ?? []), input];
    },
    async removeWorktree(input) {
      calls.removed = [...(calls.removed ?? []), input];
    },
    // A clean integration worktree unless a test says so.
    cleanIntegration: async () => undefined,
    async restore(input) {
      calls.restore = [...(calls.restore ?? []), input];
    },
    now: () => "2026-09-24T12:00:00.000Z",
  };
  const ctx = {
    cwd: parent,
    mode: "json",
    hasUI: false,
    ui: { confirm: async () => false, notify() {} },
    specDriverPorts: ports,
    // Pi lifecycle fields; the root is mid-turn (not idle) throughout.
    isIdle: () => false,
    abort() {},
    signal: undefined,
    sessionManager: { getSessionFile: () => "/tmp/root.jsonl", getSessionId: () => "root" },
  };
  return {
    calls,
    pushedShas,
    release,
    ports,
    worktreeRoot: join(directory, "worktrees"),
    stateDir,
    tools,
    ctx,
    async emit(event, payload = {}, context = ctx) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, context);
    },
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
    assert.match(merge.laneObjective, /git merge --no-ff -m "spec\(A\): integrate" spec\/A/);
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
    assert.equal(state.items.A.integratedSha, sha);
    assert.equal(state.items.A.state, "done", "nothing to check on the preview: the verifier passes it once pushed");
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

/** A minimal stored zip with the given entry names (a .docx for the report check). */
function docx(images) {
  // A real feature demo: captioned steps (demo-report.mjs), as lanes write it.
  return assembleDemo({ steps: Array.from({ length: images }, (_, index) => ({ action: `Step action ${index + 1}`, shows: `state ${index + 1}`, data: TINY_PNG })) }).docx;
}

/** Write a demo report and its steps manifest. */
async function writeDemo(path, images) {
  const { docx: buffer, manifest } = assembleDemo({ steps: Array.from({ length: images }, (_, index) => ({ action: `Step action ${index + 1}`, shows: `state ${index + 1}`, data: TINY_PNG })) });
  await writeFile(path, buffer);
  await writeFile(`${path}.steps.json`, JSON.stringify(manifest));
  return buffer;
}

test("verification: waits for the deploy, runs the preview specs, records the final report, and the verifier marks done", async () => {
  const sha = "d".repeat(40);
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release", preview: { url: "https://preview.example.test", releaseCheck: "https://preview.example.test/api/version" } },
      items: [{
        id: "A",
        title: "Shipping discount",
        acceptance: { text: "Discount applies to shipping only.", tests: ["npm test"], preview: ["e2e/a.spec.ts"], evidence: { report: "artifacts/a.docx", minImages: 2 } },
      }],
    },
    seed: {
      version: 1,
      items: { A: { state: "verifying", integratedSha: sha, tests: [{ command: "npm test", sha, result: "pass" }] } },
    },
  });
  try {
    f.release.body = JSON.stringify({ version: "e".repeat(40) });
    let result = await f.advance();
    assert.match(result.content[0].text, /A waits: preview: the release check does not report a deploy containing this commit yet/);
    assert.deepEqual(f.calls.release, ["https://preview.example.test/api/version"]);

    f.release.body = JSON.stringify({ version: sha });
    result = await f.advance();
    assert.match(result.content[0].text, /Started: verify A -> herdr-spec1\./);
    const verify = f.calls.plan[0];
    assert.equal(verify.specStage, "verify");
    assert.equal(verify.taskProfile, "quick");
    assert.equal(verify.worktree, join(f.worktreeRoot, "spec-verify-A"), "never the integration worktree");
    assert.deepEqual(f.calls.detached, [{ repo: f.calls.detached[0].repo, path: join(f.worktreeRoot, "spec-verify-A"), sha }], "detached at the pushed commit");
    assert.match(verify.laneObjective, /artifacts\/a\.final\.docx/);

    await mkdir(join(f.worktreeRoot, "spec-verify-A", "artifacts"), { recursive: true });
    await writeDemo(join(f.worktreeRoot, "spec-verify-A", "artifacts", "a.final.docx"), 2);
    f.pushedShas.add(sha);
    await f.laneReceipt("herdr-spec1", "PREVIEW: e2e/a.spec.ts pass\nREPORT: artifacts/a.final.docx");
    result = await f.advance();
    assert.match(result.content[0].text, /done A/);
    const state = await f.state();
    assert.equal(state.items.A.state, "done");
    assert.equal(state.items.A.evidence.images, 2);
    assert.equal(state.items.A.evidence.path, join(f.stateDir, "evidence", "A", "a.final.docx"), "kept in the state folder");
    assert.deepEqual(f.calls.removed.map((call) => call.path), [join(f.worktreeRoot, "spec-verify-A")], "the verify worktree is removed once done");
    assert.equal(state.items.A.verifyWorktree, undefined);
  } finally {
    await f.cleanup();
  }
});

test("adopted work: an attached legacy lane is never dispatched twice, and its receipt reviews the adopted branch", async () => {
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      stages: { build: { profile: "implementation" }, review: { profile: "review", differentFrom: "build" } },
      items: [{ id: "LIVE", title: "Live item", owns: ["src/live/**"], adopt: { worktree: "/work/wt-live", branch: "demo/live", workflow: "herdr-legacy" }, acceptance: { text: "l" } }],
    },
    seed: {
      version: 1,
      items: { LIVE: { state: "building", attempts: 1, worktree: "/work/wt-live", branch: "demo/live", lane: { workflowId: "herdr-legacy", laneId: "lane-1" }, adopted: { workflow: "herdr-legacy" } } },
    },
  });
  try {
    const manifest = await f.manifest();
    manifest.workflows.push({ id: "herdr-legacy", status: "running", lanes: [{ id: "lane-1", status: "working" }], evidence: [] });
    await writeFile(join(f.stateDir, "manifest.json"), JSON.stringify(manifest));
    await f.advance();
    await f.advance();
    assert.equal(f.calls.plan.length, 0, "the live legacy lane keeps the item; nothing is dispatched");

    const withReceipt = await f.manifest();
    withReceipt.workflows[0].lanes[0] = { id: "lane-1", status: "completion-reported", completionReceipt: { id: "r", summary: "Done on demo/live.", delivery: "delivered" } };
    await writeFile(join(f.stateDir, "manifest.json"), JSON.stringify(withReceipt));
    await f.advance();
    assert.equal(f.calls.plan.length, 1);
    assert.equal(f.calls.plan[0].specStage, "review");
    assert.equal(f.calls.plan[0].worktree, "/work/wt-live", "the review reads the adopted worktree");
    assert.match(f.calls.plan[0].laneObjective, /git diff origin\/feature\/release\.\.\.demo\/live/);
    assert.equal(f.calls.worktree.length, 0, "no spec/<id> worktree is created for adopted work");
  } finally {
    await f.cleanup();
  }
});

test("integrating adopted work: the lane commits exactly the item-owned paths first, never secrets", async () => {
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      items: [{ id: "ACC", title: "Accepted", owns: ["src/acc/**"], sharedTouch: ["db/migrations/meta/_journal.json"], acceptance: { text: "a" } }],
    },
    seed: { version: 1, items: { ACC: { state: "integrating", attempts: 1, worktree: "/work/wt-acc", branch: "demo/acc" } } },
  });
  try {
    f.ports.status = async (worktree) => {
      assert.equal(worktree, "/work/wt-acc");
      return [" M src/acc/rules.ts", "?? src/acc/new.test.ts", " M db/migrations/meta/_journal.json", "?? src/acc/.env.local", "?? src/acc/stack.lane-secrets.json"].join("\n");
    };
    await f.advance();
    const merge = f.calls.plan[0];
    assert.equal(merge.specStage, "integrate");
    assert.match(merge.laneObjective, /git merge --no-ff -m "spec\(ACC\): integrate" demo\/acc/, "integrates from the adopted branch");
    assert.match(
      merge.laneObjective,
      /git -C \/work\/wt-acc add -- "src\/acc\/rules\.ts" "src\/acc\/new\.test\.ts" "db\/migrations\/meta\/_journal\.json" && git -C \/work\/wt-acc commit/,
      "the shared migration journal is committed with the item",
    );
    assert.match(merge.laneObjective, /never git add -A/);
    assert.match(merge.laneObjective, /Leave these uncommitted; they look like secrets and must never be staged: src\/acc\/\.env\.local, src\/acc\/stack\.lane-secrets\.json\./);
    assert.doesNotMatch(merge.laneObjective.split("Leave these")[0], /\.env|lane-secrets|unrelated/);
  } finally {
    await f.cleanup();
  }
});

test("memory-aware dispatch: a live memory floor holds builds, and a shell start timeout backs off", async () => {
  const document = {
    version: 1,
    target: { repo: ".", remote: "origin", branch: "feature/release" },
    defaults: { minFreeMemoryGb: 4 },
    items: [{ id: "A", title: "A", owns: ["src/a/**"], acceptance: { text: "a" } }, { id: "B", title: "B", owns: ["src/b/**"], acceptance: { text: "b" } }],
  };
  const f = await fixture({ specDocument: document });
  try {
    f.ports.sample = async () => ({ freeMemoryGb: 1.5, swapUsedGb: 20 });
    let result = await f.advance();
    assert.match(result.content[0].text, /A waits: capacity: free memory 1\.5 GB is below 4 GB/);
    assert.equal(f.calls.plan.length, 0);

    f.ports.sample = async () => ({ freeMemoryGb: 9, swapUsedGb: 2 });
    f.ports.dispatch = async (workflowId) => {
      f.calls.dispatch.push(workflowId);
      throw new Error("Pane w-spec:p9 shell did not become ready for agent start; inspect it before retrying.");
    };
    result = await f.advance();
    assert.equal(f.calls.dispatch.length, 1, "after a shell start timeout nothing else starts this pass");
    let state = await f.state();
    assert.equal(state.dispatchBackoff.until, "2026-09-24T12:10:00.000Z");
    assert.match(state.dispatchBackoff.reason, /shell did not become ready/);

    result = await f.advance();
    assert.equal(f.calls.dispatch.length, 1, "still backing off");
    assert.match(result.content[0].text, /waits: capacity: backing off until 2026-09-24T12:10:00\.000Z/);

    f.ports.now = () => "2026-09-24T12:11:00.000Z";
    f.ports.dispatch = async (workflowId) => {
      f.calls.dispatch.push(workflowId);
      return { dispatched: true };
    };
    await f.advance();
    state = await f.state();
    assert.equal(state.dispatchBackoff, undefined, "the backoff clears once it has passed");
    assert.ok(f.calls.dispatch.length > 1);
  } finally {
    await f.cleanup();
  }
});

test("an adopted branch with uncommitted changes outside its files, or with no owns, goes to the root instead", async () => {
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      items: [
        { id: "MIX", title: "Mixed", owns: ["src/mix/**"], acceptance: { text: "m" } },
        { id: "NONE", title: "No owns", acceptance: { text: "n" } },
      ],
    },
    seed: {
      version: 1,
      items: {
        MIX: { state: "integrating", attempts: 1, worktree: "/work/wt-mix", branch: "demo/mix" },
        NONE: { state: "integrating", attempts: 1, worktree: "/work/wt-none", branch: "demo/none" },
      },
    },
  });
  try {
    f.ports.status = async (worktree) =>
      worktree === "/work/wt-mix" ? " M src/mix/a.ts\n?? artifacts/run/screenshot.png\n M src/other.ts" : " M lib/shared.ts\n?? artifacts/run/trace.zip";
    const first = await f.advance();
    assert.match(first.content[0].text, /integrate MIX held: uncommitted changes outside its files/);
    let state = await f.state();
    assert.equal(state.items.MIX.state, "blocked");
    assert.match(state.items.MIX.note, /outside the item's owns and sharedTouch: src\/other\.ts$/, "only the tracked change blocks; the untracked artifact does not");
    // With MIX held, NONE is next in the queue on the following pass.
    await f.advance();
    state = await f.state();
    assert.equal(state.items.NONE.state, "blocked", "no owns: commit nothing and ask the root");
    assert.equal(f.calls.plan.filter((call) => call.specStage === "integrate").length, 0, "nothing was merged");
    const asks = (await f.manifest()).rootSupervision[0].alerts.filter((alert) => alert.kind === "spec-needs-root").map((alert) => alert.text);
    assert.ok(asks.some((text) => /MIX: \/work\/wt-mix has modified tracked files outside/.test(text)));
    assert.ok(asks.some((text) => /NONE: \/work\/wt-none has modified tracked files outside[\s\S]*lib\/shared\.ts/.test(text)));
  } finally {
    await f.cleanup();
  }
});

test("a lane idle without its receipt is asked, asked pointedly, then (with no report to infer from) replaced by a fresh lane; a gone lane is retried in place", async () => {
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      items: [
        { id: "IDLE", title: "Idle", owns: ["src/idle/**"], acceptance: { text: "i" } },
        { id: "GONE", title: "Gone", owns: ["src/gone/**"], acceptance: { text: "g" } },
      ],
    },
    seed: {
      version: 1,
      items: {
        IDLE: { state: "reviewing", attempts: 1, worktree: "/work/wt-idle", branch: "demo/idle", lane: { workflowId: "herdr-idle", laneId: "lane-1" } },
        GONE: { state: "building", attempts: 1, worktree: "/work/wt-gone", branch: "demo/gone", lane: { workflowId: "herdr-gone", laneId: "lane-1" } },
      },
    },
  });
  try {
    const manifest = await f.manifest();
    manifest.workflows.push(
      { id: "herdr-idle", status: "running", lanes: [{ id: "lane-1", status: "running" }], eventController: { events: [{ lane_id: "lane-1", source: { agent_status: "working" } }, { lane_id: "lane-1", source: { agent_status: "done" } }] }, evidence: [] },
      { id: "herdr-gone", status: "running", lanes: [{ id: "lane-1", status: "running", sessionLog: { status: "gone" } }], evidence: [] },
    );
    await writeFile(join(f.stateDir, "manifest.json"), JSON.stringify(manifest));
    const told = [];
    f.ports.tell = async (input) => {
      told.push(input);
      return { message: { delivery: { status: "delivered" } } };
    };
    f.ports.status = async (worktree) => (worktree === "/work/wt-gone" ? " M src/gone/half-done.ts" : "");

    const first = await f.advance();
    assert.equal(told.length, 1);
    assert.deepEqual([told[0].workflowId, told[0].laneId], ["herdr-idle", "lane-1"]);
    assert.match(told[0].text, /review lane for IDLE is idle without its completion receipt[\s\S]*VERDICT: PASS or VERDICT: FAIL/);
    assert.match(first.content[0].text, /asked IDLE for its receipt \(delivered\)/);
    // The gone build lane is retried in the same worktree, not counted: its worktree has changes.
    const rebuild = f.calls.plan.find((call) => call.specStage === "build");
    assert.equal(rebuild.worktree, "/work/wt-gone");
    let state = await f.state();
    assert.equal(state.items.GONE.attempts, 1, "a retry with work in the worktree is not an attempt");

    await f.advance();
    assert.equal(told.length, 1, "asked once");
    f.ports.now = () => "2026-09-24T12:11:00.000Z";
    await f.advance();
    assert.equal(told.length, 2, "one pointed ask after an interval");
    assert.match(told[1].text, /Call herdr_complete for workflow herdr-idle now, as your only action/);
    // Nothing to infer from: no message, an empty screen.
    f.ports.readScreen = async () => "";
    f.ports.now = () => "2026-09-24T12:22:00.000Z";
    await f.advance();
    f.ports.now = () => "2026-09-24T12:23:00.000Z";
    await f.advance();
    state = await f.state();
    assert.equal(state.items.IDLE.state, "reviewing", "not held at the human gate");
    assert.equal(state.items.IDLE.declined.kind, "idle without a receipt");
    const fresh = f.calls.plan.filter((call) => call.specStage === "review").at(-1);
    assert.match(fresh.objective, /retry 1: idle without a receipt/);
    assert.match(fresh.laneObjective, /An earlier lane for this review did not finish \(idle without a receipt/);
  } finally {
    await f.cleanup();
  }
});

test("items resolved by decision count as done, are logged and announced, and can be reopened", async () => {
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      items: [
        { id: "RES", title: "Resolved", owns: ["src/res/**"], adopt: { resolved: "the user decided the old flow stays" }, acceptance: { text: "r" } },
        { id: "NEW", title: "New", owns: ["src/new/**"], acceptance: { text: "n" } },
      ],
    },
  });
  try {
    const adopted = await f.tools.get("herdr_spec").execute("spec", { action: "adopt" }, undefined, undefined, f.ctx);
    assert.match(adopted.content[0].text, /RES\s+resolved\s+resolved by decision: the user decided the old flow stays/);
    const state = await f.state();
    assert.deepEqual(state.decisions.map((entry) => [entry.itemId, entry.decision, entry.reason]), [["RES", "resolved", "the user decided the old flow stays"]]);
    const alerts = (await f.manifest()).rootSupervision[0].alerts.filter((alert) => alert.kind === "spec-resolved");
    assert.match(alerts[0].text, /herdr_spec action=reopen/);
    assert.match(alerts[0].text, /RES \(the user decided the old flow stays\)/);
    const status = await f.status();
    assert.match(status.content[0].text, /^spec 1\/2 done \(1 by decision\)/);
    assert.match(status.content[0].text, /RES\s+resolved\s+-\s+\S+\s+by decision: the user decided the old flow stays/);

    const reopened = await f.tools.get("herdr_spec").execute("spec", { action: "reopen", itemId: "RES", text: "the user wants it built after all" }, undefined, undefined, f.ctx);
    assert.match(reopened.content[0].text, /Reopened RES/);
    const after = await f.state();
    assert.equal(after.items.RES.state, "pending");
    assert.deepEqual(after.decisions.map((entry) => entry.decision), ["resolved", "reopened"]);
    await assert.rejects(
      f.tools.get("herdr_spec").execute("spec", { action: "reopen", itemId: "NEW" }, undefined, undefined, f.ctx),
      /not resolved by decision/,
    );
  } finally {
    await f.cleanup();
  }
});

test("lane contracts and the integration objective steer lanes away from the shared stash", async () => {
  const { laneContract } = await jiti.import("../index.ts");
  const { integrateObjective } = await import("../spec-driver.mjs");
  const { validateSpec } = await import("../spec.mjs");
  const lane = { id: "lane-1", objective: "x", readOnly: false, agentKind: "claude", status: "planned" };
  for (const specStage of [undefined, "build", "integrate"]) {
    const text = laneContract({ id: "herdr-s1", agentKind: "claude", lanes: [] }, { ...lane, ...(specStage ? { specStage } : {}) });
    assert.match(text, /Never git stash drop, pop or clear: the stash is shared by every worktree/);
    assert.match(text, /git diff > <scratch>\/x\.patch; git checkout -- <files>; later git apply <scratch>\/x\.patch\) or a throwaway commit on your own branch/);
  }
  const spec = validateSpec({ version: 1, target: { repo: ".", remote: "origin", branch: "b" }, items: [{ id: "A", title: "a", acceptance: { text: "a" } }] });
  assert.match(integrateObjective(spec, spec.items[0], { integrationBranch: "spec-integration", itemBranch: "spec/A" }), /Never use git stash/);
});

function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    schedule(callback, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        // A pass does real file I/O (state, manifest, log): let it finish.
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      now = until;
      await new Promise((resolve) => setTimeout(resolve, 60));
    },
    get pending() {
      return timers.size;
    },
  };
}

test("the driver runs on a timer while the root is mid-turn: no overlap, backoff honored, passes logged", async () => {
  const f = await fixture();
  const clock = fakeClock();
  f.ctx.specTimerOptions = { schedule: clock.schedule, cancel: clock.cancel, watch: () => undefined };
  try {
    // The root starts a long turn; no turn settles during this test.
    await f.emit("agent_start");
    assert.equal(f.calls.plan.length, 0, "starting the timer runs nothing yet");
    await clock.advance(25_000);
    assert.equal(f.calls.dispatch.length, 1, "a timer pass dispatched the ready build mid-turn");
    assert.equal((await f.state()).items.A.state, "building");

    // A slow pass: the next tick must not start a second one.
    let release;
    const slow = new Promise((resolve) => (release = resolve));
    f.ports.plan = async (input) => {
      f.calls.plan.push(input);
      await slow;
      return { id: "herdr-slow", lanes: [{ id: "lane-1" }] };
    };
    await f.laneReceipt("herdr-spec1", "Committed.");
    await clock.advance(25_000);
    const planned = f.calls.plan.length;
    await clock.advance(25_000);
    await clock.advance(25_000);
    assert.equal(f.calls.plan.length, planned, "no overlapping pass while one is running");
    release();
    await clock.advance(1);

    // A shell start timeout backs the driver off; timer passes honor it.
    await f.laneReceipt("herdr-slow", "VERDICT: PASS");
    const before = f.calls.dispatch.length;
    f.ports.plan = async (input) => {
      f.calls.plan.push(input);
      return { id: `herdr-p${f.calls.plan.length}`, lanes: [{ id: "lane-1" }] };
    };
    f.ports.dispatch = async (workflowId) => {
      f.calls.dispatch.push(workflowId);
      throw new Error("Pane w-spec:p9 shell did not become ready for agent start; inspect it before retrying.");
    };
    await clock.advance(25_000);
    const afterFailure = f.calls.dispatch.length;
    assert.ok(afterFailure > before);
    assert.match((await f.state()).dispatchBackoff.reason, /shell did not become ready/);
    await clock.advance(25_000);
    await clock.advance(25_000);
    assert.equal(f.calls.dispatch.length, afterFailure, "no dispatch during the backoff");

    const log = (await readFile(join(f.stateDir, "spec-driver.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(log.some((entry) => entry.trigger === "timer" && entry.actions?.some((action) => /^build A -> /.test(action))), "each acting pass is logged");

    await f.emit("session_shutdown");
    assert.equal(clock.pending, 0, "the timer stops with the session");
  } finally {
    await f.cleanup();
  }
});

test("a /reload restarts the driver on the fresh context; a stale context stops the old timer; a turn boundary starts one", async () => {
  const f = await fixture();
  const clock = fakeClock();
  let stale = false;
  const passes = [];
  const options = (label) => ({
    schedule: clock.schedule,
    cancel: clock.cancel,
    watch: () => undefined,
    run: async () => {
      passes.push(label);
      if (stale && label === "old") throw new Error("This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.reload().");
      return { actions: [], rootAsks: [], waits: {} };
    },
  });
  f.ctx.specTimerOptions = options("old");
  try {
    await f.emit("agent_start");
    await clock.advance(25_000);
    assert.deepEqual(passes, ["old"]);
    // The context goes stale (a /reload): the old timer logs it and stops.
    stale = true;
    await clock.advance(25_000);
    assert.equal(clock.pending, 0, "the stale timer stopped instead of retrying");
    const log = await readFile(join(f.stateDir, "spec-driver.log"), "utf8");
    assert.match(log, /ctx is stale/);
    assert.match(log, /"stopped":"this extension instance's context went stale after a reload/);
    // The reloaded instance's session_start (reason reload) starts it again.
    const fresh = { ...f.ctx, specTimerOptions: options("fresh") };
    await f.emit("session_start", { reason: "reload" }, fresh);
    await clock.advance(25_000);
    assert.equal(passes.at(-1), "fresh", "the driver runs on the fresh context");
    // A reload of a running timer replaces it rather than keeping the old one.
    const again = { ...f.ctx, specTimerOptions: options("again") };
    await f.emit("session_start", { reason: "reload" }, again);
    await clock.advance(25_000);
    assert.equal(passes.at(-1), "again");
    assert.equal(clock.pending, 1, "one timer, not two");
    // With no timer, a turn boundary (a reloaded instance mid-turn) starts one.
    await f.emit("session_shutdown");
    assert.equal(clock.pending, 0);
    await f.emit("turn_end", {}, { ...f.ctx, specTimerOptions: options("turn") });
    await clock.advance(25_000);
    assert.equal(passes.at(-1), "turn");
  } finally {
    await f.cleanup();
  }
});

test("before an adopted review, each item's own changes are committed on its branch, in order, even in a shared worktree", async () => {
  const shared = "/work/wt-shared";
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      stages: { build: { profile: "implementation" }, review: { profile: "review", differentFrom: "build" } },
      items: [
        { id: "A", title: "First", owns: ["src/a/**"], sharedTouch: ["db/journal.json"], acceptance: { text: "a" } },
        { id: "B", title: "Second", owns: ["src/b/**"], sharedTouch: ["db/journal.json"], acceptance: { text: "b" } },
      ],
    },
    seed: {
      version: 1,
      items: {
        A: { state: "reviewing", attempts: 1, worktree: shared, branch: "demo/ab", adopted: { worktree: shared, branch: "demo/ab" } },
        B: { state: "reviewing", attempts: 1, worktree: shared, branch: "demo/ab", adopted: { worktree: shared, branch: "demo/ab" } },
      },
    },
  });
  try {
    let porcelain = [" M src/a/one.ts", "?? src/a/two.ts", " M db/journal.json", " M src/b/three.ts", "?? src/b/.env.local"];
    const commits = [];
    f.ports.status = async () => porcelain.join("\n");
    f.ports.commit = async ({ worktree, paths, message }) => {
      commits.push({ worktree, paths, message });
      porcelain = porcelain.filter((line) => !paths.includes(line.slice(3)));
      return `sha-${commits.length}`;
    };
    await f.advance();
    assert.deepEqual(commits, [
      { worktree: shared, paths: ["src/a/one.ts", "src/a/two.ts", "db/journal.json"], message: "spec(A): adopt work as built" },
      { worktree: shared, paths: ["src/b/three.ts"], message: "spec(B): adopt work as built" },
    ], "A first (it claims the shared journal), then B; the secret stays uncommitted");
    const reviews = f.calls.plan.filter((call) => call.specStage === "review");
    assert.deepEqual(reviews.map((call) => [call.worktree, call.readOnly]), [[shared, true], [shared, true]]);
    const state = await f.state();
    assert.deepEqual(state.items.A.adoptCommit.paths, ["src/a/one.ts", "src/a/two.ts", "db/journal.json"]);
    assert.equal(state.items.B.adoptCommit.sha, "sha-2");
  } finally {
    await f.cleanup();
  }
});

test("an adopted review is held when the worktree has changes no item owns, or the commit fails", async () => {
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      items: [
        { id: "A", title: "Stray", owns: ["src/a/**"], acceptance: { text: "a" } },
        { id: "C", title: "Hook", owns: ["src/c/**"], acceptance: { text: "c" } },
      ],
    },
    seed: {
      version: 1,
      items: {
        A: { state: "reviewing", attempts: 1, worktree: "/work/wt-a", branch: "demo/a", adopted: { worktree: "/work/wt-a" } },
        C: { state: "reviewing", attempts: 1, worktree: "/work/wt-c", branch: "demo/c", adopted: { worktree: "/work/wt-c" } },
      },
    },
  });
  try {
    f.ports.status = async (worktree) => (worktree === "/work/wt-a" ? " M src/a/x.ts\n M lib/stray.ts\n?? artifacts/run/log.txt" : " M src/c/y.ts");
    const commits = [];
    const hookLines = Array.from({ length: 50 }, (_, index) => `lint line ${index + 1}`);
    f.ports.commit = async (input) => {
      commits.push(input);
      throw Object.assign(new Error(`Command failed: git -C /work/wt-c commit -m ${input.message}`), {
        stderr: `${hookLines.join("\n")}\n⧗   input: spec(C): adopt work as built\n✖   subject may not be empty [subject-empty]\nhusky - commit-msg script failed (code 1)\n`,
      });
    };
    const result = await f.advance();
    assert.match(result.content[0].text, /review A held: uncommitted changes outside the item's owns and sharedTouch: lib\/stray\.ts/);
    assert.match(result.content[0].text, /review C held: committing the adopted work failed:/);
    const noteC = (await f.state()).items.C.note;
    assert.match(noteC, /husky - commit-msg script failed \(code 1\)/, "the hook's own output reaches the root");
    assert.doesNotMatch(noteC, /Command failed: git/, "not the command line");
    assert.doesNotMatch(noteC, /lint line 1\n/, "only the last ~40 lines");
    assert.match(noteC, /lint line 50/);
    assert.deepEqual(commits.map((input) => input.worktree), ["/work/wt-c"], "nothing is committed for A");
    const state = await f.state();
    assert.deepEqual([state.items.A.state, state.items.C.state], ["blocked", "blocked"]);
    assert.equal(f.calls.plan.length, 0, "no review lane for a held item");
  } finally {
    await f.cleanup();
  }
});

test("holds a deploy may fix retry once on the first pass under new code", async () => {
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      items: ["OLD", "LEGACY", "SAME", "OTHER"].map((id) => ({ id, title: id, owns: [`src/${id.toLowerCase()}/**`], acceptance: { text: id } })),
    },
    seed: {
      version: 1,
      items: {
        OLD: { state: "blocked", blockedReason: "human-gate", blockedCause: "adopt-commit", blockedByCode: "code-old", note: "committing the adopted work failed:\nhook", history: [{ at: "t", from: "reviewing", to: "blocked" }] },
        LEGACY: { state: "blocked", blockedReason: "human-gate", note: "uncommitted changes outside the item's owns and sharedTouch: x", history: [{ at: "t", from: "integrating", to: "blocked" }] },
        SAME: { state: "blocked", blockedReason: "human-gate", blockedCause: "adopt-commit", blockedByCode: "code-new", note: "committing the adopted work failed:\nhook", history: [{ at: "t", from: "reviewing", to: "blocked" }] },
        OTHER: { state: "blocked", blockedReason: "human-gate", note: "review receipt has no VERDICT: PASS or VERDICT: FAIL line", history: [{ at: "t", from: "reviewing", to: "blocked" }] },
      },
    },
  });
  try {
    f.ports.codeVersion = "code-new";
    await f.advance();
    const state = await f.state();
    assert.equal(state.items.OLD.state, "reviewing", "held under older code: retried");
    assert.equal(state.items.LEGACY.state, "integrating", "an unstamped hold from before this change is retried too");
    assert.equal(state.items.SAME.state, "blocked", "held under the current code: stays for the root");
    assert.equal(state.items.OTHER.state, "reviewing", "an old hold for an unclear receipt goes back on the retry ladder");
    assert.equal(state.items.OTHER.declined.kind, "unclear receipt");
    assert.equal(state.items.OLD.history.at(-1).note, "retried after a deploy");
    assert.equal(state.items.OLD.blockedCause, undefined);
  } finally {
    await f.cleanup();
  }
});

test("the real commit path: conventional header, hooks run and may rewrite staged files, untracked files stay", async () => {
  const { execFileSync } = await import("node:child_process");
  const { chmod, mkdtemp: mkd, readFile: read } = await import("node:fs/promises");
  const { tmpdir: tmp } = await import("node:os");
  const repo = await mkd(join(tmp(), "baa-adopt-commit-"));
  const savedEnv = Object.fromEntries(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" });
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      stages: { build: { profile: "implementation" }, review: { profile: "review", differentFrom: "build" } },
      items: [{ id: "D05", title: "Adopted", owns: ["src/**"], acceptance: { text: "d" } }],
    },
    seed: { version: 1, items: { D05: { state: "reviewing", attempts: 1, worktree: repo, branch: "demo/d05", adopted: { worktree: repo, branch: "demo/d05" } } } },
  });
  try {
    git("init", "-q", "-b", "demo/d05");
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src", "a.ts"), "export const a = 1;\n");
    git("add", ".");
    git("commit", "-q", "-m", "chore: base");
    // commitlint-style commit-msg hook (type(scope): subject, no spaces in the type),
    // and a lint-staged-style pre-commit that rewrites and re-adds staged files.
    const hooks = join(repo, ".git", "hooks");
    await writeFile(join(hooks, "commit-msg"), '#!/bin/sh\nhead -1 "$1" | grep -Eq "^[a-z]+(\\([A-Za-z0-9._-]+\\))?: .+" || { echo "subject must be conventional" >&2; exit 1; }\n');
    await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\nfor f in $(git diff --cached --name-only); do printf '// formatted\\n' >> \"$f\"; git add \"$f\"; done\n");
    await chmod(join(hooks, "commit-msg"), 0o755);
    await chmod(join(hooks, "pre-commit"), 0o755);
    await writeFile(join(repo, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(join(repo, "harness.sh"), "echo lane-only\n");

    const result = await f.advance();
    assert.match(result.content[0].text, /committed 1 adopted path\(s\) for D05 on demo\/d05/);
    assert.equal(git("log", "-1", "--format=%s"), "spec(D05): adopt work as built");
    assert.match(await read(join(repo, "src", "a.ts"), "utf8"), /\/\/ formatted/, "the pre-commit hook's rewrite is in the commit");
    assert.equal(git("status", "--porcelain"), "?? harness.sh", "the untracked lane script stays, uncommitted");
    const state = await f.state();
    assert.match(state.items.D05.history.map((entry) => entry.note ?? "").join("\n"), /left untracked, uncommitted: harness\.sh/);
    assert.equal(f.calls.plan.at(-1).specStage, "review");
  } finally {
    for (const [key, value] of Object.entries(savedEnv))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await f.cleanup();
    await rm(repo, { recursive: true, force: true });
  }
});

test("build and integration objectives, and the lane contract, forbid detached jobs", async () => {
  const { buildObjective, integrateObjective } = await import("../spec-driver.mjs");
  const { validateSpec } = await import("../spec.mjs");
  const { laneContract } = await jiti.import("../index.ts");
  const spec = validateSpec({
    version: 1,
    target: { repo: ".", remote: "origin", branch: "b", suite: ["pnpm test"] },
    items: [{ id: "A", title: "a", acceptance: { text: "a", tests: ["pnpm --filter a test"] } }],
  });
  for (const text of [buildObjective(spec, spec.items[0], { branch: "spec/A" }), integrateObjective(spec, spec.items[0], { integrationBranch: "spec-integration", itemBranch: "spec/A" })]) {
    assert.match(text, /tracked background mode \(Claude: the Bash tool's run_in_background; Pi: its equivalent\)/);
    assert.match(text, /Never use &, disown, nohup or setsid/);
  }
  const contract = laneContract({ id: "w", agentKind: "claude", lanes: [] }, { id: "l", objective: "x", readOnly: false, agentKind: "claude", status: "planned" });
  assert.match(contract, /never with &, disown, nohup or setsid/);
});

test("a build into an adopted worktree commits the adopted work first; a refusal holds the build", async () => {
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      items: [
        { id: "D02", title: "Adopted build", owns: ["src/d02/**"], sharedTouch: ["db/journal.json"], acceptance: { text: "d" } },
        { id: "D10", title: "Stray", owns: ["src/d10/**"], acceptance: { text: "s" } },
      ],
    },
    seed: {
      version: 1,
      items: {
        D02: { state: "ready", worktree: "/work/wt-d02", branch: "demo/d02", adopted: { worktree: "/work/wt-d02", branch: "demo/d02" } },
        D10: { state: "ready", worktree: "/work/wt-d10", branch: "demo/d10", adopted: { worktree: "/work/wt-d10", branch: "demo/d10" } },
      },
    },
  });
  try {
    f.ports.status = async (worktree) =>
      worktree === "/work/wt-d02" ? " M src/d02/a.ts\n M db/journal.json\n?? harness/run.sh" : " M src/d10/b.ts\n M lib/other.ts";
    const commits = [];
    f.ports.commit = async (input) => {
      commits.push(input);
      return "sha-d02";
    };
    const result = await f.advance();
    assert.deepEqual(commits, [{ worktree: "/work/wt-d02", paths: ["src/d02/a.ts", "db/journal.json"], message: "spec(D02): adopt work as built" }]);
    const build = f.calls.plan.find((call) => call.specStage === "build");
    assert.equal(build.worktree, "/work/wt-d02", "then the build is dispatched into the adopted worktree");
    assert.match(result.content[0].text, /build D10 held: uncommitted changes outside the item's owns and sharedTouch: lib\/other\.ts/);
    const state = await f.state();
    assert.equal(state.items.D10.state, "blocked");
    assert.equal(state.items.D10.history.at(-1).from, "building", "a deploy retry resumes the build");
    assert.equal(f.calls.plan.filter((call) => call.specStage === "build").length, 1);
  } finally {
    await f.cleanup();
  }
});

test("an item an older driver held for an idle integrate lane gets a fresh lane instead of holding spec-integration forever", async () => {
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      items: [{ id: "D11", title: "Earlier", acceptance: { text: "e" } }, { id: "D12", title: "Next", acceptance: { text: "n" } }],
    },
    seed: {
      version: 1,
      items: {
        D11: { state: "blocked", blockedReason: "human-gate", attempts: 1, lane: { workflowId: "herdr-int1", laneId: "lane-1" }, laneStage: "integrate", note: "integrate lane is idle without a receipt, even after being asked" },
        D12: { state: "integrating", attempts: 1 },
      },
    },
  });
  try {
    const manifest = await f.manifest();
    manifest.workflows.push({ id: "herdr-int1", status: "running", lanes: [{ id: "lane-1", status: "awaiting-explicit-outcome" }], evidence: [] });
    await writeFile(join(f.stateDir, "manifest.json"), JSON.stringify(manifest));
    const first = await f.advance();
    const integrates = f.calls.plan.filter((call) => call.specStage === "integrate");
    assert.deepEqual(integrates.map((call) => call.objective), ["spec D11 integrate (retry 1: idle without a receipt): Earlier"], "one fresh lane, for the held item first");
    assert.match(first.content[0].text, /D12 waits: integration queue: after D11|D12 waits: integration queue: one merge at a time/);
    const state = await f.state();
    assert.equal(state.items.D11.state, "integrating");
    assert.equal(state.items.D11.blockedReason, undefined);
  } finally {
    await f.cleanup();
  }
});

test("a live integrate lane in Herdr keeps spec-integration reserved, whatever its item's state", async () => {
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      items: [{ id: "D12", title: "Batch", acceptance: { text: "b" } }, { id: "D14", title: "Next", acceptance: { text: "n" } }],
    },
    // D12 was blocked and lost track of its lane: only Herdr still knows.
    seed: { version: 1, items: { D12: { state: "blocked", blockedReason: "human-gate", attempts: 1 }, D14: { state: "integrating", attempts: 1 } } },
  });
  try {
    const manifest = await f.manifest();
    manifest.workflows.push({ id: "herdr-batch", status: "running", lanes: [{ id: "lane-1", status: "running", specStage: "integrate", paneId: "w-spec:p7" }], evidence: [] });
    await writeFile(join(f.stateDir, "manifest.json"), JSON.stringify(manifest));
    let live = true;
    f.ports.agentPresent = async (paneId) => {
      assert.equal(paneId, "w-spec:p7");
      return live;
    };
    const first = await f.advance();
    assert.match(first.content[0].text, /D14 waits: integration worktree busy: the integrate lane herdr-batch\/lane-1 is still live/);
    assert.equal(f.calls.plan.filter((call) => call.specStage === "integrate").length, 0);
    live = false;
    await f.advance();
    assert.equal(f.calls.plan.filter((call) => call.specStage === "integrate").length, 1, "once its pane has no agent, the next integration starts");
  } finally {
    await f.cleanup();
  }
});

test("a lane that replies with its report instead of a receipt gets one pointed ask, then its receipt is inferred from that report", async () => {
  const merged = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const f = await fixture({
    specDocument: { version: 1, target: { repo: ".", remote: "origin", branch: "feature/release" }, items: [{ id: "D12", title: "Batch", acceptance: { text: "b" } }] },
    seed: {
      version: 1,
      items: { D12: { state: "integrating", attempts: 1, lane: { workflowId: "herdr-338", laneId: "lane-1" }, laneStage: "integrate", receiptAskedAt: "2026-09-24T11:20:00.000Z" } },
    },
  });
  try {
    const manifest = await f.manifest();
    manifest.workflows.push({
      id: "herdr-338",
      status: "running",
      lanes: [{ id: "lane-1", status: "running", specStage: "integrate", paneId: "w-spec:p8" }],
      eventController: { events: [{ lane_id: "lane-1", source: { agent_status: "done" } }] },
      // The live shape: herdr_complete failed, so the lane sent its receipt text as a message.
      messageRequests: [{ id: "m1", laneId: "lane-1", summary: "herdr_complete FAILED to deliver; receipt text follows", details: `INTEGRATED: ${merged}\nSUITE: pass\nReport: artifacts/d12.docx`, requestedAt: "2026-09-24T11:25:00.000Z" }],
      evidence: [],
    });
    await writeFile(join(f.stateDir, "manifest.json"), JSON.stringify(manifest));
    const told = [];
    f.ports.tell = async (input) => (told.push(input), { message: { delivery: { status: "delivered" } } });
    f.ports.agentPresent = async () => false;
    await f.advance();
    assert.equal(told.length, 1, "its reply is not 'still working': one pointed ask");
    assert.match(told[0].text, /as your only action/);
    f.ports.now = () => "2026-09-24T12:11:00.000Z";
    const inferred = await f.advance();
    assert.match(inferred.content[0].text, /inferred D12's integrate receipt from its last message/);
    const lane = (await f.manifest()).workflows.find((workflow) => workflow.id === "herdr-338").lanes[0];
    assert.equal(lane.completionReceipt.inferred, true);
    assert.match(lane.completionReceipt.summary, /^INFERRED receipt/);
    const alerts = ((await f.manifest()).rootSupervision ?? []).flatMap((entry) => entry.alerts ?? []);
    assert.ok(alerts.some((alert) => /names blockers:\n- herdr_complete FAILED to deliver/.test(alert.text)), "blockers go to the root");
    f.ports.now = () => "2026-09-24T12:12:00.000Z";
    await f.advance();
    const state = await f.state();
    assert.equal(state.items.D12.state, "awaiting-push", "the inferred receipt's lines are processed like a real receipt");
    assert.equal(state.items.D12.integration.sha, merged);
  } finally {
    await f.cleanup();
  }
});

test("a finished lane without a receipt holds its maxParallel slot for at most one ask interval", async () => {
  const f = await fixture({
    specDocument: { version: 1, target: { repo: ".", remote: "origin", branch: "feature/release" }, defaults: { maxParallel: 1 }, items: [{ id: "D05", title: "Done lane", acceptance: { text: "a" } }, { id: "D15", title: "Waiting", acceptance: { text: "b" } }] },
    seed: { version: 1, items: { D05: { state: "building", attempts: 1, lane: { workflowId: "herdr-b5", laneId: "lane-1" }, receiptAskedAt: "2026-09-24T11:45:00.000Z" }, D15: { state: "ready", attempts: 0 } } },
  });
  try {
    const manifest = await f.manifest();
    manifest.workflows.push({ id: "herdr-b5", status: "running", lanes: [{ id: "lane-1", status: "running", paneId: "w-spec:p5" }], eventController: { events: [{ lane_id: "lane-1", source: { agent_status: "idle" } }] }, evidence: [] });
    await writeFile(join(f.stateDir, "manifest.json"), JSON.stringify(manifest));
    f.ports.tell = async () => ({ message: { delivery: { status: "delivered" } } });
    await f.advance();
    assert.ok(f.calls.plan.some((call) => call.specStage === "build" && /D15/.test(call.objective)), "15 minutes after the ask, D15 gets the slot");
  } finally {
    await f.cleanup();
  }
});

test("a lane idle while its own background work runs is not asked for a receipt, not blocked, and keeps its worktree", async () => {
  const f = await fixture({
    specDocument: { version: 1, target: { repo: ".", remote: "origin", branch: "feature/release" }, items: [{ id: "D12", title: "Batch", acceptance: { text: "b" } }, { id: "D14", title: "Next", acceptance: { text: "n" } }] },
    seed: {
      version: 1,
      items: {
        D12: { state: "integrating", attempts: 1, lane: { workflowId: "herdr-338", laneId: "lane-1" }, laneStage: "integrate", receiptAskedAt: "2026-09-24T11:20:00.000Z" },
        D14: { state: "integrating", attempts: 1 },
      },
    },
  });
  try {
    const manifest = await f.manifest();
    manifest.workflows.push({
      id: "herdr-338",
      status: "running",
      lanes: [{ id: "lane-1", status: "running", specStage: "integrate", paneId: "w-spec:p8" }],
      eventController: { events: [{ lane_id: "lane-1", source: { agent_status: "done" } }] },
      evidence: [],
    });
    await writeFile(join(f.stateDir, "manifest.json"), JSON.stringify(manifest));
    const told = [];
    f.ports.tell = async (input) => {
      told.push(input);
      return { message: { delivery: { status: "delivered" } } };
    };
    f.ports.agentPresent = async () => true;
    let work = "node --test packages/**/*.test.mjs";
    const asked = [];
    f.ports.backgroundWork = async (paneId) => {
      asked.push(paneId);
      return work;
    };
    // 40 minutes after an earlier ask, with no reply: would block, but the suite still runs.
    const first = await f.advance();
    let state = await f.state();
    assert.deepEqual(asked, ["w-spec:p8"]);
    assert.equal(state.items.D12.state, "integrating", "not blocked");
    assert.equal(state.items.D12.receiptAskedAt, undefined);
    assert.equal(state.items.D12.backgroundWork, work);
    assert.equal(told.length, 0, "no receipt ask");
    assert.match(first.content[0].text, /D14 waits: integration worktree busy/, "its worktree stays reserved");
    work = undefined;
    f.ports.now = () => "2026-09-24T12:05:00.000Z";
    await f.advance();
    state = await f.state();
    assert.equal(told.length, 1, "once the work ends, the receipt ask resumes");
    assert.equal(state.items.D12.backgroundWork, undefined);
    assert.equal(state.items.D12.state, "integrating");
  } finally {
    await f.cleanup();
  }
});

test("queued items already on spec-integration are recorded at the containing commit, not integrated again", async () => {
  const merged = "e".repeat(40);
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      items: [
        { id: "D20", title: "In the batch", acceptance: { text: "a", tests: ["npm test"] } },
        { id: "D21", title: "Also in the batch, no suite record", acceptance: { text: "b", tests: ["npm test"] } },
        { id: "D22", title: "Not merged yet", acceptance: { text: "c" } },
        { id: "D23", title: "Recorded by the batch lane", acceptance: { text: "d" } },
      ],
    },
    seed: {
      version: 1,
      items: {
        D20: { state: "integrating", attempts: 1, branch: "demo/d20" },
        D21: { state: "integrating", attempts: 1, branch: "demo/d21" },
        D22: { state: "integrating", attempts: 1, branch: "demo/d22" },
        D23: { state: "awaiting-push", integration: { sha: merged, order: 1 }, tests: [{ command: "npm test", sha: merged, result: "pass" }] },
      },
    },
  });
  try {
    f.ports.containingCommit = async (_repo, tip) => (tip === "demo/d20" ? merged : tip === "demo/d21" ? "f".repeat(40) : undefined);
    await f.advance();
    const state = await f.state();
    assert.equal(state.items.D20.state, "awaiting-push");
    assert.deepEqual([state.items.D20.integration.sha, state.items.D20.integration.contained], [merged, true]);
    assert.deepEqual(state.items.D20.tests.map((run) => [run.command, run.sha, run.result, run.by]), [["npm test", merged, "pass", "contained"]], "the suite passed at that commit (recorded by D23)");
    assert.equal(state.items.D21.state, "awaiting-push");
    assert.equal(state.items.D21.tests, undefined, "no suite result known at its commit: the verifier waits");
    const integrates = f.calls.plan.filter((call) => call.specStage === "integrate");
    assert.deepEqual(integrates.map((call) => call.objective), ["spec D22 integrate: Not merged yet"], "only the unmerged item gets an integration lane");
  } finally {
    await f.cleanup();
  }
});

test("a branch with no commits of its own, or with owned work uncommitted, is not already integrated", async () => {
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      items: [
        { id: "D29", title: "No commits yet", owns: ["src/d29/**"], acceptance: { text: "a" } },
        { id: "D30", title: "Work still uncommitted", owns: ["src/d30/**"], acceptance: { text: "b" } },
        { id: "D31", title: "Really merged", owns: ["src/d31/**"], acceptance: { text: "c" } },
      ],
    },
    seed: {
      version: 1,
      items: {
        D29: { state: "integrating", attempts: 1, branch: "demo/d29", worktree: "/work/wt-d29" },
        D30: { state: "integrating", attempts: 1, branch: "demo/d30", worktree: "/work/wt-d30" },
        D31: { state: "integrating", attempts: 1, branch: "demo/d31", worktree: "/work/wt-d31" },
      },
    },
  });
  try {
    const merged = "2".repeat(40);
    // Every tip is an ancestor of spec-integration; D29's tip is the base itself.
    f.ports.containingCommit = async () => merged;
    const asked = [];
    f.ports.aheadOf = async (_repo, branch, base) => {
      asked.push([branch, base]);
      return branch === "demo/d29" ? 0 : 2;
    };
    f.ports.status = async (worktree) => (worktree === "/work/wt-d30" ? " M src/d30/a.ts" : "");
    await f.advance();
    const state = await f.state();
    assert.deepEqual(asked[0], ["demo/d29", "refs/remotes/origin/feature/release"], "counted against the target base");
    assert.notEqual(state.items.D29.state, "awaiting-push", "no commits beyond the base: not integrated");
    assert.equal(state.items.D29.integration, undefined);
    assert.notEqual(state.items.D30.state, "awaiting-push", "owned work uncommitted: not integrated");
    assert.equal(state.items.D31.state, "awaiting-push");
    assert.equal(state.items.D31.integration.contained, true);
  } finally {
    await f.cleanup();
  }
});

test("generated artifacts the item does not own are restored to HEAD before the outside-owns check", async () => {
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      items: [
        { id: "D02", title: "Payments", owns: ["src/d02/**"], acceptance: { text: "d" } },
        { id: "D10", title: "Owns the spec", owns: ["src/d10/**", "apps/services/payment/openapi-spec.json"], acceptance: { text: "s" } },
        { id: "D13", title: "Custom list", owns: ["src/d13/**"], acceptance: { text: "t" } },
      ],
    },
    seed: {
      version: 1,
      items: {
        D02: { state: "ready", worktree: "/work/wt-d02", branch: "demo/d02", adopted: { worktree: "/work/wt-d02", branch: "demo/d02" } },
        D10: { state: "ready", worktree: "/work/wt-d10", branch: "demo/d10", adopted: { worktree: "/work/wt-d10", branch: "demo/d10" } },
        D13: { state: "ready", worktree: "/work/wt-d13", branch: "demo/d13", adopted: { worktree: "/work/wt-d13", branch: "demo/d13" } },
      },
    },
  });
  try {
    const restored = new Set();
    const status = {
      "/work/wt-d02": [" M src/d02/a.ts", " M apps/services/payment/openapi-spec.json", " M packages/shared/api-clients/src/api/payments.ts"],
      "/work/wt-d10": [" M src/d10/b.ts", " M apps/services/payment/openapi-spec.json"],
      "/work/wt-d13": [" M src/d13/c.ts", " M lib/stray.ts"],
    };
    f.ports.status = async (worktree) => status[worktree].filter((line) => !restored.has(`${worktree}:${line.slice(3)}`)).join("\n");
    f.ports.restore = async ({ worktree, paths }) => {
      f.calls.restore = [...(f.calls.restore ?? []), { worktree, paths }];
      for (const path of paths) restored.add(`${worktree}:${path}`);
    };
    const commits = [];
    f.ports.commit = async (input) => {
      commits.push(input);
      return `sha-${commits.length}`;
    };
    const result = await f.advance();
    assert.deepEqual(f.calls.restore, [{ worktree: "/work/wt-d02", paths: ["apps/services/payment/openapi-spec.json", "packages/shared/api-clients/src/api/payments.ts"] }], "only where the item does not own them");
    const state = await f.state();
    assert.notEqual(state.items.D02.state, "blocked");
    assert.ok(state.items.D02.history.some((entry) => /restored generated artifacts to HEAD/.test(entry.note ?? "")), "logged");
    assert.deepEqual(commits.map((commit) => commit.paths), [["src/d02/a.ts"], ["src/d10/b.ts", "apps/services/payment/openapi-spec.json"]], "an item that owns the spec commits it");
    assert.equal(state.items.D13.state, "blocked", "other stray files still hold the build");
    assert.match(result.content[0].text, /build D13 held: .*lib\/stray\.ts/);
  } finally {
    await f.cleanup();
  }
});

/** Record a lane's receipt in the manifest (the fake plan port writes no workflows). */
async function receive(f, ref, summary, specStage = "integrate") {
  const manifest = await f.manifest();
  manifest.workflows = manifest.workflows.filter((workflow) => workflow.id !== ref.workflowId);
  manifest.workflows.push({ id: ref.workflowId, status: "completed", lanes: [{ id: ref.laneId, status: "completion-reported", specStage, completionReceipt: { summary } }], evidence: [] });
  await writeFile(join(f.stateDir, "manifest.json"), JSON.stringify(manifest));
}

test("the integration gate is baseline-relative: failures the target tip already has do not block a push", async () => {
  const target = "2".repeat(40);
  const merged = "a".repeat(40);
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release", suite: ["pnpm turbo run lint test"] },
      items: [{ id: "D03", title: "Batch", acceptance: { text: "b" } }, { id: "D04", title: "Breaks", acceptance: { text: "c" } }],
    },
    seed: { version: 1, items: { D03: { state: "integrating", attempts: 1 }, D04: { state: "integrating", attempts: 1 } } },
  });
  try {
    f.ports.revParse = async (_repo, ref) => (ref === "refs/remotes/origin/feature/release" ? target : undefined);
    // Pass 1: the baseline lane is dispatched at the target tip, and D03's integration too.
    await f.advance();
    const baselinePlan = f.calls.plan.find((call) => call.specStage === "baseline");
    assert.ok(baselinePlan, "a baseline lane runs the suite at the target tip");
    assert.match(baselinePlan.laneObjective, new RegExp(`git checkout -q --detach ${target}`));
    assert.match(baselinePlan.laneObjective, /FAILED: <package> <task>/);
    assert.ok(f.calls.worktree.some((call) => call.branch === "spec-baseline"));
    let state = await f.state();
    const baselineLane = state.baselineRun.lane;
    const d03 = state.items.D03.lane;
    // Turborepo output pasted into both receipts: the same three lint errors.
    const turbo = [
      "@acme/ticket-service#lint: command (/repo/apps/services/ticket) /usr/bin/pnpm run lint exited (1)",
      " Tasks:    41 successful, 42 total",
      "Failed:    @acme/ticket-service#lint",
    ].join("\n");
    await receive(f, baselineLane, `BASELINE: ${target}\nSUITE: fail\n${turbo}`, "baseline");
    await receive(f, d03, `INTEGRATED: ${merged}\nSUITE: fail\nFAILED: @acme/ticket-service lint`);
    await f.advance();
    state = await f.state();
    assert.deepEqual(state.baselines[target].failures, [{ package: "@acme/ticket-service", task: "lint" }]);
    assert.equal(state.baselineRun, undefined);
    assert.equal(state.items.D03.state, "awaiting-push", "its only failure is the target's own");
    assert.deepEqual(state.items.D03.integration.baselineFailures, [{ package: "@acme/ticket-service", task: "lint" }]);
    assert.deepEqual(state.items.D03.tests, [], "no acceptance tests of its own");
    // D04's integration names the known failures, then fails a new task too.
    const d04Plan = f.calls.plan.filter((call) => call.specStage === "integrate").at(-1);
    assert.match(d04Plan.laneObjective, /already fails these suite tasks at 222222222222 \(its baseline\): @acme\/ticket-service lint/);
    state = await f.state();
    const d04 = state.items.D04.lane;
    await receive(f, d04, `INTEGRATED: ${"b".repeat(40)}\nSUITE: fail\nFAILED: @acme/ticket-service lint\nFAILED: @acme/payment-service test`);
    const result = await f.advance();
    state = await f.state();
    assert.ok(["ready", "building"].includes(state.items.D04.state), "a new failure is a real one: back to its builder");
    assert.equal(state.items.D04.integration, undefined);
    assert.match(state.items.D04.findings, /tasks the target does not already fail: @acme\/payment-service test/);
    void result;
    const alerts = (await f.manifest()).rootSupervision.flatMap((entry) => entry.alerts ?? []);
    assert.ok(alerts.some((alert) => alert.kind === "spec-push-ready" && /known baseline failures, not from these items\): @acme\/ticket-service lint/.test(alert.text)), "the push ask lists them");
  } finally {
    await f.cleanup();
  }
});

test("with defaults.fixBaseline one lane fixes the baseline first; integrations wait, then judge against what remains", async () => {
  const target = "3".repeat(40);
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release", suite: ["pnpm -r lint", "pnpm -r test"] },
      defaults: { fixBaseline: true },
      items: [{ id: "D12", title: "Batch", acceptance: { text: "b" } }],
    },
    seed: {
      version: 1,
      items: { D12: { state: "integrating", attempts: 1 } },
      baselines: { [target]: { suite: "fail", failures: [{ package: "@acme/ticket-service", task: "lint" }, { package: "@acme/web", task: "test" }], at: "t" } },
    },
  });
  try {
    f.ports.revParse = async () => target;
    const first = await f.advance();
    const fix = f.calls.plan.find((call) => call.objective.startsWith("spec fix-baseline"));
    assert.ok(fix, "one fix-baseline lane");
    assert.equal(fix.specStage, "integrate", "it holds the integration worktree");
    assert.match(fix.laneObjective, /already fails: @acme\/ticket-service lint, @acme\/web test/);
    assert.equal(f.calls.plan.filter((call) => call.objective.startsWith("spec D12 integrate")).length, 0, "no integration while it runs");
    assert.match(first.content[0].text, /fixing the target's baseline failures first/);
    let state = await f.state();
    const lane = state.baselineRun.lane;
    // pnpm output: the lint error is fixed, one test failure remains.
    await receive(f, lane, `INTEGRATED: ${"c".repeat(40)}\nSUITE: fail\n ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @acme/web@1.0.0 test: \`vitest run\``);
    await f.advance();
    state = await f.state();
    assert.deepEqual(state.baselines[target].fix.remaining, [{ package: "@acme/web", task: "test" }]);
    const integrate = f.calls.plan.find((call) => call.objective.startsWith("spec D12 integrate"));
    assert.ok(integrate, "then the item integrates");
    assert.match(integrate.laneObjective, /its baseline\): @acme\/web test\./);
    assert.doesNotMatch(integrate.laneObjective, /ticket-service/, "the fixed failure is no longer known");
  } finally {
    await f.cleanup();
  }
});

test("a lock whose owner is no live working agent is reclaimed: the next integration starts and the root is told", async () => {
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      items: [{ id: "D04", title: "Declined", acceptance: { text: "a" } }, { id: "D12", title: "Next", acceptance: { text: "b" } }],
    },
    // D04's integrate lane went idle without a receipt; the ask escalated and blocked the item, but it still points at the lane.
    seed: {
      version: 1,
      items: {
        D04: { state: "blocked", blockedReason: "human-gate", attempts: 1, lane: { workflowId: "herdr-9d", laneId: "lane-1" }, laneStage: "integrate", receiptEscalatedAt: "2026-09-24T10:00:00.000Z" },
        D12: { state: "integrating", attempts: 1 },
      },
    },
  });
  try {
    const manifest = await f.manifest();
    manifest.workflows.push({
      id: "herdr-9d",
      status: "running",
      lanes: [{ id: "lane-1", status: "running", specStage: "integrate", paneId: "w-spec:p9" }],
      eventController: { events: [{ lane_id: "lane-1", source: { agent_status: "done" } }] },
      evidence: [],
    });
    await writeFile(join(f.stateDir, "manifest.json"), JSON.stringify(manifest));
    // Herdr still has the (idle) agent in that pane: it is not working.
    f.ports.agentPresent = async () => false;
    const result = await f.advance();
    assert.deepEqual(f.calls.plan.filter((call) => call.specStage === "integrate").map((call) => call.objective), ["spec D12 integrate: Next"], "the queue moves on");
    const state = await f.state();
    assert.ok(state.items.D04.lockReclaimedAt);
    assert.equal(state.items.D04.state, "blocked", "the blocked item is left for the root to resolve");
    assert.match(state.items.D04.history.at(-1).note, /released the integration worktree: its integrate lane herdr-9d is done and the item is blocked/);
    const alerts = (await f.manifest()).rootSupervision.flatMap((entry) => entry.alerts ?? []);
    assert.ok(alerts.some((alert) => /Reclaimed the spec-integration lock from D04's integrate lane herdr-9d/.test(alert.text)), "the root is told once");
    assert.doesNotMatch(result.content[0].text, /integration worktree busy/);
    await f.advance();
    const again = (await f.manifest()).rootSupervision.flatMap((entry) => entry.alerts ?? []).filter((alert) => /Reclaimed/.test(alert.text));
    assert.equal(again.length, 1, "reported once, not every pass");
  } finally {
    await f.cleanup();
  }
});

test("a done lane still waited on in its stage keeps the lock (the receipt ask is running)", async () => {
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      items: [{ id: "D04", title: "Integrating", acceptance: { text: "a" } }, { id: "D12", title: "Next", acceptance: { text: "b" } }],
    },
    seed: {
      version: 1,
      items: {
        D04: { state: "integrating", attempts: 1, lane: { workflowId: "herdr-9d", laneId: "lane-1" }, laneStage: "integrate" },
        D12: { state: "integrating", attempts: 1 },
      },
    },
  });
  try {
    const manifest = await f.manifest();
    manifest.workflows.push({ id: "herdr-9d", status: "running", lanes: [{ id: "lane-1", status: "running", specStage: "integrate", paneId: "w-spec:p9" }], eventController: { events: [{ lane_id: "lane-1", source: { agent_status: "done" } }] }, evidence: [] });
    await writeFile(join(f.stateDir, "manifest.json"), JSON.stringify(manifest));
    f.ports.agentPresent = async () => false;
    f.ports.tell = async () => ({ message: { delivery: { status: "delivered" } } });
    await f.advance();
    assert.equal(f.calls.plan.filter((call) => call.specStage === "integrate").length, 0);
    assert.equal((await f.state()).items.D04.lockReclaimedAt, undefined);
  } finally {
    await f.cleanup();
  }
});

test("a declined lane is retried with its reason, then with a fallback profile, and only then goes to the root", async () => {
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      defaults: { maxDeclines: 1 },
      stages: { integrate: { profile: "balanced", fallbackProfiles: ["deep"] } },
      items: [{ id: "D12", title: "Lint repair", acceptance: { text: "b" } }],
    },
    seed: { version: 1, items: { D12: { state: "integrating", attempts: 1 } } },
  });
  try {
    const decline = async (summary) => {
      const ref = (await f.state()).items.D12.lane;
      await receive(f, ref, summary);
      return f.advance();
    };
    await f.advance();
    const integrates = () => f.calls.plan.filter((call) => call.specStage === "integrate");
    assert.equal(integrates().length, 1);
    assert.match(integrates()[0].laneObjective, /finish with herdr_complete whose summary starts with DECLINED:/, "every lane is told how to decline");
    await decline("DECLINED: fixing the lint errors needs a rule suppression I should not add");
    let state = await f.state();
    assert.equal(state.items.D12.state, "integrating", "not blocked, not asked");
    assert.equal(integrates().length, 2, "retried at once");
    assert.equal(integrates()[1].taskProfile, "deep", "after maxDeclines, the fallback profile");
    assert.match(integrates()[1].laneObjective, /An earlier lane for this integrate declined it \(1 time\(s\)\), saying: "fixing the lint errors needs a rule suppression I should not add"/);
    assert.match(integrates()[1].objective, /retry 1: declined/);
    assert.match(state.items.D12.history.at(-1).note, /did not finish \(declined, 1\).*retrying with profile deep/);
    const result = await decline("I must decline this task: it touches a service outside my scope.");
    state = await f.state();
    assert.equal(state.items.D12.state, "blocked", "every configured profile declined");
    assert.equal(integrates().length, 2);
    const alerts = (await f.manifest()).rootSupervision.flatMap((entry) => entry.alerts ?? []);
    assert.ok(alerts.some((alert) => /2 integrate lane\(s\) did not finish, with every profile/.test(alert.text)));
    assert.equal(state.items.D12.blockedReason, "exhausted", "human-gate is for push, deploy, production and scope");
    assert.match(result.content[0].text, /D12/);
  } finally {
    await f.cleanup();
  }
});

test("an integrate lane idle without a receipt: already merged is integrated, otherwise a fresh lane", async () => {
  const merged = "d".repeat(40);
  const f = await fixture({
    specDocument: { version: 1, target: { repo: ".", remote: "origin", branch: "feature/release" }, items: [{ id: "D03", title: "Merged", acceptance: { text: "a" } }] },
    seed: { version: 1, items: { D03: { state: "integrating", attempts: 1, branch: "demo/d03", lane: { workflowId: "herdr-i3", laneId: "lane-1" }, laneStage: "integrate", receiptAskedAt: "2026-09-24T11:00:00.000Z" } } },
  });
  try {
    const manifest = await f.manifest();
    manifest.workflows.push({ id: "herdr-i3", status: "running", lanes: [{ id: "lane-1", status: "running", specStage: "integrate", paneId: "w-spec:p3" }], eventController: { events: [{ lane_id: "lane-1", source: { agent_status: "done" } }] }, evidence: [] });
    await writeFile(join(f.stateDir, "manifest.json"), JSON.stringify(manifest));
    f.ports.agentPresent = async () => false;
    f.ports.containingCommit = async (_repo, tip) => (tip === "demo/d03" ? merged : undefined);
    await f.advance();
    const state = await f.state();
    assert.equal(state.items.D03.state, "awaiting-push", "its commits were already on spec-integration");
    assert.deepEqual([state.items.D03.integration.sha, state.items.D03.integration.contained], [merged, true]);
    assert.equal(f.calls.plan.filter((call) => call.specStage === "integrate").length, 0, "no fresh lane needed");
  } finally {
    await f.cleanup();
  }
});

test("a hold caused only by a regenerated artifact resumes without a deploy and is restored from HEAD, staged or not", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp: mkd } = await import("node:fs/promises");
  const { tmpdir: tmp } = await import("node:os");
  const repo = await mkd(join(tmp(), "baa-generated-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env }).trim();
  git("init", "-q", "-b", "demo/d02");
  await mkdir(join(repo, "apps", "pay"), { recursive: true });
  await writeFile(join(repo, "apps", "pay", "openapi-spec.json"), "{\"v\":1}\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  await writeFile(join(repo, "apps", "pay", "openapi-spec.json"), "{\"v\":2}\n");
  git("add", "apps/pay/openapi-spec.json");
  const f = await fixture({
    specDocument: { version: 1, target: { repo: ".", remote: "origin", branch: "feature/release" }, items: [{ id: "D02", title: "Payments", owns: ["src/d02/**"], acceptance: { text: "d" } }] },
    seed: {
      version: 1,
      items: {
        D02: {
          state: "blocked",
          blockedReason: "human-gate",
          blockedCause: "tracked-outside",
          blockedByCode: "code-now",
          note: "uncommitted changes outside the item's owns and sharedTouch: apps/pay/openapi-spec.json",
          worktree: repo,
          branch: "demo/d02",
          adopted: { worktree: repo, branch: "demo/d02" },
          history: [{ at: "t", from: "building", to: "blocked" }],
        },
      },
    },
  });
  try {
    f.ports.codeVersion = "code-now";
    delete f.ports.restore;
    delete f.ports.status;
    await f.advance();
    const state = await f.state();
    assert.equal(git("status", "--porcelain"), "", "restored from HEAD, index included");
    assert.ok(state.items.D02.history.some((entry) => entry.note === "resumed: only generated artifacts were outside its files"), "resumed under the same code");
    assert.ok(state.items.D02.history.some((entry) => /restored generated artifacts to HEAD/.test(entry.note ?? "")));
    assert.equal(state.items.D02.state, "building");
    assert.equal(f.calls.plan.filter((call) => call.specStage === "build").length, 1, "and its build runs");
  } finally {
    await f.cleanup();
  }
});

test("a lane that cannot start is an infrastructure error: never counted, retried after a growing wait on the same profile", async () => {
  const f = await fixture({
    specDocument: {
      version: 1,
      target: { repo: ".", remote: "origin", branch: "feature/release" },
      defaults: { maxDeclines: 1 },
      stages: { review: { profile: "review", fallbackProfiles: ["review-alt"] } },
      items: [{ id: "D05", title: "Review me", acceptance: { text: "r" } }],
    },
    seed: { version: 1, items: { D05: { state: "reviewing", attempts: 1 } } },
  });
  try {
    let failing = true;
    const plan = f.ports.plan;
    f.ports.plan = async (input) => {
      if (failing) {
        f.calls.plan.push(input);
        throw new Error("worktreeCwd must be clean before Herdr dispatch");
      }
      return plan(input);
    };
    let clock = Date.parse("2026-09-24T12:00:00.000Z");
    f.ports.now = () => new Date(clock).toISOString();
    await f.advance();
    let state = await f.state();
    assert.equal(state.items.D05.state, "reviewing", "never exhausted");
    assert.equal(state.items.D05.infraFailures, 1);
    assert.equal(state.items.D05.infraRetryAfter, "2026-09-24T12:01:00.000Z", "one minute, then doubling");
    const tries = () => f.calls.plan.filter((call) => call.specStage === "review").length;
    assert.equal(tries(), 1);
    await f.advance();
    assert.equal(tries(), 1, "no retry before the wait is over");
    // Keep failing: five in a row alert the root once; still never exhausted.
    for (let failures = 1; failures < 6; failures += 1) {
      clock += 31 * 60_000;
      await f.advance();
    }
    state = await f.state();
    assert.equal(state.items.D05.state, "reviewing");
    assert.equal(state.items.D05.blockedReason, undefined);
    const alerts = ((await f.manifest()).rootSupervision ?? []).flatMap((entry) => entry.alerts ?? []).filter((alert) => /failed to start/.test(alert.text));
    assert.equal(alerts.length, 1);
    failing = false;
    clock += 31 * 60_000;
    await f.advance();
    const last = f.calls.plan.filter((call) => call.specStage === "review").at(-1);
    assert.equal(last.taskProfile, "review", "no fallback: the lane never ran, so its profile was never the problem");
  } finally {
    await f.cleanup();
  }
});

test("an item exhausted only by infrastructure errors is re-armed once per driver version", async () => {
  const f = await fixture({
    specDocument: { version: 1, target: { repo: ".", remote: "origin", branch: "feature/release" }, items: [{ id: "D03", title: "Pushed", acceptance: { text: "p" } }, { id: "D11", title: "Real", acceptance: { text: "r" } }] },
    seed: {
      version: 1,
      items: {
        D03: { state: "blocked", blockedReason: "exhausted", integratedSha: "3".repeat(40), declines: [{ at: "t", stage: "verify", kind: "never started", reason: "worktreeCwd must be clean" }, { at: "t", stage: "verify", kind: "never started", reason: "worktreeCwd must be clean" }] },
        D11: { state: "blocked", blockedReason: "exhausted", declines: [{ at: "t", stage: "review", kind: "declined", reason: "out of scope" }, { at: "t", stage: "review", kind: "declined", reason: "out of scope" }] },
      },
    },
  });
  try {
    f.ports.codeVersion = "code-a";
    await f.advance();
    let state = await f.state();
    assert.equal(state.items.D03.state, "verifying", "back to verification");
    assert.equal(state.items.D03.rearmedByCode, "code-a");
    assert.ok(state.items.D03.history.some((entry) => /re-armed: verify was exhausted only by infrastructure errors/.test(entry.note ?? "")));
    assert.equal(state.items.D11.state, "blocked", "real declines stay exhausted");
  } finally {
    await f.cleanup();
  }
});

test("under the spec-push grant a green round is pushed by the driver, with no root turn", async () => {
  const head = "9".repeat(40);
  const f = await fixture({
    grants: ["dispatch", "integrate", "spec-push"],
    specDocument: { version: 1, target: { repo: ".", remote: "origin", branch: "feature/release" }, items: [{ id: "D03", title: "A", acceptance: { text: "a" } }, { id: "D04", title: "B", acceptance: { text: "b" } }] },
    seed: {
      version: 1,
      items: {
        D03: { state: "awaiting-push", integration: { sha: "8".repeat(40), order: 1 } },
        D04: { state: "awaiting-push", integration: { sha: head, order: 2 } },
      },
    },
  });
  try {
    const pushes = [];
    f.ports.push = async (input) => {
      pushes.push(input);
      f.pushedShas.add(head);
      f.pushedShas.add("8".repeat(40));
    };
    const result = await f.advance();
    assert.deepEqual(pushes.map((push) => [push.remote, push.sha, push.branch]), [["origin", head, "feature/release"]]);
    assert.match(result.content[0].text, /pushed D03, D04 to origin\/feature\/release/);
    const alerts = ((await f.manifest()).rootSupervision ?? []).flatMap((entry) => entry.alerts ?? []);
    assert.equal(alerts.filter((alert) => alert.kind === "spec-push-ready").length, 0, "no push ask for the root");
    const state = await f.state();
    assert.match(state.items.D04.history.at(-1).note, /pushed to origin\/feature\/release at 999999999999 under the spec-push grant/);
    await f.advance();
    assert.ok(["verifying", "done"].includes((await f.state()).items.D04.state), "the next pass sees it on the target");
  } finally {
    await f.cleanup();
  }
});

test("without the grant the push stays with the root; while the run is paused the driver does nothing", async () => {
  const f = await fixture({
    specDocument: { version: 1, target: { repo: ".", remote: "origin", branch: "feature/release" }, items: [{ id: "D03", title: "A", acceptance: { text: "a" } }, { id: "D06", title: "Next", acceptance: { text: "n" } }] },
    seed: { version: 1, items: { D03: { state: "awaiting-push", integration: { sha: "8".repeat(40), order: 1 } } } },
  });
  const saved = process.env.BAATON_OPERATOR_STORE;
  const { mkdtemp: mkd } = await import("node:fs/promises");
  const { tmpdir: tmp } = await import("node:os");
  const storeDir = await mkd(join(tmp(), "baa-run-"));
  try {
    f.ports.push = async () => assert.fail("no push without the grant");
    await f.advance();
    const alerts = ((await f.manifest()).rootSupervision ?? []).flatMap((entry) => entry.alerts ?? []);
    assert.equal(alerts.filter((alert) => alert.kind === "spec-push-ready").length, 1);
    process.env.BAATON_OPERATOR_STORE = join(storeDir, "operator.json");
    await writeFile(process.env.BAATON_OPERATOR_STORE, JSON.stringify({ version: 1, agents: {}, messages: [], runState: { state: "paused", by: "zach", at: "t" } }));
    const plans = f.calls.plan.length;
    const paused = await f.advance();
    assert.match(paused.content[0].text, /the run is paused by zach/);
    assert.equal(f.calls.plan.length, plans, "nothing dispatched while paused");
  } finally {
    if (saved === undefined) delete process.env.BAATON_OPERATOR_STORE;
    else process.env.BAATON_OPERATOR_STORE = saved;
    await rm(storeDir, { recursive: true, force: true });
    await f.cleanup();
  }
});

test("a baseline lane idle without its receipt is asked once, then replaced by a fresh lane", async () => {
  const target = "7".repeat(40);
  const f = await fixture({
    specDocument: { version: 1, target: { repo: ".", remote: "origin", branch: "feature/release", suite: ["npm test"] }, items: [{ id: "D17", title: "Footer", acceptance: { text: "f" } }] },
    seed: { version: 1, items: { D17: { state: "integrating", attempts: 1 } }, baselineRun: { kind: "baseline", targetSha: target, attempts: 1, requestedAt: "2026-09-24T11:00:00.000Z", lane: { workflowId: "herdr-base", laneId: "lane-1" } } },
  });
  try {
    f.ports.revParse = async () => target;
    const manifest = await f.manifest();
    manifest.workflows.push({ id: "herdr-base", status: "awaiting-explicit-outcome", lanes: [{ id: "lane-1", status: "done", specStage: "baseline", paneId: "w-spec:p5" }], eventController: { events: [{ lane_id: "lane-1", source: { agent_status: "done" } }] }, evidence: [] });
    await writeFile(join(f.stateDir, "manifest.json"), JSON.stringify(manifest));
    const told = [];
    f.ports.tell = async (input) => (told.push(input), { message: { delivery: { status: "delivered" } } });
    await f.advance();
    assert.equal(told.length, 1);
    assert.match(told[0].text, new RegExp(`BASELINE: ${target}`));
    f.ports.now = () => "2026-09-24T12:31:00.000Z";
    await f.advance();
    const state = await f.state();
    assert.equal(state.baselineRun.attempts, 2);
    assert.ok(f.calls.plan.some((call) => call.specStage === "baseline"), "a fresh baseline lane");
  } finally {
    await f.cleanup();
  }
});

test("a queued item merged with rewritten commits is found by its spec(<id>) commit and recorded as integrated", async () => {
  const merged = "6".repeat(40);
  const f = await fixture({
    specDocument: { version: 1, target: { repo: ".", remote: "origin", branch: "feature/release" }, items: [{ id: "D15", title: "Rewritten", acceptance: { text: "r" } }] },
    seed: { version: 1, items: { D15: { state: "integrating", attempts: 1, branch: "demo/d15" } } },
  });
  try {
    f.ports.containingCommit = async () => undefined;
    f.ports.historyCommit = async (_repo, id) => (id === "D15" ? merged : undefined);
    await f.advance();
    const state = await f.state();
    assert.equal(state.items.D15.state, "awaiting-push");
    assert.deepEqual([state.items.D15.integration.sha, state.items.D15.integration.contained], [merged, true]);
  } finally {
    await f.cleanup();
  }
});

test("an evidence report rewritten by a newer valid run is re-recorded, and the item finishes", async () => {
  const sha = "5".repeat(40);
  const { mkdtemp: mkd } = await import("node:fs/promises");
  const { tmpdir: tmp } = await import("node:os");
  const reportDir = await mkd(join(tmp(), "baa-evidence-"));
  const reportPath = join(reportDir, "d29.docx");
  await writeDemo(reportPath, 3);
  const f = await fixture({
    specDocument: { version: 1, target: { repo: ".", remote: "origin", branch: "feature/release" }, items: [{ id: "D29", title: "Evidence", acceptance: { text: "e", evidence: { report: "artifacts/d29.docx", minImages: 2 } } }] },
    seed: { version: 1, items: { D29: { state: "verifying", integratedSha: sha, verified: "2026-09-24T11:00:00.000Z", evidence: { path: reportPath, sha256: "0".repeat(64), images: 2, reportAt: "2026-09-24T11:00:00.000Z" } } } },
  });
  try {
    f.pushedShas.add(sha);
    await f.advance();
    const after = await f.state();
    assert.equal(after.items.D29.state, "done");
    assert.ok(after.items.D29.history.some((entry) => /evidence report changed by a newer run \(3 images\): re-recorded/.test(entry.note ?? "")));
  } finally {
    await f.cleanup();
    await rm(reportDir, { recursive: true, force: true });
  }
});

test("a fresh integrate lane starts from a clean integration worktree: leftover staged or half-merged work is saved and aborted", async () => {
  const f = await fixture({
    specDocument: { version: 1, target: { repo: ".", remote: "origin", branch: "feature/release" }, items: [{ id: "D17", title: "Footer", acceptance: { text: "f" } }] },
    seed: { version: 1, items: { D17: { state: "integrating", attempts: 1 } } },
  });
  try {
    const cleaned = [];
    f.ports.cleanIntegration = async (input) => (cleaned.push(input), { merging: true, files: 4 });
    const result = await f.advance();
    assert.equal(cleaned.length, 1);
    assert.equal(cleaned[0].worktree, join(f.worktreeRoot, "spec-integration"));
    assert.match(cleaned[0].patchPath, /aborted-integrations\/D17-.*\.patch$/);
    assert.match(result.content[0].text, /cleaned spec-integration before integrating D17/);
    const integrate = f.calls.plan.find((call) => call.specStage === "integrate");
    assert.match(integrate.laneObjective, /git merge --abort/, "and lanes are told never to leave it staged");
    assert.ok((await f.state()).items.D17.history.some((entry) => /half-done merge \(4 file\(s\)\).*saved as a patch and aborted/.test(entry.note ?? "")));
  } finally {
    await f.cleanup();
  }
});

test("spec lanes whose receipt the driver consumed are retired under the retire grant", async () => {
  const receipt = { id: "r", summary: "Done.", delivery: "delivered" };
  const seedManifest = async (f) => {
    const manifest = await f.manifest();
    manifest.workflows.push(
      { id: "herdr-b1", status: "completed", ownership: { createdBy: "herdr-orchestrator", paneIds: [] }, lanes: [{ id: "lane-1", status: "completion-reported", specStage: "build", completionReceipt: receipt, tabId: "t1" }], evidence: [] },
      { id: "herdr-r1", status: "running", ownership: { createdBy: "herdr-orchestrator", paneIds: [] }, lanes: [{ id: "lane-1", status: "completion-reported", specStage: "review", completionReceipt: receipt, tabId: "t2" }], evidence: [] },
      { id: "herdr-old", status: "completed", ownership: { createdBy: "herdr-orchestrator", paneIds: [] }, lanes: [{ id: "lane-1", status: "completion-reported", completionReceipt: receipt, tabId: "t3" }], evidence: [] },
      { id: "herdr-done", status: "completed", ownership: { createdBy: "herdr-orchestrator", paneIds: [] }, lanes: [{ id: "lane-1", status: "completion-reported", specStage: "build", completionReceipt: receipt, retirement: { status: "retired" } }], evidence: [] },
    );
    await writeFile(join(f.stateDir, "manifest.json"), JSON.stringify(manifest));
  };
  const spec = {
    version: 1,
    target: { repo: ".", remote: "origin", branch: "feature/release" },
    items: [{ id: "A", title: "A", acceptance: { text: "a" } }],
  };
  // The review lane herdr-r1 has a receipt the driver has not consumed yet
  // only if the item still points at it: make it point there.
  const seed = { version: 1, items: { A: { state: "blocked", blockedReason: "human-gate", attempts: 1, lane: { workflowId: "herdr-r1", laneId: "lane-1" } } } };
  const f = await fixture({ grants: ["dispatch", "integrate", "retire"], specDocument: spec, seed });
  try {
    await seedManifest(f);
    const retired = [];
    f.ports.retire = async (candidate) => retired.push(`${candidate.workflowId}/${candidate.laneId}`);
    const result = await f.advance();
    assert.deepEqual(retired, ["herdr-b1/lane-1"], "only the consumed spec lane: not the item's current lane, a non-spec lane or an already retired one");
    assert.match(result.content[0].text, /retired herdr-b1\/lane-1/);
  } finally {
    await f.cleanup();
  }
  const noGrant = await fixture({ specDocument: spec, seed });
  try {
    await seedManifest(noGrant);
    const retired = [];
    noGrant.ports.retire = async (candidate) => retired.push(candidate.workflowId);
    await noGrant.advance();
    assert.deepEqual(retired, [], "without the retire grant nothing is retired");
  } finally {
    await noGrant.cleanup();
  }
});
