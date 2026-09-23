import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

// These tests pin routing and delivery, not timing: deliver each digest as
// soon as the root is ready. The window has its own tests.
process.env.BAA_TON_DIGEST_WINDOW_SECONDS = "0";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

test("registered children can send distinct and deduplicated messages after completion", async () => {
  const savedEnvironment = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map(
      (key) => [key, process.env[key]],
    ),
  );
  const directory = await mkdtemp(join(tmpdir(), "baa-message-"));
  const configDir = join(directory, "config");
  const parent = join(directory, "parent");
  const manifestPath = join(parent, ".baa-ton", "herdr-orchestrator", "manifest.json");
  const rootPane = "w-message:p1";
  const childPane = "w-message:p2";
  const workflowId = "workflow-message";
  const laneId = "lane-message";
  const root = {
    target: rootPane,
    target_kind: "pane_id",
    pane_id: rootPane,
    workspace_id: "w-message",
    agent_kind: "pi",
  };
  const lane = {
    lane_id: laneId,
    target: childPane,
    target_kind: "pane_id",
    pane_id: childPane,
    workspace_id: "w-message",
  };
  const timestamp = "2026-09-16T00:00:00.000Z";
  await mkdir(join(parent, ".baa-ton", "herdr-orchestrator"), { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 2,
      workflows: [{
        id: workflowId,
        status: "completed",
        outcome: "completed",
        ownership: { createdBy: "herdr-orchestrator", workspaceId: "w-message" },
        lanes: [{
          id: laneId,
          paneId: childPane,
          agentName: "child",
          status: "completed",
          completionReceipt: { id: "receipt", summary: "complete", delivery: "delivered" },
        }],
        evidence: [],
      }],
      parentGoal: {
        version: 1,
        id: "parent-message",
        objective: "Review child information.",
        status: "completed",
        nextAction: "No more work.",
        signals: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    }, null, 2),
    { mode: 0o600 },
  );
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      version: 2,
      owner: "herdr-orchestrator",
      orchestrators: [{
        id: "orchestrator-message",
        root,
        program: { id: parent, workspace_id: "w-message", parent_manifest_path: manifestPath },
        workflows: [{ workflow_id: workflowId, manifest_path: manifestPath, lanes: [lane] }],
      }],
    }, null, 2),
    { mode: 0o600 },
  );

  const prompts = [];
  const tools = new Map();
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_PANE_ID: childPane,
    HERDR_WORKSPACE_ID: "w-message",
    HERDR_PLUGIN_CONFIG_DIR: configDir,
  });
  extension({
    on() {},
    registerCommand() {},
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    async exec(command, args) {
      assert.equal(command, "herdr");
      if (args[0] === "agent" && args[1] === "get")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            type: "agent_info",
            agent: {
              agent: "pi",
              pane_id: rootPane,
              workspace_id: "w-message",
              agent_status: "idle",
            },
          }),
        };
      if (args[0] === "agent" && args[1] === "prompt") {
        prompts.push(args[3]);
        if (args[3].includes("uncertain"))
          return { code: 1, stderr: "socket_timeout after submission", stdout: "" };
        return { code: 0, stderr: "", stdout: JSON.stringify({ result: {} }) };
      }
      throw new Error(`Unexpected Herdr call: ${args.join(" ")}`);
    },
  });
  const message = tools.get("herdr_message");
  assert.ok(message);
  const context = { cwd: join(directory, "different-checkout") };
  try {
    const first = await message.execute("message-1", {
      workflowId,
      summary: "The completed lane has a late fact.",
      details: "The original worktree was removed.",
    }, undefined, undefined, context);
    const duplicate = await message.execute("message-2", {
      workflowId,
      summary: "The completed lane has a late fact.",
    }, undefined, undefined, context);
    const distinct = await message.execute("message-3", {
      workflowId,
      summary: "A second fact needs review.",
    }, undefined, undefined, context);
    assert.equal(first.details.delivery, "delivered");
    assert.equal(duplicate.details.created, false);
    assert.equal(duplicate.details.request.id, first.details.request.id);
    assert.equal(distinct.details.delivery, "delivered");
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /message from workflow-message\/lane-message/);
    assert.match(prompts[0], /The completed lane has a late fact/);
    const stored = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(stored.parentGoal.status, "review-requested");
    assert.equal(stored.workflows[0].messageRequests.length, 2);

    const uncertain = await message.execute("message-4", {
      workflowId,
      summary: "uncertain delivery fact",
    }, undefined, undefined, context);
    assert.equal(uncertain.details.delivery, "uncertain");
    const uncertainRetry = await message.execute("message-5", {
      workflowId,
      summary: "uncertain delivery fact",
    }, undefined, undefined, context);
    assert.equal(uncertainRetry.details.delivery, "uncertain");
    assert.equal(prompts.length, 3, "uncertain delivery is never resubmitted");

    process.env.HERDR_PANE_ID = rootPane;
    await assert.rejects(
      message.execute("root-message", { workflowId, summary: "root has no parent" }, undefined, undefined, context),
      /root has no parent/,
    );
    process.env.HERDR_PANE_ID = "w-message:p99";
    await assert.rejects(
      message.execute("unregistered-message", { workflowId, summary: "not registered" }, undefined, undefined, context),
      /exactly one registered pane\/workspace assignment/,
    );
  } finally {
    for (const [key, value] of Object.entries(savedEnvironment))
      value === undefined ? delete process.env[key] : (process.env[key] = value);
    await rm(directory, { recursive: true, force: true });
  }
});
