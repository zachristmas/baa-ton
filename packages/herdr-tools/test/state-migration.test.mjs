import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatMigrationResult,
  legacyStateStatus,
  migrateProjectState,
  rewriteStateText,
} from "../state-migration.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "baa-state-migration-")));
  const project = join(directory, "project");
  const legacy = join(project, ".pi", "herdr-orchestrator");
  const current = join(project, ".baa-ton", "herdr-orchestrator");
  const controller = join(directory, "controller");
  const other = join(directory, "other-project", ".pi", "herdr-orchestrator");
  const oldManifest = join(legacy, "manifest.json");
  const newManifest = join(current, "manifest.json");
  const oldScope = `orchestrator:w1:${sha256(oldManifest)}`;
  await mkdir(join(legacy, ".claude-settings-1.json.lock"), { recursive: true });
  await mkdir(join(project, ".baa-ton"), { recursive: true });
  await writeFile(join(project, ".baa-ton", "config.json"), "{}\n");
  await writeFile(
    oldManifest,
    `${JSON.stringify(
      {
        version: 2,
        workflows: [
          {
            id: "herdr-1",
            lanes: [
              {
                id: "lane-1",
                startupIntentPath: join(legacy, "herdr-1-lane-1-startup.json"),
              },
            ],
            eventController: { events: [{ identity: `stall:${oldScope}:herdr-1/lane-1` }] },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(legacy, "claude-settings-1.json"),
    JSON.stringify({ hooks: { SessionStart: [{ command: `node attest ${join(legacy, "intent.json")}` }] } }),
  );
  await writeFile(join(legacy, "herdr-1-lane-1-startup.json.ready"), `${legacy}\n`);
  await mkdir(controller, { recursive: true });
  await writeFile(
    join(controller, "config.json"),
    `${JSON.stringify(
      {
        program: { parent_manifest_path: oldManifest },
        workflows: [
          { workflow_id: "herdr-1", manifest_path: oldManifest, lanes: [] },
          { workflow_id: "herdr-9", manifest_path: join(other, "manifest.json"), lanes: [] },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(controller, "inbox.json"),
    JSON.stringify({ messages: [{ logicalKey: `lane-event:${oldScope}:herdr-1/lane-1/done` }] }),
  );
  return {
    directory,
    project,
    legacy,
    current,
    controller,
    other,
    oldManifest,
    newManifest,
    newScope: `orchestrator:w1:${sha256(newManifest)}`,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("migration copies state, rewrites paths and route hashes, and keeps the archive", async () => {
  const f = await fixture();
  try {
    assert.equal((await legacyStateStatus(f.project)).needsMigration, true);
    const result = await migrateProjectState({
      projectRoot: f.project,
      controllerConfigDirectory: f.controller,
      now: () => new Date("2026-09-22T12:00:00Z"),
    });
    assert.equal(result.status, "migrated");
    assert.equal(result.copiedFiles, 3);

    const manifest = JSON.parse(await readFile(f.newManifest, "utf8"));
    assert.equal(
      manifest.workflows[0].lanes[0].startupIntentPath,
      join(f.current, "herdr-1-lane-1-startup.json"),
    );
    assert.equal(
      manifest.workflows[0].eventController.events[0].identity,
      `stall:${f.newScope}:herdr-1/lane-1`,
    );
    assert.match(await readFile(join(f.current, "claude-settings-1.json"), "utf8"), /\.baa-ton/);
    assert.equal(
      await readFile(join(f.current, "herdr-1-lane-1-startup.json.ready"), "utf8"),
      `${f.current}\n`,
    );
    assert.equal(
      (await readdir(f.current)).some((name) => name.endsWith(".lock")),
      false,
      "live lock directories are not copied",
    );

    const config = JSON.parse(await readFile(join(f.controller, "config.json"), "utf8"));
    assert.equal(config.program.parent_manifest_path, f.newManifest);
    assert.equal(config.workflows[0].manifest_path, f.newManifest);
    assert.equal(
      config.workflows[1].manifest_path,
      join(f.other, "manifest.json"),
      "another project's mapping is untouched",
    );
    const inbox = JSON.parse(await readFile(join(f.controller, "inbox.json"), "utf8"));
    assert.equal(inbox.messages[0].logicalKey, `lane-event:${f.newScope}:herdr-1/lane-1/done`);
    const backups = (await readdir(f.controller)).filter((name) =>
      name.includes(".pre-baa-ton-migration-"),
    );
    assert.equal(backups.length, 2);

    assert.ok(existsSync(f.oldManifest), "the legacy directory stays as an archive");
    const status = await legacyStateStatus(f.project);
    assert.equal(status.migrated, true);
    assert.equal(status.needsMigration, false);
    assert.match(formatMigrationResult(result), /kept as an archive/);

    const again = await migrateProjectState({
      projectRoot: f.project,
      controllerConfigDirectory: f.controller,
    });
    assert.equal(again.status, "already-migrated");
  } finally {
    await f.cleanup();
  }
});

test("migration refuses when both locations hold different state", async () => {
  const f = await fixture();
  try {
    await mkdir(f.current, { recursive: true });
    await writeFile(f.newManifest, `${JSON.stringify({ version: 2, workflows: [] })}\n`);
    const configBefore = await readFile(join(f.controller, "config.json"), "utf8");
    await assert.rejects(
      migrateProjectState({ projectRoot: f.project, controllerConfigDirectory: f.controller }),
      /exist and differ/,
    );
    assert.equal(await readFile(join(f.controller, "config.json"), "utf8"), configBefore);
    assert.equal((await legacyStateStatus(f.project)).migrated, false);
    assert.equal(
      existsSync(join(f.legacy, ".manifest.json.herdr-orchestrator.lock")),
      false,
      "the refused migration released its lock",
    );
  } finally {
    await f.cleanup();
  }
});

test("an interrupted migration resumes and finishes the controller rewrite", async () => {
  const f = await fixture();
  try {
    await mkdir(f.current, { recursive: true });
    const pairs = [
      [f.legacy, f.current],
      [sha256(f.oldManifest), sha256(f.newManifest)],
    ];
    await writeFile(f.newManifest, rewriteStateText(await readFile(f.oldManifest, "utf8"), pairs));
    const result = await migrateProjectState({
      projectRoot: f.project,
      controllerConfigDirectory: f.controller,
    });
    assert.equal(result.status, "migrated");
    assert.deepEqual(result.keptExisting, [f.newManifest]);
    assert.ok(existsSync(join(f.current, "claude-settings-1.json")), "missing lane files are filled in");
    assert.equal(result.controllerFiles.length, 2);
  } finally {
    await f.cleanup();
  }
});

test("status flags an old Baa-ton still writing the archive after migration", async () => {
  const f = await fixture();
  try {
    await migrateProjectState({ projectRoot: f.project });
    const later = new Date(Date.now() + 60_000);
    await utimes(f.oldManifest, later, later);
    const status = await legacyStateStatus(f.project);
    assert.equal(status.legacyWrittenAfterMigration, true);
    assert.match(
      formatMigrationResult({ status: "already-migrated", ...status }),
      /still runs an old Baa-ton/,
    );
  } finally {
    await f.cleanup();
  }
});

test("without a controller directory the result says mappings were left alone", async () => {
  const f = await fixture();
  try {
    const result = await migrateProjectState({ projectRoot: f.project });
    assert.equal(result.status, "migrated");
    assert.match(formatMigrationResult(result), /Controller config was not rewritten/);
    const config = JSON.parse(await readFile(join(f.controller, "config.json"), "utf8"));
    assert.equal(config.workflows[0].manifest_path, f.oldManifest);
  } finally {
    await f.cleanup();
  }
});

test("a project with no legacy state is left alone", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "baa-state-none-")));
  try {
    const result = await migrateProjectState({ projectRoot: directory });
    assert.equal(result.status, "no-legacy-state");
    assert.equal(existsSync(join(directory, ".baa-ton")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("doctor reports unmigrated legacy state and the migrated archive", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const jiti = require("jiti")(import.meta.url);
  const { default: extension } = await jiti.import("../index.ts");
  const f = await fixture();
  try {
    const tools = new Map();
    extension({
      on() {},
      registerTool(descriptor) {
        tools.set(descriptor.name, descriptor);
      },
      registerCommand() {},
      async exec() {
        return { stdout: "", stderr: '{"error":{"code":"not_in_test"}}', code: 1 };
      },
    });
    const stateCheck = async () =>
      (
        await tools
          .get("herdr_doctor")
          .execute("doctor", {}, undefined, undefined, { cwd: f.project, hasUI: false, mode: "json" })
      ).details.checks.find((entry) => entry.id === "state-location");
    const before = await stateCheck();
    assert.equal(before.status, "fail");
    assert.match(before.detail, /still at .*\.pi.herdr-orchestrator/);
    assert.equal(existsSync(f.newManifest), false, "doctor never writes state");

    await migrateProjectState({ projectRoot: f.project });
    const after = await stateCheck();
    assert.equal(after.status, "ok");
    assert.match(after.detail, /kept as an archive/);
  } finally {
    await f.cleanup();
  }
});
