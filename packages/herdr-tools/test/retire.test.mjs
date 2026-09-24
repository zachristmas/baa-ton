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

const policy = {
  version: 2,
  grants: ["dispatch", "retire", "runtime-launch"],
  runtimeLaunch: {
    commands: [{ name: "compose", start: "docker compose -p {lane} up -d", stop: "docker compose -p {lane} down" }],
  },
};

async function setup({ acknowledged = true, stopCode = 0, laneStatus = "idle" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "baa-retire-"));
  const configDir = join(directory, "config");
  const parent = join(directory, "parent");
  const manifestPath = join(parent, ".baa-ton", "herdr-orchestrator", "manifest.json");
  const rootPane = "w-ret:p1";
  const root = { target: rootPane, target_kind: "pane_id", pane_id: rootPane, workspace_id: "w-ret", agent_kind: "pi" };
  const route = (id, pane) => ({ lane_id: id, target: pane, target_kind: "pane_id", pane_id: pane, workspace_id: "w-ret" });
  await mkdir(join(parent, ".baa-ton", "herdr-orchestrator"), { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(parent, ".baa-ton", "config.json"), JSON.stringify({ version: 1, approvalPolicy: policy }));
  const lease = (id, laneId, ports) => ({
    id, resource: "app", label: "default", kind: "port-block", ports, workflowId: "herdr-ret00001",
    laneId, state: "active", grantedBy: "dispatch", grantedAt: "t",
  });
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 2,
      ...(acknowledged
        ? {
            approvalPolicyAck: {
              hash: approvalPolicyHash(validateApprovalPolicy(policy)),
              grants: policy.grants,
              ackedAt: "t",
              rootPaneId: rootPane,
            },
          }
        : {}),
      leases: [lease("lease-a", "lane-a", [3600, 3601]), lease("lease-b", "lane-b", [3602, 3603])],
      workflows: [{
        id: "herdr-ret00001",
        objective: "Exercise retirement",
        status: "running",
        outcome: "running",
        cwd: parent,
        taskBinding: { workspaceId: "w-ret", rootPaneId: rootPane, rootSessionPath: "/tmp/root.jsonl" },
        ownership: { createdBy: "herdr-orchestrator", workspaceId: "w-ret", tabIds: ["tab-a", "tab-b"], paneIds: [] },
        lanes: [
          {
            id: "lane-a", paneId: "w-ret:p2", tabId: "tab-a", status: "completion-reported",
            completionReceipt: { id: "receipt-a", summary: "done", delivery: "delivered" },
            sessionLog: { kind: "lane", status: "completed", sessionRef: { provider: "claude", sessionId: "s-a" } },
          },
          { id: "lane-b", paneId: "w-ret:p3", tabId: "tab-b", status: "running" },
        ],
        laneRequests: [{
          id: "request-1", workflowId: "herdr-ret00001", laneId: "lane-a", kind: "runtime-launch",
          payload: { command: "docker compose -p lane-a up -d" }, summary: "runtime launch", status: "granted",
          answeredBy: "policy", template: "compose:start", requestedAt: "t",
        }],
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
        id: "orchestrator-ret",
        root,
        program: { id: parent, workspace_id: "w-ret", parent_manifest_path: manifestPath },
        workflows: [{
          workflow_id: "herdr-ret00001",
          manifest_path: manifestPath,
          lanes: [route("lane-a", "w-ret:p2"), route("lane-b", "w-ret:p3")],
        }],
      }],
    }),
    { mode: 0o600 },
  );
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_PANE_ID: rootPane,
    HERDR_WORKSPACE_ID: "w-ret",
    HERDR_PLUGIN_CONFIG_DIR: configDir,
  });
  const calls = [];
  const tools = new Map();
  const handlers = new Map();
  extension({
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand() {},
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    async exec(command, args, options = {}) {
      calls.push({ command, args, cwd: options.cwd });
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            type: "agent_info",
            agent: { agent: "claude", pane_id: args[2], workspace_id: "w-ret", agent_status: laneStatus },
          }),
        };
      if (command === "herdr" && args[0] === "tab" && args[1] === "close")
        return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
      if (command === "docker") return { code: stopCode, stderr: stopCode ? "compose failed" : "", stdout: "" };
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  });
  const ctx = {
    cwd: parent,
    mode: "json",
    hasUI: false,
    isIdle: () => true,
    abort() {},
    signal: undefined,
    sessionManager: { getSessionFile: () => "/tmp/root.jsonl", getSessionId: () => "root" },
    ui: { confirm: async () => false, notify() {} },
  };
  return {
    calls,
    tools,
    ctx,
    parent,
    async settle() {
      for (const handler of handlers.get("agent_settled") ?? []) await handler({}, ctx);
    },
    async manifest() {
      return JSON.parse(await readFile(manifestPath, "utf8"));
    },
    async cleanup() {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("a settled root turn retires a lane whose completion it received: services, tab, leases", async () => {
  const f = await setup();
  try {
    const dry = await f.tools.get("herdr_retire").execute("retire", { workflowId: "herdr-ret00001" }, undefined, undefined, f.ctx);
    assert.deepEqual(dry.details.candidates.map((item) => [item.laneId, item.stops]), [
      ["lane-a", [["docker", "compose", "-p", "lane-a", "down"]]],
    ]);
    assert.match(dry.content[0].text, /- lane-a: tab tab-a; stop docker compose -p lane-a down/);

    await f.settle();
    const stored = await f.manifest();
    const laneA = stored.workflows[0].lanes[0];
    assert.equal(laneA.retirement.status, "retired");
    assert.equal(laneA.retirement.reason, "completion accepted (auto-retire)");
    assert.deepEqual(laneA.retirement.releasedLeaseIds, ["lease-a"]);
    assert.equal(laneA.sessionLog.status, "retired", "the session log records the retirement");
    assert.deepEqual(
      stored.leases.map((item) => [item.id, item.state]),
      [["lease-a", "released"], ["lease-b", "active"]],
    );
    const stop = f.calls.find((call) => call.command === "docker");
    assert.deepEqual(stop.args, ["compose", "-p", "lane-a", "down"]);
    assert.equal(stop.cwd, f.parent);
    assert.deepEqual(
      f.calls.filter((call) => call.command === "herdr" && call.args[0] === "tab").map((call) => call.args),
      [["tab", "close", "tab-a"]],
      "only the finished lane's tab closes",
    );
    assert.ok(stored.workflows[0].evidence.some((entry) => entry.kind === "lane-retired"));

    const before = f.calls.length;
    await f.settle();
    assert.equal(
      f.calls.slice(before).some((call) => call.args[0] === "tab" || call.command === "docker"),
      false,
      "a retired lane is never retired twice",
    );
  } finally {
    await f.cleanup();
  }
});

test("without an acknowledged retire grant nothing retires automatically and explicit retire asks", async () => {
  const f = await setup({ acknowledged: false });
  try {
    await f.settle();
    assert.equal((await f.manifest()).workflows[0].lanes[0].retirement, undefined);
    await assert.rejects(
      f.tools.get("herdr_retire").execute("retire", { workflowId: "herdr-ret00001", execute: true }, undefined, undefined, f.ctx),
      /requires TUI confirmation/,
    );
    const confirmed = await f.tools
      .get("herdr_retire")
      .execute("retire", { workflowId: "herdr-ret00001", execute: true, confirm: true }, undefined, undefined, f.ctx);
    assert.equal(confirmed.details.results[0].retirement.status, "retired");
    assert.equal(confirmed.details.results[0].retirement.reason, "retired by root");
  } finally {
    await f.cleanup();
  }
});

test("a failed stop keeps the leases and marks the retirement partial", async () => {
  const f = await setup({ stopCode: 1 });
  try {
    await f.settle();
    const stored = await f.manifest();
    const retirement = stored.workflows[0].lanes[0].retirement;
    assert.equal(retirement.status, "partial");
    assert.match(retirement.error, /leases are kept until the service is stopped/);
    assert.equal(stored.leases[0].state, "active");
    assert.equal(retirement.stops[0].output, "compose failed");
  } finally {
    await f.cleanup();
  }
});

test("a lane still working is left alone", async () => {
  const f = await setup({ laneStatus: "working" });
  try {
    await f.settle();
    assert.equal((await f.manifest()).workflows[0].lanes[0].retirement, undefined);
    assert.equal(f.calls.some((call) => call.args[0] === "tab"), false);
  } finally {
    await f.cleanup();
  }
});
