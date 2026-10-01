import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { formatPlan, planControllerCleanup, planReset, probeRootLiveness, resetFingerprint, runReset, STATE_SUBPATH } from "../reset.mjs";

function project() {
  const root = mkdtempSync(join(tmpdir(), "reset-"));
  const dir = join(root, STATE_SUBPATH);
  mkdirSync(dir, { recursive: true });
  const intent = join(dir, "herdr-00000001-lane-1-startup.json");
  const manifest = {
    version: 2,
    approvalPolicyAck: { hash: "abc" },
    queue: { items: [{ id: "q" }] },
    leases: [{ id: "l1" }, { id: "l2", releasedAt: "2026-01-01" }],
    workflows: [
      { id: "herdr-00000001", status: "running", worktree: { path: "/w/worktree-a" }, lanes: [{ id: "lane-1", tabId: "w1:t2", status: "running", startupIntentPath: intent }] },
      { id: "herdr-00000002", status: "completed", lanes: [{ id: "lane-1", tabId: "w1:t9", status: "done", retirement: { status: "retired" } }, { id: "lane-2", tabId: "w1:t1", status: "running" }] },
    ],
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  for (const name of ["herdr-00000001-lane-1-startup.json", "herdr-00000001-lane-1-startup.json.ready", "claude-mcp-aaaaaaaa.json", "manifest.json.pre-old", "spec-state.json", "spec.json", "known-safe-approvals.jsonl"]) writeFileSync(join(dir, name), "x");
  return { root, dir };
}
const ports = (closed) => ({ rootTabIds: new Set(["w1:t1"]), closeTab: (id) => closed.push(id), killLane: async () => ({}), env: {} });

test("the plan covers every lane tab except the root's own and lists worktrees without touching them", () => {
  const { root, dir } = project();
  try {
    const plan = planReset(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")), { stateDir: dir, names: readdirSync(dir), rootTabIds: new Set(["w1:t1"]), specStatePresent: true });
    assert.deepEqual(plan.tabs.map((tab) => tab.tabId).sort(), ["w1:t2", "w1:t9"]);
    assert.equal(plan.leases, 1);
    assert.deepEqual(plan.worktreesLeftAlone, ["/w/worktree-a"]);
    assert.match(formatPlan(plan), /dry run/);
    assert.ok(plan.keeps.includes("spec-state.json (progress)"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dry run changes nothing", async () => {
  const { root, dir } = project();
  const closed = [];
  try {
    const before = readFileSync(join(dir, "manifest.json"), "utf8");
    const result = await runReset({ projectRoot: root, ...ports(closed) });
    assert.equal(result.applied, false);
    assert.deepEqual(closed, []);
    assert.equal(readFileSync(join(dir, "manifest.json"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applying archives the manifest first, empties it, keeps config and spec progress, deletes lane files", async () => {
  const { root, dir } = project();
  const closed = [];
  try {
    const result = await runReset({ projectRoot: root, apply: true, ...ports(closed) });
    assert.equal(result.applied, true);
    assert.deepEqual(closed.sort(), ["w1:t2", "w1:t9"]);
    const fresh = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.deepEqual(fresh, { version: 2, workflows: [], approvalPolicyAck: { hash: "abc" } });
    const archive = readdirSync(join(dir, "archive")).find((name) => name.endsWith(".manifest.json.gz"));
    assert.equal(JSON.parse(gunzipSync(readFileSync(join(dir, "archive", archive))).toString()).workflows.length, 2);
    assert.deepEqual(readdirSync(dir).filter((name) => /^herdr-|^claude-|\.pre-/.test(name)), []);
    for (const kept of ["spec.json", "spec-state.json", "known-safe-approvals.jsonl"]) assert.ok(existsSync(join(dir, kept)), kept);
    assert.ok(!existsSync(join(dir, ".manifest.json.herdr-orchestrator.lock")), "lock released");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--include-spec archives and clears spec progress too", async () => {
  const { root, dir } = project();
  try {
    await runReset({ projectRoot: root, apply: true, includeSpec: true, ...ports([]) });
    assert.ok(!existsSync(join(dir, "spec-state.json")));
    assert.ok(readdirSync(join(dir, "archive")).some((name) => name.endsWith(".spec-state.json.gz")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inside Herdr, an unknown root tab refuses rather than risk closing the root", async () => {
  const { root, dir } = project();
  try {
    await assert.rejects(runReset({ projectRoot: root, apply: true, ...ports([]), rootTabIds: new Set(), env: { HERDR_PANE_ID: "w1:p1" } }), /cannot tell which tab holds this root/i);
    assert.equal(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).workflows.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native root liveness requires exact pane, workspace and session evidence", () => {
  const root = { id: "root-a", root: { pane_id: "p1", workspace_id: "w1" } };
  const manifest = { rootSessionLogs: [{ kind: "root", rootId: "root-a", paneId: "p1", workspaceId: "w1", sessionRef: { provider: "pi", sessionId: "session-old" } }] };
  const runFrom = (responses) => (args) => {
    const key = args.join(" ");
    if (responses[key] instanceof Error) throw responses[key];
    return JSON.stringify(responses[key]);
  };
  assert.equal(probeRootLiveness(root, manifest, runFrom({
    "pane get p1": { result: { pane: { pane_id: "p1", workspace_id: "w1" } } },
    "agent list": { result: { agents: [{ pane_id: "p1", workspace_id: "w1", agent_session: { value: "session-old" } }] } },
  })), "live");
  assert.deepEqual(probeRootLiveness(root, manifest, runFrom({
    "pane get p1": new Error("pane not found"),
    "workspace list": { result: { workspaces: [] } },
    "agent list": { result: { agents: [] } },
  })), "stale");
  const drift = probeRootLiveness(root, manifest, runFrom({
    "pane get p1": { result: { pane: { pane_id: "p1", workspace_id: "w1" } } },
    "agent list": { result: { agents: [{ pane_id: "p1", workspace_id: "w1", agent_session: { value: "session-new" } }] } },
  }));
  assert.deepEqual(drift, { status: "identity-drift", recoveryProof: { orchestratorId: "root-a", paneId: "p1", workspaceId: "w1", expectedSessionId: "session-old", observedSessionId: "session-new" } });
  assert.equal(probeRootLiveness(root, manifest, runFrom({
    "pane get p1": new Error("socket closed"),
  })), "ambiguous");
});

test("controller cleanup requires the exact workflow, manifest, program and root identity", () => {
  const projectRoot = "/work/project";
  const manifestPath = "/work/project/.baa-ton/herdr-orchestrator/manifest.json";
  const manifest = { workflows: [
    { id: "wf-target", taskBinding: { rootPaneId: "root-pane", workspaceId: "root-workspace" } },
    { id: "wf-target", taskBinding: { rootPaneId: "other-pane", workspaceId: "other-workspace" } },
  ] };
  const config = { orchestrators: [
    { id: "scoped", program: { id: projectRoot, parent_manifest_path: manifestPath }, root: { pane_id: "root-pane", workspace_id: "root-workspace" }, workflows: [
      { workflow_id: "wf-target", manifest_path: manifestPath, lanes: [] },
      { workflow_id: "elsewhere", manifest_path: "/another/manifest.json", lanes: [] },
    ] },
    { id: "concurrent", program: { id: projectRoot, parent_manifest_path: "/other/manifest.json" }, root: { pane_id: "other-pane", workspace_id: "other-workspace" }, workflows: [{ workflow_id: "wf-target", manifest_path: manifestPath, lanes: [] }] },
  ] };
  const plan = planControllerCleanup({ config, manifest: { workflows: [manifest.workflows[0]] }, projectRoot, manifestPath, rootLiveness: { scoped: "live" } });
  assert.deepEqual(plan.routes.map(({ orchestratorId, workflowId }) => [orchestratorId, workflowId]), [["scoped", "wf-target"]]);
  assert.deepEqual(plan.roots, [], "live root remains registered");
  assert.deepEqual(plan.blockers, []);
  const ambiguous = planControllerCleanup({ config, manifest: { workflows: [{ id: "wf-target" }] }, projectRoot, manifestPath, rootLiveness: { scoped: "live" } });
  assert.equal(ambiguous.routes.length, 0);
  assert.match(ambiguous.blockers.join(" "), /no unique recorded root/);
  const collision = planControllerCleanup({ config, manifest, projectRoot, manifestPath, rootLiveness: { scoped: "live" } });
  assert.equal(collision.routes.length, 0);
  assert.match(collision.blockers.join(" "), /2 matching manifest workflows/);
  const duplicateConfig = structuredClone(config);
  duplicateConfig.orchestrators[0].workflows.push(duplicateConfig.orchestrators[0].workflows[0]);
  const duplicateRoute = planControllerCleanup({ config: duplicateConfig, manifest: { workflows: [manifest.workflows[0]] }, projectRoot, manifestPath, rootLiveness: { scoped: "live" } });
  assert.equal(duplicateRoute.routes.length, 0);
  assert.match(duplicateRoute.blockers.join(" "), /controller route id occurs 2 times/);
});

test("controller root unregister requires authoritative stale pane/workspace/session proof", () => {
  const projectRoot = "/work/project";
  const manifestPath = "/work/project/.baa-ton/herdr-orchestrator/manifest.json";
  const config = { orchestrators: [{ id: "scoped", program: { id: projectRoot, parent_manifest_path: manifestPath }, root: { pane_id: "p1", workspace_id: "w1" }, workflows: [{ workflow_id: "wf", manifest_path: manifestPath, lanes: [] }] }] };
  const manifest = { workflows: [{ id: "wf", taskBinding: { rootPaneId: "p1", workspaceId: "w1" } }] };
  const stale = planControllerCleanup({ config, manifest, projectRoot, manifestPath, rootLiveness: { scoped: "stale" } });
  assert.equal(stale.routes.length, 1);
  assert.deepEqual(stale.roots, [{ orchestratorId: "scoped", rootPaneId: "p1", rootWorkspaceId: "w1", programId: projectRoot, liveness: "stale", routeCount: 1 }]);
  const uncertain = planControllerCleanup({ config, manifest, projectRoot, manifestPath, rootLiveness: { scoped: "ambiguous" } });
  assert.equal(uncertain.routes.length, 0);
  assert.match(uncertain.blockers.join(" "), /liveness is ambiguous/);
});

test("one-shot reset fingerprint is stable and a changed source inventory refuses before closures", async () => {
  const { root, dir } = project();
  const controllerConfigPath = join(dir, "controller-config.json");
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.workflows[0].taskBinding = { rootPaneId: "root-pane", workspaceId: "root-workspace", rootSessionPath: "/sessions/root" };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(controllerConfigPath, JSON.stringify({ version: 2, owner: "herdr-orchestrator", orchestrators: [{ id: "root-a", program: { id: root, parent_manifest_path: manifestPath }, root: { pane_id: "root-pane", workspace_id: "root-workspace" }, workflows: [{ workflow_id: manifest.workflows[0].id, manifest_path: manifestPath, lanes: [] }, { workflow_id: "other", manifest_path: "/other/manifest.json", lanes: [] }] }] }));
  const closed = [];
  const common = { projectRoot: root, controllerConfigPath, probeRoot: async () => "live", ...ports(closed) };
  try {
    const preview = await runReset(common);
    assert.match(preview.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(preview.fingerprint, resetFingerprint(preview.plan));
    assert.match(formatPlan(preview.plan), /root-a\/herdr-00000001 manifest=/);
    assert.match(formatPlan(preview.plan), /PID|pid/);
    const changed = JSON.parse(readFileSync(controllerConfigPath, "utf8"));
    changed.unrelated = "changed";
    writeFileSync(controllerConfigPath, JSON.stringify(changed));
    await assert.rejects(runReset({ ...common, apply: true, expectedFingerprint: preview.fingerprint }), /fingerprint changed/);
    assert.deepEqual(closed, []);
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).workflows.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("applying reset removes only exact scoped routes and preserves live and other-manifest roots", async () => {
  const { root, dir } = project();
  const controllerConfigPath = join(dir, "controller-config.json");
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.workflows[0].taskBinding = { rootPaneId: "root-pane", workspaceId: "root-workspace", rootSessionPath: "/sessions/root" };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const config = { version: 2, owner: "herdr-orchestrator", orchestrators: [
    { id: "root-a", program: { id: root, parent_manifest_path: manifestPath }, root: { pane_id: "root-pane", workspace_id: "root-workspace" }, workflows: [{ workflow_id: manifest.workflows[0].id, manifest_path: manifestPath, lanes: [] }, { workflow_id: "other", manifest_path: "/other/manifest.json", lanes: [] }] },
    { id: "concurrent", program: { id: "/elsewhere", parent_manifest_path: "/elsewhere/manifest.json" }, root: { pane_id: "live-pane", workspace_id: "live-workspace" }, workflows: [{ workflow_id: "shared", manifest_path: "/elsewhere/manifest.json", lanes: [] }] },
  ] };
  writeFileSync(controllerConfigPath, JSON.stringify(config));
  const closed = [];
  try {
    const preview = await runReset({ projectRoot: root, controllerConfigPath, probeRoot: async () => "live", ...ports(closed) });
    assert.match(formatPlan(preview.plan), /concurrent\/shared manifest=\/elsewhere\/manifest.json/);
    assert.match(formatPlan(preview.plan), /root-a .*action=preserve live root/);
    const result = await runReset({ projectRoot: root, controllerConfigPath, probeRoot: async () => "live", expectedFingerprint: preview.fingerprint, apply: true, ...ports(closed) });
    assert.equal(result.applied, true);
    const next = JSON.parse(readFileSync(controllerConfigPath, "utf8"));
    assert.deepEqual(next.orchestrators.map((entry) => entry.id), ["root-a", "concurrent"]);
    assert.deepEqual(next.orchestrators[0].workflows.map((entry) => entry.workflow_id), ["other"]);
    assert.deepEqual(next.orchestrators[1], config.orchestrators[1]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("identity drift is recoverable only with exact pane/workspace and old/new native-session proof", () => {
  const { root, dir } = project();
  const manifestPath = join(dir, "manifest.json");
  const config = { orchestrators: [{ id: "root-a", program: { id: root, parent_manifest_path: manifestPath }, root: { pane_id: "root-pane", workspace_id: "root-workspace" }, workflows: [{ workflow_id: "herdr-00000001", manifest_path: manifestPath, lanes: [] }] }] };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.workflows[0].taskBinding = { rootPaneId: "root-pane", workspaceId: "root-workspace" };
  try {
    const planned = planControllerCleanup({ config, manifest, projectRoot: root, manifestPath, rootLiveness: { "root-a": "stale" } });
    assert.equal(planned.roots.length, 1);
    const driftProof = { paneId: "root-pane", workspaceId: "root-workspace", expectedSessionId: "old-session", observedSessionId: "new-session" };
    const recovered = planControllerCleanup({ config, manifest, projectRoot: root, manifestPath, rootLiveness: { "root-a": { status: "identity-drift", recoveryProof: driftProof } } });
    assert.equal(recovered.routes.length, 1, "only exact stale workflow routes are removed");
    assert.deepEqual(recovered.roots, [], "the recovered live root remains registered");
    const ambiguous = planControllerCleanup({ config, manifest, projectRoot: root, manifestPath, rootLiveness: { "root-a": { status: "identity-drift", recoveryProof: { ...driftProof, workspaceId: "wrong-workspace" } } } });
    assert.equal(ambiguous.routes.length, 0);
    assert.match(ambiguous.blockers.join(" "), /identity-drift/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a root identity change before the durable reset commit leaves config and manifest intact", async () => {
  const { root, dir } = project();
  const manifestPath = join(dir, "manifest.json");
  const controllerConfigPath = join(dir, "controller-config.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.workflows[0].taskBinding = { rootPaneId: "root-pane", workspaceId: "root-workspace" };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const config = { version: 2, owner: "herdr-orchestrator", orchestrators: [{ id: "root-a", program: { id: root, parent_manifest_path: manifestPath }, root: { pane_id: "root-pane", workspace_id: "root-workspace" }, workflows: [{ workflow_id: manifest.workflows[0].id, manifest_path: manifestPath, lanes: [] }] }] };
  writeFileSync(controllerConfigPath, JSON.stringify(config));
  const beforeManifest = readFileSync(manifestPath, "utf8");
  const beforeConfig = readFileSync(controllerConfigPath, "utf8");
  let probes = 0;
  try {
    await assert.rejects(runReset({ projectRoot: root, controllerConfigPath, probeRoot: async () => (++probes < 3 ? "live" : "stale"), apply: true, ...ports([]) }), /root-a identity\/liveness changed/);
    assert.equal(readFileSync(manifestPath, "utf8"), beforeManifest);
    assert.equal(readFileSync(controllerConfigPath, "utf8"), beforeConfig);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reset unregisters the last exact stale project root but preserves its archived identity", async () => {
  const { root, dir } = project();
  const manifestPath = join(dir, "manifest.json");
  const controllerConfigPath = join(dir, "controller-config.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.workflows[0].taskBinding = { rootPaneId: "old-pane", workspaceId: "old-workspace", rootSessionPath: "/sessions/old" };
  manifest.rootSessionLogs = [{ kind: "root", rootId: "gone-root", paneId: "old-pane", workspaceId: "old-workspace", sessionRef: { provider: "pi", sessionId: "gone-session" }, status: "gone", startedAt: "2026-01-01T00:00:00.000Z" }];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(controllerConfigPath, JSON.stringify({ version: 2, owner: "herdr-orchestrator", orchestrators: [{ id: "gone-root", program: { id: root, parent_manifest_path: manifestPath }, root: { pane_id: "old-pane", workspace_id: "old-workspace" }, workflows: [{ workflow_id: manifest.workflows[0].id, manifest_path: manifestPath, lanes: [] }] }] }));
  try {
    const common = { projectRoot: root, controllerConfigPath, probeRoot: async () => "stale", ...ports([]) };
    const preview = await runReset(common);
    assert.equal(preview.plan.controllerRoots.length, 1);
    assert.match(formatPlan(preview.plan), /gone-root .*liveness=stale/);
    await runReset({ ...common, expectedFingerprint: preview.fingerprint, apply: true });
    assert.equal(existsSync(controllerConfigPath), false, "the only proven-stale scoped root record was unregistered");
    const archive = readdirSync(join(dir, "archive")).find((name) => name.endsWith(".manifest.json.gz"));
    assert.equal(JSON.parse(gunzipSync(readFileSync(join(dir, "archive", archive))).toString()).rootSessionLogs[0].sessionRef.sessionId, "gone-session");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unexpected close failure aborts before archives or durable state changes, even after earlier cleanup", async () => {
  const { root, dir } = project();
  const manifestPath = join(dir, "manifest.json");
  const controllerConfigPath = join(dir, "controller-config.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.workflows[0].taskBinding = { rootPaneId: "root-pane", workspaceId: "root-workspace" };
  manifest.workflows[1].lanes[0].status = "running";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(controllerConfigPath, JSON.stringify({ version: 2, owner: "herdr-orchestrator", orchestrators: [{ id: "root-a", program: { id: root, parent_manifest_path: manifestPath }, root: { pane_id: "root-pane", workspace_id: "root-workspace" }, workflows: [{ workflow_id: manifest.workflows[0].id, manifest_path: manifestPath, lanes: [] }] }] }));
  const before = new Map(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name))]));
  const closed = [];
  let stopped = 0;
  try {
    await assert.rejects(runReset({ projectRoot: root, controllerConfigPath, probeRoot: async () => "live", apply: true, includeSpec: true, rootTabIds: new Set(["w1:t1"]), env: {},
      killLane: async () => { stopped++; return {}; },
      closeTab: (id) => { closed.push(id); if (id === "w1:t9") throw new Error("socket closed"); },
    }), /could not close tab w1:t9.*durable state was not archived or cleared/);
    assert.equal(stopped, 1, "an earlier lane process may already have stopped");
    assert.deepEqual(closed, ["w1:t2", "w1:t9"], "stop closing further tabs after the unexpected failure");
    for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(dir, name)), bytes, name);
    assert.deepEqual(readdirSync(dir).sort(), [...before.keys()].sort());
    assert.equal(existsSync(join(dir, "archive")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only an explicit already-absent tab error is ignorable", async () => {
  const { root, dir } = project();
  try {
    const manifest = readFileSync(join(dir, "manifest.json"), "utf8");
    await assert.rejects(runReset({ projectRoot: root, apply: true, ...ports([]), closeTab: (id) => { throw new Error(id === "w1:t2" ? "tab not found" : "socket closed"); } }), /could not close tab w1:t9/);
    assert.equal(readFileSync(join(dir, "manifest.json"), "utf8"), manifest);
    assert.equal(existsSync(join(dir, "archive")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("spec-state bytes are fingerprinted and a changed same-path file refuses apply", async () => {
  const { root, dir } = project();
  const specPath = join(dir, "spec-state.json");
  const closed = [];
  try {
    const common = { projectRoot: root, ...ports(closed) };
    const preview = await runReset(common);
    const plannedHash = createHash("sha256").update(readFileSync(specPath)).digest("hex");
    assert.equal(preview.plan.sourceHashes.specState, plannedHash);
    writeFileSync(specPath, "still exists, changed content");
    const changed = await runReset(common);
    assert.notEqual(changed.plan.sourceHashes.specState, plannedHash);
    assert.notEqual(changed.fingerprint, preview.fingerprint);
    await assert.rejects(runReset({ ...common, apply: true, expectedFingerprint: preview.fingerprint }), /fingerprint changed/);
    assert.deepEqual(closed, []);
    assert.equal(readFileSync(specPath, "utf8"), "still exists, changed content");
    assert.equal(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).workflows.length, 2);
    assert.equal(existsSync(join(dir, "archive")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a spec-state change immediately before commit is neither archived nor deleted", async () => {
  const { root, dir } = project();
  const manifestPath = join(dir, "manifest.json");
  const controllerConfigPath = join(dir, "controller-config.json");
  const specPath = join(dir, "spec-state.json");
  writeFileSync(controllerConfigPath, JSON.stringify({ version: 2, owner: "herdr-orchestrator", orchestrators: [] }));
  const beforeManifest = readFileSync(manifestPath, "utf8");
  const beforeConfig = readFileSync(controllerConfigPath, "utf8");
  const changedBytes = Buffer.from("changed immediately before commit");
  try {
    await assert.rejects(runReset({ projectRoot: root, controllerConfigPath, apply: true, includeSpec: true, rootTabIds: new Set(["w1:t1"]), env: {},
      killLane: async () => ({}),
      closeTab: () => writeFileSync(specPath, changedBytes),
    }), /spec-state.json content changed before reset commit/);
    assert.equal(readFileSync(manifestPath, "utf8"), beforeManifest);
    assert.equal(readFileSync(controllerConfigPath, "utf8"), beforeConfig);
    assert.deepEqual(readFileSync(specPath), changedBytes);
    assert.equal(existsSync(join(dir, "archive")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows pane PIDs omitted from CIM inventory block all reset actions", async () => {
  for (const omittedPid of [111, 222]) {
    const { root, dir } = project();
    const manifestPath = join(dir, "manifest.json");
    const controllerConfigPath = join(dir, "controller-config.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const lane = manifest.workflows[0].lanes[0];
    Object.assign(lane, { paneId: "p1", workspaceId: "w1", tabId: "w1:t2" });
    manifest.workflows[0].taskBinding = { rootPaneId: "root-pane", workspaceId: "root-workspace" };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(controllerConfigPath, JSON.stringify({ version: 2, owner: "herdr-orchestrator", orchestrators: [{ id: "root-a", program: { id: root, parent_manifest_path: manifestPath }, root: { pane_id: "root-pane", workspace_id: "root-workspace" }, workflows: [{ workflow_id: manifest.workflows[0].id, manifest_path: manifestPath, lanes: [] }] }] }));
    const intent = lane.startupIntentPath;
    const before = [manifestPath, controllerConfigPath, join(dir, "spec-state.json"), intent].map((path) => [path, readFileSync(path)]);
    let stops = 0;
    const closes = [];
    const infoRun = (args) => {
      if (args.join(" ") === "pane get p1") return JSON.stringify({ result: { pane: { pane_id: "p1", workspace_id: "w1", tab_id: "w1:t2" } } });
      if (args.join(" ") === "pane process-info --pane p1") return JSON.stringify({ result: { process_info: { shell_pid: 111, foreground_processes: [{ pid: 222 }] } } });
      throw new Error(`unexpected native command ${args.join(" ")}`);
    };
    try {
      await assert.rejects(runReset({ projectRoot: root, controllerConfigPath, probeRoot: async () => "live", apply: true, platform: "win32", env: {}, rootTabIds: new Set(["w1:t1"]),
        runHerdr: infoRun,
        processTable: async () => [111, 222].filter((pid) => pid !== omittedPid).map((pid) => ({ pid, ppid: 1, createdAt: `created-${pid}`, line: `node BAA_STARTUP_INTENT=${intent}` })),
        killLane: async () => { stops++; return {}; }, closeTab: (id) => closes.push(id),
      }), /missing from the Windows CIM inventory/);
      assert.equal(stops, 0, `no process is stopped when PID ${omittedPid} is omitted`);
      assert.deepEqual(closes, [], `no tabs close when PID ${omittedPid} is omitted`);
      for (const [path, bytes] of before) assert.deepEqual(readFileSync(path), bytes, path);
      assert.equal(existsSync(join(dir, "archive")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Windows no-intent tabs require preflight PID proof and are never broad-killed", async () => {
  for (const inventory of ["access-denied", "missing-pid"]) {
    const { root, dir } = project();
    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const lane = manifest.workflows[0].lanes[0];
    delete lane.startupIntentPath;
    Object.assign(lane, { paneId: "p1", workspaceId: "w1", tabId: "w1:t2" });
    manifest.workflows[1].lanes[0].tabId = undefined;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    let stops = 0;
    const closes = [];
    const runHerdr = (args) => {
      if (args.join(" ") === "pane get p1") return JSON.stringify({ result: { pane: { pane_id: "p1", workspace_id: "w1", tab_id: "w1:t2" } } });
      if (args.join(" ") === "pane process-info --pane p1") return JSON.stringify({ result: { process_info: { shell_pid: 111, foreground_processes: [{ pid: 222 }] } } });
      throw new Error(`unexpected native command ${args.join(" ")}`);
    };
    try {
      await assert.rejects(runReset({ projectRoot: root, apply: true, platform: "win32", env: {}, rootTabIds: new Set(["w1:t1"]), runHerdr,
        processTable: async () => {
          if (inventory === "access-denied") throw new Error("Access is denied");
          return [{ pid: 111, ppid: 1, createdAt: "created-111", line: "shell" }];
        },
        killLane: async () => { stops++; return {}; }, closeTab: (id) => closes.push(id),
      }), inventory === "access-denied" ? /process inventory unavailable|missing from the Windows CIM inventory/ : /missing from the Windows CIM inventory/);
      assert.equal(stops, 0, `${inventory}: no process stop`);
      assert.deepEqual(closes, [], `${inventory}: no tab close`);
      assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).workflows.length, 2);
      assert.equal(existsSync(join(dir, "archive")), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("Windows pane PID/time proof participates in the one-shot reset fingerprint", async () => {
  const { root, dir } = project();
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const lane = manifest.workflows[0].lanes[0];
  delete lane.startupIntentPath;
  Object.assign(lane, { paneId: "p1", workspaceId: "w1", tabId: "w1:t2" });
  manifest.workflows[1].lanes[0].tabId = undefined;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const runHerdr = (args) => JSON.stringify({ result: args[0] === "pane" && args[1] === "get"
    ? { pane: { pane_id: "p1", workspace_id: "w1", tab_id: "w1:t2" } }
    : { process_info: { shell_pid: 111, foreground_processes: [{ pid: 222 }] } } });
  const rows = (createdAt) => [{ pid: 111, ppid: 1, createdAt: `${createdAt}-111`, line: "shell" }, { pid: 222, ppid: 111, createdAt: `${createdAt}-222`, line: "worker" }];
  const common = { projectRoot: root, platform: "win32", env: {}, rootTabIds: new Set(["w1:t1"]), runHerdr };
  const closes = [];
  let stops = 0;
  try {
    const preview = await runReset({ ...common, processTable: async () => rows("preview") });
    assert.deepEqual(preview.plan.processIdentities.map(({ pid }) => pid), [111, 222]);
    let inventory = 0;
    await assert.rejects(runReset({ ...common, apply: true, expectedFingerprint: preview.fingerprint,
      processTable: async () => rows(++inventory === 1 ? "preview" : "changed"),
      killLane: async () => { stops++; return {}; }, closeTab: (id) => closes.push(id),
    }), /inventory changed after preview/);
    assert.equal(stops, 0);
    assert.deepEqual(closes, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows no-intent tab close is followed by an identity-based survivor check", async () => {
  const { root, dir } = project();
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const lane = manifest.workflows[0].lanes[0];
  delete lane.startupIntentPath;
  Object.assign(lane, { paneId: "p1", workspaceId: "w1", tabId: "w1:t2" });
  manifest.workflows[1].lanes[0].tabId = undefined;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  let inventories = 0;
  let stops = 0;
  const closes = [];
  const runHerdr = (args) => JSON.stringify({ result: args[0] === "pane" && args[1] === "get"
    ? { pane: { pane_id: "p1", workspace_id: "w1", tab_id: "w1:t2" } }
    : { process_info: { shell_pid: 111, foreground_processes: [{ pid: 222 }] } } });
  try {
    await assert.rejects(runReset({ projectRoot: root, apply: true, platform: "win32", env: {}, rootTabIds: new Set(["w1:t1"]), runHerdr,
      processTable: async () => { inventories++; return [{ pid: 111, ppid: 1, createdAt: "created-111", line: "shell" }, { pid: 222, ppid: 111, createdAt: "created-222", line: "worker" }]; },
      killLane: async () => { stops++; return {}; }, closeTab: (id) => closes.push(id),
    }), /incomplete after closing no-intent tabs.*PID 111 remains/s);
    assert.equal(inventories, 3, "initial, apply inventory, and post-close process inventories are required");
    assert.deepEqual(closes, ["w1:t2"]);
    assert.equal(stops, 0, "no-intent lanes are never broad-killed");
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).workflows.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("strict planned-file removal leaves durable reset records intact on failure", async () => {
  const { root, dir } = project();
  const manifestPath = join(dir, "manifest.json");
  const controllerConfigPath = join(dir, "controller-config.json");
  const intentPath = join(dir, "herdr-00000001-lane-1-startup.json");
  writeFileSync(controllerConfigPath, JSON.stringify({ version: 2, owner: "herdr-orchestrator", orchestrators: [] }));
  rmSync(intentPath);
  mkdirSync(intentPath);
  writeFileSync(join(intentPath, "blocked-child"), "cannot unlink non-empty directory");
  const beforeManifest = readFileSync(manifestPath);
  const beforeConfig = readFileSync(controllerConfigPath);
  const beforeSpec = readFileSync(join(dir, "spec-state.json"));
  try {
    await assert.rejects(runReset({ projectRoot: root, controllerConfigPath, apply: true, rootTabIds: new Set(["w1:t1"]), env: {}, probeRoot: async () => "live", ...ports([]) }), /could not remove planned state files.*durable manifest, controller and spec state were left intact/i);
    assert.deepEqual(readFileSync(manifestPath), beforeManifest);
    assert.deepEqual(readFileSync(controllerConfigPath), beforeConfig);
    assert.deepEqual(readFileSync(join(dir, "spec-state.json")), beforeSpec);
    assert.equal(existsSync(join(dir, "archive")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
