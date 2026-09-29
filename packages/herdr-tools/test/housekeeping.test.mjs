import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archivableWorkflows, capList, groupBy, liveSpecWorkflowIds, mentionedWorkflowIds, staleScratch, workflowFiles, writeArchive } from "../housekeeping.mjs";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-09-29T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const lane = (overrides = {}) => ({ id: "lane-1", status: "completion-reported", tabId: "w1:t2", retirement: { status: "retired" }, ...overrides });
const workflow = (id, overrides = {}) => ({ id, status: "completed", updatedAt: ago(5 * DAY), lanes: [lane()], ...overrides });
const archivable = (workflows, options = {}) => archivableWorkflows({ workflows }, { now: NOW, keepRecent: 0, ...options });

test("a finished workflow with every lane retired is archivable once it is old enough", () => {
  assert.deepEqual([...archivable([workflow("herdr-00000001")])], ["herdr-00000001"]);
  assert.deepEqual([...archivable([workflow("herdr-00000001", { updatedAt: ago(DAY) })])], [], "too new");
});

test("nothing that can still run or that something points at is archived", () => {
  const cases = {
    running: workflow("herdr-00000002", { status: "running" }),
    awaiting: workflow("herdr-00000003", { status: "awaiting-explicit-outcome" }),
    liveLane: workflow("herdr-00000004", { lanes: [lane({ status: "running" })] }),
    unretiredTab: workflow("herdr-00000005", { lanes: [lane({ retirement: undefined })] }),
    partial: workflow("herdr-00000006", { lanes: [lane({ retirement: { status: "partial" } })] }),
    noDate: workflow("herdr-00000007", { updatedAt: undefined, createdAt: undefined }),
  };
  assert.deepEqual([...archivable(Object.values(cases))], []);
  const pointedAt = workflow("herdr-00000008");
  assert.deepEqual([...archivable([pointedAt], { protectedIds: new Set(["herdr-00000008"]) })], []);
});

test("lanes that never had a tab, or are gone or superseded, do not block archiving", () => {
  const lanes = [lane({ status: "planned", tabId: undefined, retirement: undefined }), lane({ id: "lane-2", status: "gone", retirement: undefined })];
  assert.equal(archivable([workflow("herdr-00000009", { status: "dispatch-failed", lanes })]).size, 1);
});

test("the newest finished workflows always stay", () => {
  const all = ["a", "b", "c", "d"].map((letter, index) => workflow(`herdr-0000000${letter}`, { updatedAt: ago((5 + index) * DAY) }));
  assert.deepEqual([...archivable(all, { keepRecent: 2 })].sort(), ["herdr-0000000c", "herdr-0000000d"]);
});

test("ids are found wherever they are mentioned, including free text", () => {
  const found = mentionedWorkflowIds({ lane: { workflowId: "herdr-1234abcd" } }, "note: herdr-deadbeef finished; not-herdr-xyz");
  assert.deepEqual([...found].sort(), ["herdr-1234abcd", "herdr-deadbeef"]);
});

test("a workflow's own state files are found, and files elsewhere are left alone", () => {
  const dir = "/state/herdr-orchestrator";
  const files = workflowFiles({ id: "herdr-1", lanes: [{ startupIntentPath: `${dir}/herdr-1-lane-1-startup.json`, elsewhere: "/other/place/file.json", nested: `${dir}/sub/x.json` }] }, dir);
  assert.deepEqual(files.sort(), [`${dir}/herdr-1-lane-1-startup.json`, `${dir}/herdr-1-lane-1-startup.json.ready`]);
});

test("launch scratch goes when old and unused, and stays when a live process names it", () => {
  const names = ["claude-mcp-aaaaaaaa.json", "claude-settings-bbbbbbbb.json", "claude-lane-system-cccccccc.md", "claude-mcp-dddddddd.json", "manifest.json", "claude-mcp-eeeeeeee.json"];
  const modified = { "claude-mcp-dddddddd.json": NOW - 60_000, "claude-mcp-eeeeeeee.json": NOW - 3 * DAY };
  const gone = staleScratch({
    names, now: NOW, mtimeOf: (name) => modified[name] ?? NOW - 2 * DAY,
    liveCommandLines: ["claude --mcp-config /state/claude-mcp-eeeeeeee.json --x"],
  });
  assert.deepEqual(gone.sort(), ["claude-lane-system-cccccccc.md", "claude-mcp-aaaaaaaa.json", "claude-settings-bbbbbbbb.json"]);
});

test("the archive is appended monthly and holds the whole workflow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "housekeeping-"));
  try {
    const path = writeArchive(dir, [workflow("herdr-0000000a"), workflow("herdr-0000000b")], NOW);
    assert.match(path, /archive\/workflows-2026-09\.jsonl$/);
    writeArchive(dir, [workflow("herdr-0000000c")], NOW);
    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.workflow.id), ["herdr-0000000a", "herdr-0000000b", "herdr-0000000c"]);
    assert.equal(lines[0].workflow.lanes[0].retirement.status, "retired");
    assert.equal(writeArchive(dir, [], NOW), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("long lists are capped with the rest counted, and repeats are grouped", () => {
  assert.deepEqual(capList([1, 2, 3, 4], 2), { items: [1, 2], total: 4, omitted: 2 });
  assert.deepEqual(capList(undefined), { items: [], total: 0, omitted: 0 });
  assert.deepEqual(groupBy([{ e: "x" }, { e: "y" }, { e: "x" }], (item) => item.e), [{ text: "x", count: 2 }, { text: "y", count: 1 }]);
});

test("the spec driver protects only what it can still act on, not history notes", () => {
  const found = liveSpecWorkflowIds({
    items: {
      D01: { state: "done", lastWorkflowId: "herdr-00000001", history: [{ note: "see herdr-00000002" }] },
      D02: { state: "pending", workflowId: "herdr-00000003", history: [{ note: "was herdr-00000004" }] },
    },
    decisions: [{ text: "herdr-00000005" }],
    baselines: { abc: { workflow: "herdr-00000006" } },
    syncRun: { workflowId: "herdr-00000007" },
  });
  assert.deepEqual([...found].sort(), ["herdr-00000003", "herdr-00000007"]);
  assert.equal(liveSpecWorkflowIds(undefined).size, 0);
});
