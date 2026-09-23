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

const policy = { version: 2, grants: ["dispatch", "lease"] };
const runtime = {
  leases: {
    app: { kind: "port-block", size: 2, range: [47100, 47119] },
    db: { kind: "name", prefix: "cic" },
  },
  dispatchLeases: ["app"],
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "baa-lease-"));
  const configDir = join(directory, "config");
  const parent = join(directory, "parent");
  const manifestPath = join(parent, ".baa-ton", "herdr-orchestrator", "manifest.json");
  const rootPane = "w-lease:p1";
  const root = { target: rootPane, target_kind: "pane_id", pane_id: rootPane, workspace_id: "w-lease", agent_kind: "pi" };
  const laneRoute = (id, pane) => ({ lane_id: id, target: pane, target_kind: "pane_id", pane_id: pane, workspace_id: "w-lease" });
  await mkdir(join(parent, ".baa-ton", "herdr-orchestrator"), { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(parent, ".baa-ton", "config.json"), JSON.stringify({ version: 1, approvalPolicy: policy, runtime }));
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 2,
      workflows: [{
        id: "herdr-lease001",
        objective: "Exercise leases",
        status: "running",
        outcome: "running",
        taskBinding: { workspaceId: "w-lease", rootPaneId: rootPane, rootSessionPath: "/tmp/root.jsonl" },
        ownership: { createdBy: "herdr-orchestrator", workspaceId: "w-lease", paneIds: [] },
        lanes: [
          { id: "lane-a", paneId: "w-lease:p2", status: "running" },
          { id: "lane-b", paneId: "w-lease:p3", status: "running" },
        ],
        evidence: [],
      }],
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      version: 2,
      owner: "herdr-orchestrator",
      orchestrators: [{
        id: "orchestrator-lease",
        root,
        program: { id: parent, workspace_id: "w-lease", parent_manifest_path: manifestPath },
        workflows: [{
          workflow_id: "herdr-lease001",
          manifest_path: manifestPath,
          lanes: [laneRoute("lane-a", "w-lease:p2"), laneRoute("lane-b", "w-lease:p3")],
        }],
      }],
    }),
    { mode: 0o600 },
  );
  return { directory, configDir, parent, manifestPath, rootPane };
}

test("lanes lease their own ports under an acknowledged policy; the root manages any lane", async () => {
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map((key) => [key, process.env[key]]),
  );
  const f = await fixture();
  const tools = new Map();
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: "w-lease",
    HERDR_PLUGIN_CONFIG_DIR: f.configDir,
  });
  extension({
    on() {},
    registerCommand() {},
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    async exec(command, args) {
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  });
  const lease = (params, pane, cwd = join(f.directory, "somewhere-else")) => {
    process.env.HERDR_PANE_ID = pane;
    return tools.get("herdr_lease").execute("lease", params, undefined, undefined, {
      cwd,
      mode: "json",
      hasUI: false,
      ui: { confirm: async () => false, notify() {} },
    });
  };
  const readManifest = async () => JSON.parse(await readFile(f.manifestPath, "utf8"));
  try {
    const refused = await lease({ action: "request", resource: "app" }, "w-lease:p2");
    assert.equal(refused.details.granted, false);
    assert.equal(refused.details.parentApprovalRequired, true);
    assert.match(refused.content[0].text, /not acknowledged by the root; ask the root/);

    const manifest = await readManifest();
    manifest.approvalPolicyAck = {
      hash: approvalPolicyHash(validateApprovalPolicy(policy)),
      grants: policy.grants,
      ackedAt: "t",
      rootPaneId: f.rootPane,
    };
    await writeFile(f.manifestPath, JSON.stringify(manifest));

    const a = await lease({ action: "request", resource: "app" }, "w-lease:p2");
    assert.equal(a.details.granted, true);
    assert.deepEqual(a.details.lease.ports, [47100, 47101]);
    assert.equal(a.details.lease.grantedBy, "lane-policy");
    const again = await lease({ action: "request", resource: "app" }, "w-lease:p2");
    assert.equal(again.details.created, false);
    assert.equal(again.details.lease.id, a.details.lease.id);
    const b = await lease({ action: "request", resource: "app" }, "w-lease:p3");
    assert.deepEqual(b.details.lease.ports, [47102, 47103], "no overlap with lane-a");

    const ownList = await lease({ action: "list" }, "w-lease:p2");
    assert.deepEqual(ownList.details.leases.map((item) => item.id), [a.details.lease.id]);
    await assert.rejects(lease({ action: "release", leaseId: b.details.lease.id }, "w-lease:p2"), /only its own leases/);
    await assert.rejects(lease({ action: "request", resource: "app", laneId: "lane-b" }, "w-lease:p2"), /only on its own leases/);

    const rootList = await lease({ action: "list" }, f.rootPane, f.parent);
    assert.equal(rootList.details.leases.length, 2);
    const db = await lease({ action: "request", resource: "db", workflowId: "herdr-lease001", laneId: "lane-b" }, f.rootPane, f.parent);
    assert.equal(db.details.lease.name, "cic_lease001_lane_b");
    assert.equal(db.details.lease.grantedBy, "root");
    await assert.rejects(
      lease({ action: "request", resource: "db" }, f.rootPane, f.parent),
      /workflowId and laneId are required/,
    );
    const released = await lease({ action: "release", leaseId: a.details.lease.id }, f.rootPane, f.parent);
    assert.equal(released.details.released, true);
    const reused = await lease({ action: "request", resource: "app" }, "w-lease:p2");
    assert.deepEqual(reused.details.lease.ports, [47100, 47101], "a released block is reused");

    const stored = await readManifest();
    const kinds = stored.workflows[0].evidence.map((item) => item.kind);
    assert.equal(kinds.filter((kind) => kind === "lease-granted").length, 4);
    assert.equal(kinds.filter((kind) => kind === "lease-released").length, 1);

    // A hand edit that duplicates ports is surfaced and blocks allocation.
    stored.leases.push({ ...stored.leases.find((item) => item.state === "active" && item.ports), id: "lease-hand" });
    await writeFile(f.manifestPath, JSON.stringify(stored));
    const conflicted = await lease({ action: "list" }, f.rootPane, f.parent);
    assert.match(conflicted.content[0].text, /CONFLICT: port 471\d\d is held by/);
    await assert.rejects(
      lease({ action: "request", resource: "db", workflowId: "herdr-lease001", laneId: "lane-a" }, f.rootPane, f.parent),
      /Lease ledger has conflicts/,
    );
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(f.directory, { recursive: true, force: true });
  }
});
