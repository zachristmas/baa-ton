import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyScreen } from "../blocked-lane.mjs";
import { ROOT_DIALOG_DEFAULT_MS, ROOT_DIALOG_READ_EVERY_MS, keysToOption, superviseRootDialog } from "../root-dialog.mjs";

const PANE = "w-root:p1";
const ORCHESTRATOR = { id: "task", root: { pane_id: PANE, agent_kind: "pi" } };

// A Pi select dialog: the cursor marks one option, options are not numbered.
const piDialog = `
 The dispatched lane declined again and the bridge cannot reattach it.
 How should the root proceed?

 › Root takes over the item (Recommended)
   Dispatch another lane
   Pause the item

 ↑↓ navigate • enter select • esc cancel
`;

async function project({ autonomous = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "baa-root-dialog-"));
  const manifestPath = join(directory, ".baa-ton", "herdr-orchestrator", "manifest.json");
  await mkdir(join(directory, ".baa-ton", "herdr-orchestrator"), { recursive: true });
  if (autonomous) await writeFile(join(directory, ".baa-ton", "spec.json"), "{}");
  return { manifestPath, manifest: autonomous ? { approvalPolicyAck: { hash: "h" } } : {}, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function fakeHerdr(screen, status = "working") {
  const calls = { keys: [], reads: 0, gets: 0 };
  return {
    calls,
    screen,
    status,
    async request(method, params) {
      if (method === "agent.get") {
        calls.gets += 1;
        return { type: "agent_info", agent: { agent: "pi", pane_id: PANE, agent_status: this.status } };
      }
      if (method === "agent.read") {
        assert.equal(params.source, "visible");
        calls.reads += 1;
        return { type: "pane_read", read: { pane_id: PANE, text: this.screen } };
      }
      throw new Error(method);
    },
    async sendKeys(paneId, keys) {
      calls.keys.push(keys);
    },
  };
}

const at = (ms) => new Date(Date.parse("2026-09-26T01:00:00.000Z") + ms).toISOString();

test("an unnumbered Pi select dialog with one Recommended option is a question", () => {
  const screen = classifyScreen(piDialog);
  assert.equal(screen.kind, "question");
  assert.equal(screen.question, "The dispatched lane declined again and the bridge cannot reattach it. How should the root proceed?");
  assert.deepEqual(screen.options.map((option) => [option.label, option.selected]), [
    ["Root takes over the item (Recommended)", true],
    ["Dispatch another lane", false],
    ["Pause the item", false],
  ]);
  assert.equal(classifyScreen(piDialog.replace(" (Recommended)", "")).kind, "unknown", "unnumbered and unmarked is too ambiguous");
  assert.deepEqual(keysToOption(screen.options, 3), ["down", "down", "enter"]);
  assert.deepEqual(keysToOption([{ number: 1 }, { number: 2, selected: true }], 1), ["up", "enter"]);
});

test("a root dialog still open after the wait gets its Recommended option, re-checked, logged and notified", async () => {
  const p = await project();
  try {
    const herdr = fakeHerdr(piDialog.replace("› Root takes over the item (Recommended)\n   Dispatch another lane", "  Root takes over the item (Recommended)\n › Dispatch another lane"));
    const entry = {};
    const notes = [];
    const run = (ms) => superviseRootDialog({ orchestrator: ORCHESTRATOR, manifest: p.manifest, manifestPath: p.manifestPath, entry, herdr, notify: async (note) => notes.push(note), timestamp: at(ms) });
    assert.equal((await run(0)).action, "seen");
    assert.equal(herdr.calls.reads, 1);
    // Not before the interval: no Herdr call at all.
    await run(60_000);
    assert.equal(herdr.calls.reads + herdr.calls.gets, 2);
    await run(ROOT_DIALOG_READ_EVERY_MS);
    assert.equal(herdr.calls.keys.length, 0, "not before the default is due");
    const answered = await run(ROOT_DIALOG_DEFAULT_MS);
    assert.equal(answered.action, "answered");
    assert.deepEqual(herdr.calls.keys, [["up", "enter"]], "from the cursor up to the Recommended option");
    assert.match(p.manifest.unattendedDecisions[0].decision, /Root takes over the item/);
    assert.equal(notes.at(-1).title, "Baa-ton: root question auto-answered");
    await run(ROOT_DIALOG_DEFAULT_MS + 60_000);
    assert.equal(herdr.calls.keys.length, 1, "once");
  } finally {
    await p.cleanup();
  }
});

test("no keys for production or unclear-requirements questions, a changed dialog, or a run that is not autonomous", async () => {
  const p = await project();
  try {
    const push = fakeHerdr(piDialog.replace("How should the root proceed?", "Run the migration against production now?"));
    const entry = {};
    const notes = [];
    for (const ms of [0, ROOT_DIALOG_DEFAULT_MS]) await superviseRootDialog({ orchestrator: ORCHESTRATOR, manifest: p.manifest, manifestPath: p.manifestPath, entry, herdr: push, notify: async (note) => notes.push(note), timestamp: at(ms) });
    assert.equal(push.calls.keys.length, 0);
    assert.match(notes[0].body, /stays with a person/);

    const changing = fakeHerdr(piDialog);
    const entry2 = {};
    await superviseRootDialog({ orchestrator: ORCHESTRATOR, manifest: p.manifest, manifestPath: p.manifestPath, entry: entry2, herdr: changing, timestamp: at(0) });
    changing.screen = piDialog.replace("Pause the item", "Retire the item");
    await superviseRootDialog({ orchestrator: ORCHESTRATOR, manifest: p.manifest, manifestPath: p.manifestPath, entry: entry2, herdr: changing, timestamp: at(ROOT_DIALOG_DEFAULT_MS) });
    assert.equal(changing.calls.keys.length, 0, "a new dialog starts its own wait");

    const idle = fakeHerdr(piDialog, "idle");
    const entry3 = {};
    await superviseRootDialog({ orchestrator: ORCHESTRATOR, manifest: p.manifest, manifestPath: p.manifestPath, entry: entry3, herdr: idle, timestamp: at(0) });
    assert.equal(idle.calls.reads, 0, "an idle root is not read");
  } finally {
    await p.cleanup();
  }
  const q = await project({ autonomous: false });
  try {
    const herdr = fakeHerdr(piDialog);
    await superviseRootDialog({ orchestrator: ORCHESTRATOR, manifest: q.manifest, manifestPath: q.manifestPath, entry: {}, herdr, timestamp: at(0) });
    assert.equal(herdr.calls.gets + herdr.calls.reads, 0, "outside an autonomous run nothing is read");
  } finally {
    await q.cleanup();
  }
});
