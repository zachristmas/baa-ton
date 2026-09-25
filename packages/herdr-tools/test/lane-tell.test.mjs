import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "baa-tell-"));
  const configDir = join(directory, "config");
  const parent = join(directory, "parent");
  const manifestPath = join(parent, ".baa-ton", "herdr-orchestrator", "manifest.json");
  const rootPane = "w-tell:p1";
  const root = { target: rootPane, target_kind: "pane_id", pane_id: rootPane, workspace_id: "w-tell", agent_kind: "pi" };
  const laneRoute = (id, pane) => ({ lane_id: id, target: pane, target_kind: "pane_id", pane_id: pane, workspace_id: "w-tell" });
  await mkdir(join(parent, ".baa-ton", "herdr-orchestrator"), { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const workflow = (id, rootPaneId, lanes, workspaceId = "w-tell") => ({
    id,
    objective: "Exercise root-to-lane messages",
    status: "running",
    outcome: "running",
    taskBinding: { workspaceId, rootPaneId, rootSessionPath: "/tmp/root.jsonl" },
    ownership: { createdBy: "herdr-orchestrator", workspaceId, paneIds: [] },
    lanes,
    evidence: [],
  });
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 2,
      workflows: [
        workflow("herdr-tell0001", rootPane, [
          { id: "lane-idle", paneId: "w-tell:p2", status: "running" },
          { id: "lane-busy", paneId: "w-tell:p3", status: "running" },
          { id: "lane-planned", status: "planned" },
        ]),
        workflow("herdr-other001", "w-other:p1", [{ id: "lane-1", paneId: "w-other:p2", status: "running" }], "w-other"),
      ],
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      version: 2,
      owner: "herdr-orchestrator",
      orchestrators: [{
        id: "orchestrator-tell",
        root,
        program: { id: parent, workspace_id: "w-tell", parent_manifest_path: manifestPath },
        workflows: [{
          workflow_id: "herdr-tell0001",
          manifest_path: manifestPath,
          lanes: [laneRoute("lane-idle", "w-tell:p2"), laneRoute("lane-busy", "w-tell:p3")],
        }],
      }],
    }),
    { mode: 0o600 },
  );
  return { directory, configDir, parent, manifestPath, rootPane };
}

test("herdr_tell types into an idle lane, queues for a busy one, and is root-only", async () => {
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map((key) => [key, process.env[key]]),
  );
  const f = await fixture();
  const prompts = [];
  const status = { "w-tell:p2": "idle", "w-tell:p3": "working" };
  // What Herdr reports running in each pane (undefined: the fixture default).
  const agentKind = {};
  // Panes whose only foreground process is the shell (the agent exited).
  const shellOnly = new Set();
  const tools = new Map();
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w-tell", HERDR_PLUGIN_CONFIG_DIR: f.configDir, HERDR_PANE_ID: f.rootPane });
  extension({
    on() {},
    registerCommand() {},
    registerTool: (definition) => tools.set(definition.name, definition),
    async exec(command, args) {
      if (command === "herdr" && args[0] === "agent" && args[1] === "get")
        return { code: 0, stdout: JSON.stringify({ result: { type: "agent_info", agent: { agent: agentKind[args[2]] ?? "pi", pane_id: args[2], agent_status: status[args[2]] } } }), stderr: "" };
      if (command === "herdr" && args[0] === "pane" && args[1] === "process-info") {
        const pane = args[args.indexOf("--pane") + 1];
        const foreground = shellOnly.has(pane) ? [{ pid: 700, name: "zsh" }] : [{ pid: 700, name: "zsh" }, { pid: 701, name: "node" }];
        return { code: 0, stdout: JSON.stringify({ result: { process_info: { shell_pid: 700, foreground_processes: foreground } } }), stderr: "" };
      }
      if (command === "herdr" && args[0] === "agent" && args[1] === "prompt") {
        prompts.push({ pane: args[2], text: args[3] });
        return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  });
  const ctx = { cwd: f.parent, mode: "json", hasUI: false, ui: { confirm: async () => false, notify() {} } };
  const tell = (params) => tools.get("herdr_tell").execute("tell", params, undefined, undefined, ctx);
  const stored = async (workflowId = "herdr-tell0001") =>
    JSON.parse(await readFile(f.manifestPath, "utf8")).workflows.find((item) => item.id === workflowId);
  try {
    const delivered = await tell({ workflowId: "herdr-tell0001", laneId: "lane-idle", text: "Use migration slot 3; proceed." });
    assert.equal(delivered.details.message.delivery.status, "delivered");
    assert.match(delivered.content[0].text, /delivered/);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].pane, "w-tell:p2");
    assert.match(prompts[0].text, /^\[Baa-ton root message\] lane-message-\w+: Use migration slot 3; proceed\./);
    assert.match(prompts[0].text, /herdr_message/);

    const queued = await tell({ workflowId: "herdr-tell0001", laneId: "lane-busy", text: "Stop after the current test run." });
    assert.equal(queued.details.message.delivery.status, "pending");
    assert.match(queued.content[0].text, /queued \(lane is working\)/);
    assert.equal(prompts.length, 1, "nothing is typed into a working lane");
    const record = (await stored()).laneMessages.find((item) => item.laneId === "lane-busy");
    assert.equal(record.delivery.status, "pending");
    assert.match(record.delivery.text, /Stop after the current test run\./, "the queued text is durable for the supervisor");
    assert.ok((await stored()).evidence.some((entry) => entry.kind === "lane-message"));

    // A request answer for a working lane is held, not typed over its turn.
    const manifest = JSON.parse(await readFile(f.manifestPath, "utf8"));
    manifest.workflows[0].laneRequests = [{
      id: "request-q1", workflowId: "herdr-tell0001", laneId: "lane-busy", kind: "approval",
      payload: { text: "May I reset my lane database?" }, summary: "approval: May I reset my lane database?",
      status: "open", requestedAt: "t",
    }];
    await writeFile(f.manifestPath, JSON.stringify(manifest));
    const answered = await tools.get("herdr_request").execute(
      "answer", { action: "answer", requestId: "request-q1", decision: "grant", note: "Yes, your own database only." }, undefined, undefined, ctx,
    );
    assert.equal(answered.details.request.answerDelivery.status, "pending");
    assert.match(answered.details.request.answerDelivery.text, /^\[Baa-ton request answer\] request-q1: granted\. approval: May I reset my lane database\?\. Yes, your own database only\.$/);
    assert.equal(prompts.length, 1, "the answer waits for the lane to go idle");

    // The lane's agent exited and its pane holds a shell, or a different
    // agent now runs there: nothing is typed, the message stays pending.
    const typedBefore = prompts.length;
    agentKind["w-tell:p2"] = "";
    const shell = await tell({ workflowId: "herdr-tell0001", laneId: "lane-idle", text: "Are you there?" });
    assert.equal(shell.details.message.delivery.status, "pending");
    assert.match(shell.details.message.delivery.reason, /lane agent not ready: no_agent_in_pane/);
    agentKind["w-tell:p2"] = "claude";
    const other = await tell({ workflowId: "herdr-tell0001", laneId: "lane-idle", text: "Still there?" });
    assert.match(other.details.message.delivery.reason, /agent_kind_mismatch/);
    assert.equal(prompts.length, typedBefore, "nothing typed into a shell or the wrong agent");
    delete agentKind["w-tell:p2"];
    // Herdr still reports the agent, but the pane shows a bare shell.
    shellOnly.add("w-tell:p2");
    const exited = await tell({ workflowId: "herdr-tell0001", laneId: "lane-idle", text: "After exit?" });
    assert.equal(exited.details.message.delivery.status, "pending");
    assert.match(exited.details.message.delivery.reason, /pane_shows_shell_prompt/);
    assert.equal(prompts.length, typedBefore, "nothing typed into the bare shell");
    shellOnly.delete("w-tell:p2");

    await assert.rejects(tell({ workflowId: "herdr-tell0001", laneId: "lane-planned", text: "x" }), /has not been dispatched/);
    await assert.rejects(tell({ workflowId: "herdr-tell0001", laneId: "lane-nope", text: "x" }), /has no lane lane-nope/);
    await assert.rejects(tell({ workflowId: "herdr-other001", laneId: "lane-1", text: "x" }), /not owned by this root/);
    process.env.HERDR_PANE_ID = "w-tell:p2";
    await assert.rejects(tell({ workflowId: "herdr-tell0001", laneId: "lane-busy", text: "x" }), /root/i);
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(f.directory, { recursive: true, force: true });
  }
});
