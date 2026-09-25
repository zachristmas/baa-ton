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

const defaultPolicy = {
  version: 2,
  grants: ["dispatch", "lease", "runtime-launch"],
  runtimeLaunch: {
    commands: [{ name: "web", start: "npm run dev -- --port {lease.app[0]}", stop: "pkill -f port-{lease.app[0]}" }],
  },
};
const runtime = {
  leases: {
    app: { kind: "port-block", size: 2, range: [47200, 47209] },
    redis: { kind: "port", range: [47210, 47210] },
  },
};

async function fixture(policy = defaultPolicy, workflowFields = {}) {
  const directory = await mkdtemp(join(tmpdir(), "baa-request-"));
  const configDir = join(directory, "config");
  const parent = join(directory, "parent");
  const manifestPath = join(parent, ".baa-ton", "herdr-orchestrator", "manifest.json");
  const rootPane = "w-req:p1";
  const root = { target: rootPane, target_kind: "pane_id", pane_id: rootPane, workspace_id: "w-req", agent_kind: "pi" };
  const laneRoute = (id, pane) => ({ lane_id: id, target: pane, target_kind: "pane_id", pane_id: pane, workspace_id: "w-req" });
  await mkdir(join(parent, ".baa-ton", "herdr-orchestrator"), { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(parent, ".baa-ton", "config.json"), JSON.stringify({ version: 1, approvalPolicy: policy, runtime }));
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 2,
      approvalPolicyAck: {
        hash: approvalPolicyHash(validateApprovalPolicy(policy)),
        grants: policy.grants,
        ackedAt: "t",
        rootPaneId: rootPane,
      },
      workflows: [{
        id: "herdr-req00001",
        objective: "Exercise requests",
        status: "running",
        outcome: "running",
        taskBinding: { workspaceId: "w-req", rootPaneId: rootPane, rootSessionPath: "/tmp/root.jsonl" },
        ownership: { createdBy: "herdr-orchestrator", workspaceId: "w-req", paneIds: [] },
        lanes: [
          { id: "lane-a", paneId: "w-req:p2", status: "running" },
          { id: "lane-b", paneId: "w-req:p3", status: "running" },
        ],
        evidence: [],
        ...workflowFields,
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
        id: "orchestrator-req",
        root,
        program: { id: parent, workspace_id: "w-req", parent_manifest_path: manifestPath },
        workflows: [{
          workflow_id: "herdr-req00001",
          manifest_path: manifestPath,
          lanes: [laneRoute("lane-a", "w-req:p2"), laneRoute("lane-b", "w-req:p3")],
        }],
      }],
    }),
    { mode: 0o600 },
  );
  return { directory, configDir, parent, manifestPath, rootPane };
}

test("lane requests: policy answers what it can, the root answers the rest and the lane hears back", async () => {
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map((key) => [key, process.env[key]]),
  );
  const f = await fixture();
  const tools = new Map();
  const prompts = [];
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w-req", HERDR_PLUGIN_CONFIG_DIR: f.configDir });
  extension({
    on() {},
    registerCommand() {},
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    async exec(command, args) {
      if (command === "herdr" && args[0] === "agent" && args[1] === "prompt") {
        prompts.push({ pane: args[2], text: args[3], wait: args.includes("--wait") });
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      }
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        return { code: 0, stdout: JSON.stringify({ result: { type: "agent_info", agent: { agent: "pi", pane_id: args[2], agent_status: "idle" } } }), stderr: "" };
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  });
  const call = (params, pane, cwd = join(f.directory, "elsewhere")) => {
    process.env.HERDR_PANE_ID = pane;
    return tools.get("herdr_request").execute("request", params, undefined, undefined, {
      cwd,
      mode: "json",
      hasUI: false,
      ui: { confirm: async () => false, notify() {} },
    });
  };
  const asLaneA = (params) => call(params, "w-req:p2");
  const asRoot = (params) => call(params, f.rootPane, f.parent);
  const workflow = async () => JSON.parse(await readFile(f.manifestPath, "utf8")).workflows[0];
  try {
    const lease = await asLaneA({ action: "open", kind: "lease", resource: "app" });
    assert.equal(lease.details.request.status, "granted");
    assert.equal(lease.details.request.answeredBy, "policy");
    assert.match(lease.details.request.note, /^app = 47200-47201/);
    assert.equal(lease.details.request.delivery, undefined, "answered requests never reach the digest");

    const launch = await asLaneA({ action: "open", kind: "runtime-launch", command: "npm run dev -- --port 47200" });
    assert.equal(launch.details.request.status, "granted");
    assert.equal(launch.details.request.template, "web:start");

    // The 2026-09-23 case: ports the lane does not hold and a plain-chat style ask.
    const offLease = await asLaneA({ action: "open", kind: "runtime-launch", command: "npm run dev -- --port 3610" });
    assert.equal(offLease.details.request.status, "open");
    assert.match(offLease.details.request.note, /matches no runtime template/);
    assert.equal(offLease.details.request.delivery.status, "pending", "open requests are queued for the root digest");
    assert.match(offLease.content[0].text, /do not repeat the request in chat/);
    const repeat = await asLaneA({ action: "open", kind: "runtime-launch", command: "npm   run dev -- --port 3610" });
    assert.equal(repeat.details.request.id === offLease.details.request.id, false, "whitespace differs: payload keeps the lane's text");
    const same = await asLaneA({ action: "open", kind: "runtime-launch", command: "npm run dev -- --port 3610" });
    assert.equal(same.details.created, false);
    assert.equal(same.details.request.id, offLease.details.request.id, "identical open requests are not duplicated");

    const approval = await asLaneA({ action: "open", kind: "approval", text: "Run the destructive fixture reset" });
    assert.equal(approval.details.request.status, "open");

    await asLaneA({ action: "open", kind: "lease", resource: "redis" });
    process.env.HERDR_PANE_ID = "w-req:p3";
    const exhausted = await call({ action: "open", kind: "lease", resource: "redis" }, "w-req:p3");
    assert.equal(exhausted.details.request.status, "open");
    assert.match(exhausted.details.request.note, /No free redis slot/);

    const listed = await asRoot({ action: "list" });
    assert.deepEqual(
      listed.details.requests.map((request) => request.id),
      [offLease.details.request.id, repeat.details.request.id, approval.details.request.id, exhausted.details.request.id],
    );
    await assert.rejects(asRoot({ action: "open", kind: "approval", text: "x" }), /registered child lane/);
    await assert.rejects(asLaneA({ action: "list" }), /root/);

    const denied = await asRoot({ action: "answer", requestId: approval.details.request.id, decision: "deny", note: "Not in this workflow." });
    assert.equal(denied.details.request.status, "denied");
    assert.equal(denied.details.request.answerDelivery.status, "delivered");
    assert.deepEqual(prompts.at(-1), {
      pane: "w-req:p2",
      text: `[Baa-ton request answer] ${approval.details.request.id}: denied. approval: Run the destructive fixture reset. Not in this workflow.`,
      wait: false,
    });

    // Lane-b's redis request: release lane-a's redis, then the root grants it.
    const stored = JSON.parse(await readFile(f.manifestPath, "utf8"));
    stored.leases.find((item) => item.resource === "redis").state = "released";
    await writeFile(f.manifestPath, JSON.stringify(stored));
    const granted = await asRoot({ action: "answer", requestId: exhausted.details.request.id, decision: "grant" });
    assert.equal(granted.details.request.status, "granted");
    assert.match(granted.details.request.note, /^redis = 47210/);
    assert.equal(prompts.at(-1).pane, "w-req:p3");
    const again = await asRoot({ action: "answer", requestId: exhausted.details.request.id, decision: "deny" });
    assert.equal(again.details.request.status, "granted", "an answered request is final");

    const status = await asLaneA({ action: "status", requestId: approval.details.request.id });
    assert.equal(status.details.request.status, "denied");
    await assert.rejects(asLaneA({ action: "status", requestId: exhausted.details.request.id }), /Unknown request/);

    // Bridge permission prompts: policy-only, no second record when unmatched.
    const allowed = await asLaneA({ action: "open", kind: "permission", toolName: "Bash", input: { command: "pkill -f port-47200" }, policyOnly: true });
    assert.equal(allowed.details.request.status, "granted");
    assert.equal(allowed.details.request.template, "web:stop");
    const unmatched = await asLaneA({ action: "open", kind: "permission", toolName: "Bash", input: { command: "rm -rf build" }, policyOnly: true });
    assert.equal(unmatched.details.kind, "unmatched");

    const final = await workflow();
    assert.equal(final.laneRequests.some((request) => request.payload?.input?.command === "rm -rf build"), false);
    const kinds = final.evidence.map((item) => item.kind);
    for (const kind of ["lane-request-granted", "lane-request-opened", "lane-request-denied"])
      assert.ok(kinds.includes(kind), kind);
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("local-validation: policy answers a lane's routine checks in its worktree, so the root never has to ask", async () => {
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map((key) => [key, process.env[key]]),
  );
  const f = await fixture({ version: 2, grants: ["dispatch", "lease", "local-validation"] }, { cwd: "/work/tree", worktree: "/work/tree" });
  const tools = new Map();
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w-req", HERDR_PLUGIN_CONFIG_DIR: f.configDir });
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
  const call = (params, pane, cwd) => {
    process.env.HERDR_PANE_ID = pane;
    return tools.get("herdr_request").execute("request", params, undefined, undefined, {
      cwd,
      mode: "json",
      hasUI: false,
      ui: { confirm: async () => false, notify() {} },
    });
  };
  const asLaneA = (params) => call(params, "w-req:p2", join(f.directory, "elsewhere"));
  const permission = (command) => asLaneA({ action: "open", kind: "permission", toolName: "Bash", input: { command } });
  try {
    await asLaneA({ action: "open", kind: "lease", resource: "app" });
    for (const [command, classes] of [
      ["pnpm install --frozen-lockfile", "install"],
      ["cd /work/tree/apps/web && pnpm build && pnpm test", "build, test"],
      ["pnpm --filter @example/orders codegen", "codegen"],
      ["CI=1 PORT=47200 npx playwright test --headed", "e2e"],
    ]) {
      const result = await permission(command);
      assert.equal(result.details.request.status, "granted", command);
      assert.equal(result.details.request.answeredBy, "policy");
      assert.equal(result.details.request.note, `local-validation: ${classes}`);
    }
    const launch = await asLaneA({ action: "open", kind: "runtime-launch", command: "npm run typecheck" });
    assert.equal(launch.details.request.status, "granted", "a runtime-launch request for a check is covered too");

    for (const [command, reason] of [
      ["pnpm add lodash", /not local validation \(pnpm add is not a validation script\); approvalPolicy does not grant runtime-launch/],
      ["DATABASE_URL=postgres://shared/db pnpm test", /environment assignment DATABASE_URL/],
      ["PORT=5432 pnpm e2e", /PORT=5432 is not one of this lane's leased ports/],
      ["cd /other/repo && pnpm test", /leaves the working directory/],
      ["pnpm run deploy", /pnpm deploy is not a validation script/],
    ]) {
      const result = await permission(command);
      assert.equal(result.details.request.status, "open", command);
      assert.match(result.details.request.note, reason);
    }
    // Only the requests outside the grant reach the root.
    const listed = await call({ action: "list" }, f.rootPane, f.parent);
    assert.deepEqual(
      listed.details.requests.map((request) => request.payload.input.command),
      ["pnpm add lodash", "DATABASE_URL=postgres://shared/db pnpm test", "PORT=5432 pnpm e2e", "cd /other/repo && pnpm test", "pnpm run deploy"],
    );
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("without the local-validation grant a routine check still goes to the root", async () => {
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map((key) => [key, process.env[key]]),
  );
  const f = await fixture();
  const tools = new Map();
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w-req", HERDR_PLUGIN_CONFIG_DIR: f.configDir, HERDR_PANE_ID: "w-req:p2" });
  extension({ on() {}, registerCommand() {}, registerTool: (definition) => tools.set(definition.name, definition), async exec() { throw new Error("unexpected"); } });
  try {
    const result = await tools.get("herdr_request").execute(
      "request",
      { action: "open", kind: "permission", toolName: "Bash", input: { command: "pnpm install --frozen-lockfile" } },
      undefined,
      undefined,
      { cwd: join(f.directory, "elsewhere"), mode: "json", hasUI: false, ui: { confirm: async () => false, notify() {} } },
    );
    assert.equal(result.details.request.status, "open");
    assert.match(result.details.request.note, /approvalPolicy does not grant local-validation; the command matches no runtime template/);
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(f.directory, { recursive: true, force: true });
  }
});
