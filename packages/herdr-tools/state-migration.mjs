#!/usr/bin/env node
/**
 * Migrate a project's orchestrator state from `.pi/herdr-orchestrator` to
 * `.baa-ton/herdr-orchestrator` (renamed in f00b5e5).
 *
 * The state is not just relocatable files. The manifest, lane startup files
 * and the controller's config.json and inbox.json store absolute paths into
 * the state directory, and controller route ids embed sha256(manifest path).
 * A plain move would leave the controller mapped to the old path, which the
 * extension rejects, and loadManifest would start an empty manifest.
 *
 * The migration copies, never moves: the legacy directory stays as an
 * archive with a marker, because running Claude lanes were launched with
 * --settings files inside it. It takes the same mkdir locks as the extension,
 * controller and inbox, so it never interleaves with a live writer, and it is
 * idempotent: rerunning after an interruption finishes the remaining steps.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const LEGACY_STATE_DIRECTORY = join(".pi", "herdr-orchestrator");
export const STATE_DIRECTORY = join(".baa-ton", "herdr-orchestrator");
export const MIGRATION_MARKER = "MIGRATED-TO-BAA-TON.json";
const MANIFEST_NAME = "manifest.json";
const MANIFEST_LOCK = `.${MANIFEST_NAME}.herdr-orchestrator.lock`;
const CONTROLLER_FILES = ["config.json", "inbox.json"];
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 10;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function statePaths(projectRoot) {
  const root = resolve(projectRoot);
  const legacy = join(root, LEGACY_STATE_DIRECTORY);
  const current = join(root, STATE_DIRECTORY);
  return {
    root,
    legacy,
    current,
    legacyManifest: join(legacy, MANIFEST_NAME),
    currentManifest: join(current, MANIFEST_NAME),
    marker: join(legacy, MIGRATION_MARKER),
  };
}

/**
 * Report where a project's orchestrator state lives without changing it.
 * `needsMigration` is the case the extension must refuse to paper over with
 * an empty manifest. `legacyWrittenAfterMigration` means something still ran
 * old Baa-ton against the archive after the copy was made.
 */
export async function legacyStateStatus(projectRoot) {
  const paths = statePaths(projectRoot);
  const legacy = existsSync(paths.legacyManifest);
  const current = existsSync(paths.currentManifest);
  const migrated = existsSync(paths.marker);
  let legacyWrittenAfterMigration = false;
  if (legacy && migrated) {
    const [manifest, marker] = await Promise.all([
      stat(paths.legacyManifest),
      stat(paths.marker),
    ]);
    legacyWrittenAfterMigration = manifest.mtimeMs > marker.mtimeMs;
  }
  return {
    legacy,
    current,
    migrated,
    needsMigration: legacy && !migrated,
    legacyWrittenAfterMigration,
    legacyDirectory: paths.legacy,
    currentDirectory: paths.current,
  };
}

/** Replacement pairs for every form the old location takes inside state. */
function replacementsFor(paths) {
  const pairs = [
    [paths.legacy, paths.current],
    [sha256(paths.legacyManifest), sha256(paths.currentManifest)],
  ];
  if (sep === "\\")
    pairs.push([
      paths.legacy.replaceAll("\\", "/"),
      paths.current.replaceAll("\\", "/"),
    ]);
  return pairs;
}

function rewriteString(value, pairs) {
  let result = value;
  for (const [from, to] of pairs) result = result.split(from).join(to);
  return result;
}

function rewriteValue(value, pairs) {
  if (typeof value === "string") return rewriteString(value, pairs);
  if (Array.isArray(value)) return value.map((item) => rewriteValue(item, pairs));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        rewriteString(key, pairs),
        rewriteValue(item, pairs),
      ]),
    );
  return value;
}

/**
 * Rewrite one file's text. JSON is rewritten structurally so escaped Windows
 * paths match; anything else gets a literal replacement.
 */
export function rewriteStateText(text, pairs) {
  try {
    const parsed = JSON.parse(text);
    const rewritten = rewriteValue(parsed, pairs);
    if (JSON.stringify(rewritten) === JSON.stringify(parsed)) return text;
    const indented = /^\s*[[{]\s*\n/.test(text);
    return `${JSON.stringify(rewritten, null, indented ? 2 : undefined)}${text.endsWith("\n") ? "\n" : ""}`;
  } catch {
    return rewriteString(text, pairs);
  }
}

async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(
        join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString(), purpose: "state-migration" })}\n`,
        { mode: 0o600 },
      );
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code === "ENOENT") return async () => {};
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw new Error(
          `Timed out waiting for ${lockPath}; another Baa-ton writer is active. Retry when it finishes.`,
        );
      await new Promise((done) => setTimeout(done, LOCK_RETRY_MS));
    }
  }
}

const isLockEntry = (name) => name.endsWith(".lock") || name.endsWith(".tmp");

async function copyRewritten(from, to, pairs, counts) {
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (isLockEntry(entry.name) || entry.name === MIGRATION_MARKER) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      await copyRewritten(source, target, pairs, counts);
    } else if (entry.isFile()) {
      const text = await readFile(source, "utf8");
      const rewritten = rewriteStateText(text, pairs);
      await writeFile(target, rewritten, { mode: 0o600 });
      counts.files += 1;
      if (rewritten !== text) counts.rewritten += 1;
    }
  }
}

/** Move staged entries into place without overwriting anything already there. */
async function placeStaged(staging, current, skipped) {
  if (!existsSync(current)) {
    await mkdir(dirname(current), { recursive: true, mode: 0o700 });
    await rename(staging, current);
    return;
  }
  for (const entry of await readdir(staging)) {
    const target = join(current, entry);
    if (existsSync(target)) skipped.push(target);
    else await rename(join(staging, entry), target);
  }
  await rm(staging, { recursive: true, force: true });
}

async function rewriteControllerFiles(directory, pairs, stamp) {
  const rewritten = [];
  for (const name of CONTROLLER_FILES) {
    const path = join(directory, name);
    if (!existsSync(path)) continue;
    const release = await acquireLock(`${path}.lock`);
    try {
      const text = await readFile(path, "utf8");
      const next = rewriteStateText(text, pairs);
      if (next === text) continue;
      await copyFile(path, `${path}.pre-baa-ton-migration-${stamp}`);
      const temporary = `${path}.${process.pid}.migration.tmp`;
      await writeFile(temporary, next, { mode: 0o600 });
      await rename(temporary, path);
      rewritten.push(path);
    } finally {
      await release();
    }
  }
  return rewritten;
}

/**
 * Migrate one project. `controllerConfigDirectory` is the Herdr plugin config
 * directory for herdr-orchestrator-controller; without it the project state
 * moves but the controller keeps legacy mappings, which the result reports.
 */
export async function migrateProjectState({
  projectRoot,
  controllerConfigDirectory,
  now = () => new Date(),
} = {}) {
  const paths = statePaths(projectRoot);
  const status = await legacyStateStatus(paths.root);
  if (!status.legacy) return { status: "no-legacy-state", ...status };
  if (status.migrated) return { status: "already-migrated", ...status };

  const pairs = replacementsFor(paths);
  const stamp = now().toISOString().replaceAll(":", "-");
  const counts = { files: 0, rewritten: 0 };
  const skipped = [];
  const release = await acquireLock(join(paths.legacy, MANIFEST_LOCK));
  try {
    if (status.current) {
      // Resume only an interrupted migration: the new manifest must be the
      // rewritten legacy one. Anything else means both locations hold live
      // state, and choosing one would discard the other.
      const [legacyText, currentText] = await Promise.all([
        readFile(paths.legacyManifest, "utf8"),
        readFile(paths.currentManifest, "utf8"),
      ]);
      if (rewriteStateText(legacyText, pairs) !== currentText)
        throw new Error(
          `Both ${paths.legacyManifest} and ${paths.currentManifest} exist and differ. Nothing was changed; compare them and keep one before migrating.`,
        );
    }
    // Always stage and merge: a resumed run fills in any lane files the
    // interrupted one had not placed yet, and never overwrites one it had.
    const staging = `${paths.current}.migrating-${process.pid}`;
    await rm(staging, { recursive: true, force: true });
    await copyRewritten(paths.legacy, staging, pairs, counts);
    await placeStaged(staging, paths.current, skipped);
    const controllerFiles = controllerConfigDirectory
      ? await rewriteControllerFiles(resolve(controllerConfigDirectory), pairs, stamp)
      : [];
    const result = {
      migratedTo: paths.current,
      migratedAt: now().toISOString(),
      copiedFiles: counts.files,
      rewrittenFiles: counts.rewritten,
      keptExisting: skipped,
      controllerFiles,
      controllerConfigDirectory: controllerConfigDirectory
        ? resolve(controllerConfigDirectory)
        : null,
    };
    await writeFile(paths.marker, `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
    });
    return { status: "migrated", ...result };
  } finally {
    await release();
  }
}

export function formatMigrationResult(result) {
  switch (result.status) {
    case "no-legacy-state":
      return "No legacy .pi/herdr-orchestrator state; nothing to migrate.";
    case "already-migrated":
      return result.legacyWrittenAfterMigration
        ? `State was migrated to ${result.currentDirectory}, but ${result.legacyDirectory} changed afterwards. Something still runs an old Baa-ton against it; stop it and compare before continuing.`
        : `State already migrated to ${result.currentDirectory}; ${result.legacyDirectory} is kept as an archive.`;
    default: {
      const lines = [
        `Migrated orchestrator state to ${result.migratedTo} (${result.copiedFiles} files, ${result.rewrittenFiles} with rewritten paths). The legacy directory is kept as an archive.`,
      ];
      if (result.keptExisting.length)
        lines.push(`Kept ${result.keptExisting.length} file(s) already present in the new directory.`);
      if (result.controllerConfigDirectory)
        lines.push(
          result.controllerFiles.length
            ? `Rewrote controller state: ${result.controllerFiles.join(", ")} (originals saved with a .pre-baa-ton-migration suffix).`
            : "Controller state had no legacy paths for this project.",
        );
      else
        lines.push(
          "Controller config was not rewritten (Herdr plugin config directory unavailable). Rerun inside Herdr, or re-bootstrap the root before dispatching.",
        );
      return lines.join("\n");
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  if (args.includes("--help")) {
    console.log(
      "Usage: node state-migration.mjs [--project-root <dir>] [--controller-config-dir <dir>] [--status]",
    );
  } else {
    const projectRoot = option("--project-root") ?? process.cwd();
    const run = args.includes("--status")
      ? legacyStateStatus(projectRoot).then((status) => JSON.stringify(status, null, 2))
      : migrateProjectState({
          projectRoot,
          controllerConfigDirectory: option("--controller-config-dir"),
        }).then(formatMigrationResult);
    run.then(console.log, (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
