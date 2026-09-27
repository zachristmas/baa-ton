import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
// A child process start can take minutes on a loaded machine (run-hermetic.mjs).
const CHILD_TIMEOUT_MS = Number(process.env.BAATON_HERDR_COMMAND_TIMEOUT_MS) || 120_000;
const worker = fileURLToPath(
  new URL("./fixtures/question-writer.mjs", import.meta.url),
);

test("process-separated root pause and concurrent cross-checkout questions preserve all records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baa-question-process-"));
  const parent = join(dir, "parent"),
    child = join(dir, "child");
  const store = join(parent, ".baa-ton/herdr-orchestrator/manifest.json");
  const run = (mode, pane, cwd) =>
    new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [worker, mode], {
        cwd,
        env: {
          ...process.env,
          HERDR_ENV: "1",
          HERDR_PANE_ID: pane,
          HERDR_WORKSPACE_ID: "w1",
          HERDR_PLUGIN_CONFIG_DIR: dir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "",
        error = "";
      const timeout = setTimeout(() => proc.kill(), Math.max(15_000, CHILD_TIMEOUT_MS));
      proc.stdout.on("data", (b) => (output += b));
      proc.stderr.on("data", (b) => (error += b));
      proc.on("error", reject);
      proc.on("close", (code) => {
        clearTimeout(timeout);
        code === 0
          ? resolve(JSON.parse(output))
          : reject(new Error(`Fixture exit ${code}: ${error}`));
      });
    });
  try {
    await mkdir(dirname(store), { recursive: true });
    await mkdir(child);
    const lanes = [
      { id: "a", paneId: "w1:p2" },
      { id: "b", paneId: "w1:p3" },
    ];
    await writeFile(
      store,
      JSON.stringify({
        version: 2,
        workflows: [{ id: "wf", lanes, evidence: [] }],
        parentGoal: {
          version: 1,
          id: "goal",
          status: "active",
          objective: "Test",
          nextAction: "Test",
          signals: [],
        },
      }),
    );
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({
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
              id: parent,
              workspace_id: "w1",
              parent_manifest_path: store,
            },
            workflows: [
              {
                workflow_id: "wf",
                manifest_path: store,
                lanes: lanes.map((lane) => ({
                  lane_id: lane.id,
                  target: lane.paneId,
                  target_kind: "pane_id",
                  pane_id: lane.paneId,
                  workspace_id: "w1",
                })),
              },
            ],
          },
        ],
      }),
      { mode: 0o600 },
    );
    await run("pause", "w1:p1", parent);
    const replies = await Promise.all([
      run("ask", "w1:p2", child),
      run("ask", "w1:p3", child),
      run("ask", "w1:p2", child),
    ]);
    for (const reply of replies)
      assert.match(reply.reason, /remains pending: parent is not ready/);
    const state = JSON.parse(await readFile(store, "utf8"));
    assert.equal(state.parentGoal.status, "paused");
    assert.equal(
      state.parentGoal.supervisor.pauseReason,
      "User pause during questions",
    );
    assert.equal(
      state.workflows[0].questionRequests.length,
      2,
      "retry in another process reuses the logical question",
    );
    await assert.rejects(
      readFile(join(child, ".baa-ton/herdr-orchestrator/manifest.json")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
