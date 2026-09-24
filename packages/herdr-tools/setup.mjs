#!/usr/bin/env node
/**
 * Backward/automation-compatible CLI entry point for Baa-ton project setup.
 *
 * The interactive wizard now lives in install-tui.mjs (built on pi-tui). This
 * file stays as a thin re-export of setup-core.mjs's primitives (so existing
 * imports keep working) plus a CLI shim that delegates argument parsing and
 * behavior to install-tui.mjs with identical flags. Scripts/automation should
 * keep calling this file; humans should prefer install-tui.mjs directly.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export {
  HARNESSES,
  detectCommand,
  detectHarnesses,
  managedReferenceBlock,
  portableBaaReference,
  updateManagedReference,
  projectSkillPath,
  startSkillPath,
  configureSkillPath,
  updateSkillPath,
  uninstallSkillPath,
  sweepSkillPath,
  startSkillContent,
  configureSkillContent,
  updateSkillContent,
  uninstallSkillContent,
  sweepSkillContent,
  installProjectSkills,
  ensureProjectBaa,
  instructionCandidates,
  buildSetupConfig,
  writeJsonAtomic,
  readJson,
} from "./setup-core.mjs";

const toolsDirectory = dirname(fileURLToPath(import.meta.url));

export function usage() {
  return `Usage: node ${join(toolsDirectory, "setup.mjs")} [options]

Options:
  --project-root <dir>       Project directory for .baa-ton/config.json (default: cwd)
  --prompt-project           Ask for the project directory (default: the supplied project root)
  --instructions-path <file> Add/update the managed BAA.md reference in this file
  --harness <name>           Select a harness (repeatable: pi, claude, codex, opencode)
  --non-interactive          Use detected harnesses without opening the interactive wizard
  --quiet                    Print only errors (for installer use)
  --help                     Show this help

This is the CLI-compatible entry point for scripts/automation; it delegates
to install-tui.mjs, which owns the interactive wizard (harness detection and
confirmation, per-profile model/thinking configuration, and the summary/write
step). The wizard never claims that an exact model/profile is qualified.
Run it from the target Herdr pane when configuring a root harness.`;
}

async function main() {
  const { runInstallTui } = await import("./install-tui.mjs");
  await runInstallTui(process.argv.slice(2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    console.error(`baa-ton setup: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exitCode = 2;
  });
