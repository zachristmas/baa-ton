import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { blocksUnmanagedAgentCommand, isReadOnlyPiDiagnostic } =
  await jiti.import("../command-policy.ts");
const { default: extension } = await jiti.import("../index.ts");

test("standalone non-secret Pi diagnostics are allowed, not launches or shell tails", () => {
  for (const command of [
    "pi auth check --provider openai-codex --model gpt-5.6-luna --json --no-refresh",
    "pi --offline --list-models luna",
    "pi --list-models",
    "pi --help",
    "pi --version",
  ]) {
    assert.equal(isReadOnlyPiDiagnostic(command), true, command);
    assert.equal(blocksUnmanagedAgentCommand(command), false, command);
  }
  for (const command of [
    "pi",
    "pi -p hello",
    "pi --provider openai-codex --model gpt-5.6-luna",
    "pi auth check --provider openai-codex --credentials --no-refresh",
    "pi auth check --provider openai-codex",
    "pi auth print-bearer-token --provider openai-codex",
    "pi --help; pi -p hello",
    "pi --help && pi -p hello",
    "pi --help\npi -p hello",
    "pi --help &",
    "pi --list-models $(pi -p hello)",
    "pi --list-models `pi -p hello`",
    "pi auth check --provider --no-refresh",
    "pi --list-models --extension=evil.ts",
    "echo ok; pi -p hello",
    "nohup pi -p hello",
    "pi-background-tasks run",
  ]) {
    assert.equal(isReadOnlyPiDiagnostic(command), false, command);
    assert.equal(blocksUnmanagedAgentCommand(command), true, command);
  }
});

test("child question routing failures are visible and never masquerade as an approval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baa-guard-"));
  const saved = Object.fromEntries(
    [
      "HERDR_ENV",
      "HERDR_PANE_ID",
      "HERDR_WORKSPACE_ID",
      "HERDR_PLUGIN_CONFIG_DIR",
    ].map((k) => [k, process.env[k]]),
  );
  const store = join(
    dir,
    "parent",
    ".baa-ton",
    "herdr-orchestrator",
    "manifest.json",
  );
  const workflow = {
    id: "wf",
    lanes: [{ id: "lane-1", paneId: "w1:p2" }],
    evidence: [],
  };
  const config = {
    version: 2,
    owner: "herdr-orchestrator",
    orchestrators: [
      {
        id: "task",
        root: {
          target: "w1:p1",
          target_kind: "pane_id",
          pane_id: "w1:p1",
          workspace_id: "w1",
          agent_kind: "pi",
        },
        program: {
          id: join(dir, "parent"),
          workspace_id: "w1",
          parent_manifest_path: store,
        },
        workflows: [
          {
            workflow_id: "wf",
            manifest_path: store,
            lanes: [
              {
                lane_id: "lane-1",
                target: "w1:p2",
                target_kind: "pane_id",
                pane_id: "w1:p2",
                workspace_id: "w1",
              },
            ],
          },
        ],
      },
    ],
  };
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w1:p2",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_PLUGIN_CONFIG_DIR: dir,
  });
  const handlers = new Map();
  let prompts = 0;
  let parentState = "working";
  extension({
    on: (event, handler) => handlers.set(event, handler),
    registerTool() {},
    registerCommand() {},
    async exec(_command, args) {
      if (args[1] === "get")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              type: "agent_info",
              agent: {
                pane_id: "w1:p1",
                workspace_id: "w1",
                agent: "pi",
                agent_status: parentState,
              },
            },
          }),
        };
      if (args[1] === "prompt") {
        prompts++;
        return {
          code: 1,
          stderr: "socket_timeout after submission",
          stdout: "",
        };
      }
      throw new Error("unexpected call");
    },
  });
  const ask = () =>
    handlers.get("tool_call")(
      {
        toolName: "ask_user_question",
        input: { questions: ["Need a decision?"] },
      },
      { cwd: join(dir, "different-checkout"), hasUI: false },
    );
  try {
    await writeFile(join(dir, "config.json"), JSON.stringify(config), {
      mode: 0o600,
    });
    const missing = await ask();
    assert.equal(missing.block, true);
    assert.notEqual(missing.terminate, true);
    assert.match(missing.reason, /routing failed.*Unknown Herdr workflow/);
    await mkdir(join(dir, "parent", ".baa-ton", "herdr-orchestrator"), {
      recursive: true,
    });
    await writeFile(
      store,
      JSON.stringify({
        version: 2,
        workflows: [workflow],
        parentGoal: { status: "paused" },
      }),
    );
    const busy = await ask();
    assert.match(busy.reason, /remains pending: parent is not ready/);
    assert.equal(prompts, 0);
    parentState = "idle";
    const lost = await ask();
    assert.match(lost.reason, /delivery is uncertain/);
    assert.notEqual(lost.terminate, true);
    await ask();
    assert.equal(
      prompts,
      1,
      "lost submission response does not authorize retyping",
    );
    const state = JSON.parse(await readFile(store, "utf8"));
    assert.equal(state.parentGoal.status, "paused");
    assert.equal(state.workflows[0].questionRequests.length, 1);
    assert.equal(
      state.workflows[0].questionRequests[0].delivery.status,
      "uncertain",
    );
    await assert.rejects(
      readFile(
        join(dir, "different-checkout", ".baa-ton/herdr-orchestrator/manifest.json"),
      ),
      { code: "ENOENT" },
    );
    process.env.HERDR_PANE_ID = "w1:p1";
    assert.equal(
      await ask(),
      undefined,
      "registered parent retains direct decision UI",
    );
  } finally {
    for (const [key, value] of Object.entries(saved))
      value === undefined
        ? delete process.env[key]
        : (process.env[key] = value);
    await rm(dir, { recursive: true, force: true });
  }
});

test("external push stays blocked even for the root; lanes and other mutations stay blocked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baa-guard-push-"));
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map(
      (k) => [k, process.env[k]],
    ),
  );
  const closeVerb = ["clo", "se"].join("");
  const pushVerb = ["pu", "sh"].join("");
  const mergeVerb = ["mer", "ge"].join("");
  const config = {
    version: 2,
    owner: "herdr-orchestrator",
    orchestrators: [
      {
        id: "task",
        root: {
          target: "w1:p1",
          target_kind: "pane_id",
          pane_id: "w1:p1",
          workspace_id: "w1",
          agent_kind: "pi",
        },
        program: {
          id: join(dir, "parent"),
          workspace_id: "w1",
          parent_manifest_path: join(dir, "store.json"),
        },
        workflows: [],
      },
    ],
  };
  await writeFile(join(dir, "config.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  const handlers = new Map();
  extension({
    on: (event, handler) => handlers.set(event, handler),
    registerTool() {},
    registerCommand() {},
    async exec() {
      throw new Error("guard checks must not call native Herdr");
    },
  });
  const bash = (command) =>
    handlers.get("tool_call")(
      { toolName: "bash", input: { command } },
      { cwd: join(dir, "parent"), hasUI: false },
    );
  const setPane = (paneId) => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = paneId;
    process.env.HERDR_WORKSPACE_ID = "w1";
    process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
  };
  const blockedReason = async (command) => (await bash(command))?.reason ?? "";
  try {
    setPane("w1:p1"); // verified controller-mapped root
    assert.match(await blockedReason(`git ${pushVerb} origin main`), /require/, "root push stays hard-gated");
    for (const command of [
      "gh pr create -R owner/repo --base main",
      "gh pr merge topic -R owner/repo --merge",
      "env gh pr create -R owner/repo --base main",
      "env gh pr merge topic -R owner/repo --merge",
      "sh -c 'gh pr create -R owner/repo --base main'",
      "sh -c 'gh pr merge topic -R owner/repo --merge'",
    ]) assert.match(await blockedReason(command), /require/, `root blocks unapproved direct/wrapped PR mutation: ${command}`);
    assert.equal(await bash("git status"), undefined);
    assert.equal(await bash("pwd"), undefined, "ordinary Bash remains available");
    assert.match(await blockedReason(`git ${mergeVerb} feature`), /require/);
    assert.match(
      await blockedReason(`git ${pushVerb} origin main && git ${mergeVerb} feature`),
      /require/,
    );
    assert.match(await blockedReason(`herdr workspace ${closeVerb} w1`), /require/);
    assert.equal(await bash(`herdr tab ${closeVerb} w1:t3`), undefined, "root may retire lane tabs");
    assert.equal(await bash(`herdr pane ${closeVerb} w1:p3`), undefined, "root may retire lane panes");
    assert.match(await blockedReason("npm run deploy"), /require/);
    setPane("w1:p2"); // unmapped pane: not the root
    assert.match(await blockedReason(`git ${pushVerb} origin main`), /require/);
    for (const command of [
      "gh pr create -R owner/repo --base main",
      "gh pr merge topic -R owner/repo --merge",
      "env gh pr create -R owner/repo --base main",
      "env gh pr merge topic -R owner/repo --merge",
      "sh -c 'gh pr create -R owner/repo --base main'",
      "sh -c 'gh pr merge topic -R owner/repo --merge'",
    ]) assert.match(await blockedReason(command), /require/, `child blocks direct/wrapped PR mutation: ${command}`);
    assert.match(await blockedReason(`herdr tab ${closeVerb} w1:t3`), /require/);
  } finally {
    for (const [key, value] of Object.entries(saved))
      value === undefined
        ? delete process.env[key]
        : (process.env[key] = value);
    await rm(dir, { recursive: true, force: true });
  }
});
