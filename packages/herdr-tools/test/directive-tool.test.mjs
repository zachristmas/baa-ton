import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

test("the root lists and acknowledges only its own open directives", async () => {
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map((key) => [key, process.env[key]]),
  );
  const directory = await mkdtemp(join(tmpdir(), "baa-directive-"));
  const configDir = join(directory, "config");
  const parent = join(directory, "parent");
  const manifestPath = join(parent, ".baa-ton", "herdr-orchestrator", "manifest.json");
  const rootPane = "w-dir:p1";
  await mkdir(join(parent, ".baa-ton", "herdr-orchestrator"), { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const directive = (id, rootId, status = "open") => ({
    id, rootId, from: "zach", text: `Directive ${id}`, createdAt: "t", status, sends: 1,
    delivery: { status: "delivered", attempts: 1, updatedAt: "t" },
  });
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 2,
      workflows: [],
      directives: [
        directive("directive-mine", "orchestrator-dir"),
        directive("directive-other", "orchestrator-elsewhere"),
        directive("directive-done", "orchestrator-dir", "acked"),
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
        id: "orchestrator-dir",
        root: { target: rootPane, target_kind: "pane_id", pane_id: rootPane, workspace_id: "w-dir", agent_kind: "pi" },
        program: { id: parent, workspace_id: "w-dir", parent_manifest_path: manifestPath, directive_escalate_minutes: 20 },
        workflows: [],
      }],
    }),
    { mode: 0o600 },
  );
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: rootPane, HERDR_WORKSPACE_ID: "w-dir", HERDR_PLUGIN_CONFIG_DIR: configDir });
  const tools = new Map();
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
  const call = (params) =>
    tools.get("herdr_directive").execute("directive", params, undefined, undefined, {
      cwd: parent,
      mode: "json",
      hasUI: false,
      ui: { confirm: async () => false, notify() {} },
    });
  try {
    const listed = await call({ action: "list" });
    assert.deepEqual(listed.details.directives.map((item) => item.id), ["directive-mine"]);
    const acked = await call({ action: "ack", id: "directive-mine", note: "Sweeping after the current lane lands." });
    assert.equal(acked.details.directive.status, "acked");
    assert.match(acked.content[0].text, /ack: Sweeping after the current lane lands\./);
    await assert.rejects(call({ action: "ack", id: "directive-other" }), /Unknown directive directive-other for this root/);
    assert.equal((await call({ action: "list" })).details.directives.length, 0);
    assert.equal((await call({ action: "list", includeAcked: true })).details.directives.length, 2);
    const stored = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(stored.directives[0].ackNote, "Sweeping after the current lane lands.");
    assert.equal(stored.directives[1].status, "open", "another root's directive is untouched");
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  }
});
