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
    async emit(event) {
      for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
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
  const names = ["word/document.xml", ...Array.from({ length: images }, (_, index) => `word/media/image${index + 1}.png`)];
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of names) {
    const bytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(bytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(bytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, bytes);
    centrals.push(central, bytes);
    offset += 30 + bytes.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
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
    assert.equal(verify.worktree, join(f.worktreeRoot, "spec-integration"));
    assert.match(verify.laneObjective, /artifacts\/a\.final\.docx/);

    await mkdir(join(f.worktreeRoot, "spec-integration", "artifacts"), { recursive: true });
    await writeFile(join(f.worktreeRoot, "spec-integration", "artifacts", "a.final.docx"), docx(2));
    f.pushedShas.add(sha);
    await f.laneReceipt("herdr-spec1", "PREVIEW: e2e/a.spec.ts pass\nREPORT: artifacts/a.final.docx");
    result = await f.advance();
    assert.match(result.content[0].text, /done A/);
    const state = await f.state();
    assert.equal(state.items.A.state, "done");
    assert.equal(state.items.A.evidence.images, 2);
    assert.equal(state.items.A.evidence.path, join(f.worktreeRoot, "spec-integration", "artifacts", "a.final.docx"));
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

test("a lane idle without its receipt is asked once, then handed to the root; a gone lane is retried in place", async () => {
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
    f.ports.now = () => "2026-09-24T12:31:00.000Z";
    await f.advance();
    state = await f.state();
    assert.equal(state.items.IDLE.state, "blocked");
    const asks = (await f.manifest()).rootSupervision[0].alerts.map((alert) => alert.text);
    assert.ok(asks.some((text) => /IDLE: its review lane herdr-idle\/lane-1 went idle without a receipt and did not answer the ask/.test(text)));
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
    assert.equal(state.items.OTHER.state, "blocked", "other human-gate causes are never retried automatically");
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

test("an open integrate lane keeps spec-integration reserved, even idle without a receipt on a blocked item", async () => {
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
    assert.equal(f.calls.plan.filter((call) => call.specStage === "integrate").length, 0, "no second integrate lane in spec-integration");
    assert.match(first.content[0].text, /D12 waits: integration worktree busy: D11's lane herdr-int1 is still open/);

    const closed = await f.manifest();
    closed.workflows.find((item) => item.id === "herdr-int1").status = "closed";
    await writeFile(join(f.stateDir, "manifest.json"), JSON.stringify(closed));
    await f.advance();
    assert.deepEqual(f.calls.plan.filter((call) => call.specStage === "integrate").map((call) => call.objective), ["spec D12 integrate: Next"], "once that workflow is closed, the next integration starts");
  } finally {
    await f.cleanup();
  }
});
