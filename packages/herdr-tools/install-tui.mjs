#!/usr/bin/env node
/**
 * Interactive Baa-ton project wizard, built on @earendil-works/pi-tui.
 *
 * Layout: a persistent banner + "Step n/5 - <title>" header, a body region
 * that swaps per step, and a footer hint line. Steps: project directory,
 * harness selection, detection results (read-only), profile configuration
 * (harness/model/thinking per task profile), and a summary/confirm step.
 * Nothing is written until step 5's explicit confirm.
 *
 * `setup.mjs` delegates here for CLI-compatible automation use; this file is
 * the interactive entry point humans should run directly.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Container,
  Input,
  Key,
  matchesKey,
  SelectList,
  SettingsList,
  Text,
  truncateToWidth,
  TuiAltScreen,
  ProcessTerminal,
} from "@earendil-works/pi-tui";

import {
  HARNESSES,
  detectHarnesses,
  loadDefaults,
  ensureProjectBaa,
  instructionCandidates,
  installProjectSkills,
  updateManagedReference,
  buildSetupConfig,
  writeJsonAtomic,
  readJson,
  checkoutDirectory,
  mergeDetectedProfiles,
  missingOptionalConfigSections,
} from "./setup-core.mjs";
import { readClaudeDefaults, readCodexDefaults, readPiDefaults, readOpencodeDefaults } from "./harness-detect.mjs";
import { liveHerdrConfigDirectory } from "./live-herdr.mjs";
import { formatMigrationResult, migrateProjectState } from "./state-migration.mjs";
import { buildProfileTemplates, defaultLaunchProfiles } from "./profile-defaults.mjs";
import { bannerLines, bannerText } from "./banner.mjs";
import { bold, brightCyan, brightGreen, brightMagenta, dim, gray, green, yellow } from "./theme.mjs";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const STEP_TITLES = [
  "Project directory",
  "Harness selection",
  "Detection results",
  "Profile configuration",
  "Summary and confirm",
];
const DIVIDER = "─".repeat(70);
// Resolved value for a step's promise when the user asked to go back
// (Shift+Tab, or PageUp if the terminal sends it) instead of completing
// that step normally.
const BACK = Symbol("wizard-back");

const SETTINGS_THEME = {
  label: (text, selected) => (selected ? bold(brightCyan(text)) : text),
  value: (text, selected) => {
    if (text === "unconfigured") return gray(text);
    return selected ? bold(green(text)) : green(text);
  },
  description: (text) => dim(text),
  cursor: brightCyan(">"),
  hint: (text) => dim(text),
};

const SELECT_THEME = {
  selectedPrefix: (text) => brightCyan(text),
  selectedText: (text) => bold(brightCyan(text)),
  description: (text) => dim(text),
  scrollInfo: (text) => dim(text),
  noMatch: (text) => dim(text),
};

export function usage() {
  return `Usage: node install-tui.mjs [options]

Options:
  --project-root <dir>       Project directory for .baa-ton/config.json (default: cwd)
  --prompt-project           Ask for the project directory (default: the supplied project root)
  --instructions-path <file> Add/update the managed BAA.md reference in this file
  --harness <name>           Select a harness (repeatable: pi, claude, codex, opencode)
  --non-interactive          Use detected harnesses and computed profile defaults, no wizard
  --accept-defaults          Run the interactive wizard but skip profile editing (step 4)
  --config-only              Skip straight to profile configuration for an installed project
  --quiet                    Print only errors (for installer use)
  --help                     Show this help

The wizard detects installed harnesses, lets you confirm them, shows what each
harness's default model/thinking detection actually found, lets you configure
an exact provider/model/thinking value per task profile, and never claims that
an exact model/profile is qualified until Baa-ton live-qualifies it at dispatch.
Run it from the target Herdr pane when configuring a root harness.`;
}

function parseArgs(args) {
  const options = {
    projectRoot: process.cwd(),
    promptProject: false,
    instructionPaths: [],
    harnesses: [],
    nonInteractive: false,
    quiet: false,
    acceptDefaults: false,
    configOnly: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--non-interactive") options.nonInteractive = true;
    else if (arg === "--prompt-project") options.promptProject = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--accept-defaults") options.acceptDefaults = true;
    else if (arg === "--config-only") options.configOnly = true;
    else if (arg === "--project-root") options.projectRoot = resolve(args[++index] ?? "");
    else if (arg === "--instructions-path") options.instructionPaths.push(resolve(args[++index] ?? ""));
    else if (arg === "--harness") options.harnesses.push(args[++index] ?? "");
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function projectDirectoryIsUsable(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function expandHome(path) {
  return path.replace(/^~(?=$|[\\/])/, homedir());
}

function selectedHarnessIds(options, detected) {
  const known = new Set(HARNESSES.map((harness) => harness.id));
  for (const harness of options.harnesses)
    if (!known.has(harness)) throw new Error(`Unknown harness ${JSON.stringify(harness)}.`);
  if (options.harnesses.length) return [...new Set(options.harnesses)];
  return detected.filter((harness) => harness.detected).map((harness) => harness.id);
}

async function detectSelectedHarnesses(selected, projectRoot) {
  const results = {};
  if (selected.includes("claude")) results.claude = readClaudeDefaults();
  if (selected.includes("codex")) results.codex = readCodexDefaults();
  if (selected.includes("opencode")) results.opencode = readOpencodeDefaults();
  if (selected.includes("pi")) results.pi = await readPiDefaults({ projectRoot });
  return results;
}

function unconfiguredProfiles(defaults, computed) {
  return Object.keys(defaults.profiles).filter((name) => !computed[name]);
}

/**
 * Writes the config: BAA.md, managed instruction references, project skills,
 * then the .baa-ton/config.json with per-profile agentKind/launchProfile.
 * Delegates every side effect to setup-core.mjs; never reimplements it here.
 */
function performWrites({ projectRoot, detected, selected, instructionFiles, defaults, resolvedProfiles }) {
  const installedBaaPath = resolve(process.env.BAA_TON_BAA_PATH ?? join(checkoutDirectory, "BAA.md"));
  const baaPath = ensureProjectBaa(projectRoot, installedBaaPath);
  for (const path of instructionFiles) updateManagedReference(path, baaPath);
  const skills = installProjectSkills({ projectRoot, selected, baaPath });
  const configPath = join(projectRoot, ".baa-ton", "config.json");
  const config = buildSetupConfig({
    projectRoot,
    baaPath,
    detected,
    selected,
    instructionFiles,
    defaults,
    skills: skills.map((skill) => skill.path),
  });
  for (const [name, resolved] of Object.entries(resolvedProfiles)) {
    config.profiles[name] = { ...config.profiles[name], agentKind: resolved.agentKind, launchProfile: resolved.launchProfile };
  }
  writeJsonAtomic(configPath, config);
  return { baaPath, skills, configPath, config };
}

/**
 * Carry orchestrator state from .pi/herdr-orchestrator to .baa-ton (see
 * state-migration.mjs). Setup is where an update lands, so this runs after the
 * writes. Without a reachable Herdr the project state still moves and the
 * result says the controller mappings were left alone.
 */
async function migrateLegacyState(projectRoot, { quiet }) {
  let controllerConfigDirectory;
  try {
    controllerConfigDirectory = await liveHerdrConfigDirectory();
  } catch {
    controllerConfigDirectory = undefined;
  }
  const result = await migrateProjectState({ projectRoot, controllerConfigDirectory });
  const noteworthy = result.status === "migrated" || result.legacyWrittenAfterMigration;
  if (result.status !== "no-legacy-state" && (noteworthy || !quiet))
    console.log(formatMigrationResult(result));
  return result;
}

// ---------------------------------------------------------------------------
// Non-interactive / accept-defaults path (also used by the TTY guard)
// ---------------------------------------------------------------------------

async function runNonInteractive(options) {
  const defaults = loadDefaults();
  const projectRoot = resolve(options.projectRoot);
  if (!isAbsolute(projectRoot)) throw new Error("--project-root must resolve to an absolute path.");

  if (options.configOnly) {
    const configPath = join(projectRoot, ".baa-ton", "config.json");
    const config = readJson(configPath, undefined);
    if (!config) throw new Error(`--config-only requires an existing ${configPath}; run the full wizard first.`);
    const selected = config.selectedHarnesses ?? [];
    const detectionResults = await detectSelectedHarnesses(selected, projectRoot);
    const computed = defaultLaunchProfiles(selected, detectionResults, defaults.profiles);
    const { configPath: writtenPath, profileChanges } = performConfigOnlyWriteDirect({ projectRoot, resolvedProfiles: computed, existingConfig: config, preserveExisting: true });
    reportProfileChanges(profileChanges);
    if (!options.quiet) {
      console.log(`Baa-ton profile defaults refreshed at ${writtenPath}`);
      reportUnconfigured(defaults, computed);
    }
    await migrateLegacyState(projectRoot, options);
    return;
  }

  const detected = detectHarnesses();
  const selected = selectedHarnessIds(options, detected);
  const installedBaaPath = resolve(process.env.BAA_TON_BAA_PATH ?? join(checkoutDirectory, "BAA.md"));
  const baaPath = ensureProjectBaa(projectRoot, installedBaaPath);
  const instructionFiles = options.instructionPaths.length ? options.instructionPaths : instructionCandidates(projectRoot, selected);
  for (const path of instructionFiles) updateManagedReference(path, baaPath);
  const skills = installProjectSkills({ projectRoot, selected, baaPath });
  const detectionResults = await detectSelectedHarnesses(selected, projectRoot);
  const computed = defaultLaunchProfiles(selected, detectionResults, defaults.profiles);
  const configPath = join(projectRoot, ".baa-ton", "config.json");
  const config = buildSetupConfig({
    projectRoot,
    baaPath,
    detected,
    selected,
    instructionFiles,
    defaults,
    skills: skills.map((skill) => skill.path),
  });
  // Unattended setup (also the update path) never replaces a project's own
  // profile choices; it only fills profiles that have none.
  const profileChanges = mergeDetectedProfiles(config, computed);
  writeJsonAtomic(configPath, config);
  reportProfileChanges(profileChanges);
  reportOptionalSections(config);

  if (options.quiet) {
    console.log(`Project ready at ${projectRoot}. Configure worker profiles and model choices in ${configPath}.`);
  } else {
    console.log(`Baa-ton setup recorded at ${configPath}`);
    console.log(`Project contract: ${baaPath}`);
    console.log(`Selected harnesses: ${selected.length ? selected.join(", ") : "none"}`);
    if (instructionFiles.length) console.log(`Updated BAA.md references: ${instructionFiles.join(", ")}`);
    else console.log("No AGENTS.md or CLAUDE.md selected; pass --instructions-path to add the managed reference.");
    if (skills.length) {
      const installed = skills.filter((skill) => !skill.skipped).map((skill) => skill.path);
      const skipped = skills.filter((skill) => skill.skipped).map((skill) => skill.path);
      if (installed.length) console.log(`Installed Baa-ton skills: ${installed.join(", ")}`);
      if (skipped.length) console.log(`Preserved existing skill files: ${skipped.join(", ")}`);
    }
    console.log("\nTask profiles:");
    for (const [name, profile] of Object.entries(defaults.profiles)) {
      // Report what is configured now: a kept choice or a filled default.
      const resolved = config.profiles?.[name]?.launchProfile ? config.profiles[name] : computed[name];
      const suffix = resolved?.launchProfile ? ` -> ${resolved.agentKind ?? "?"}/${resolved.launchProfile.model} (${resolved.launchProfile.thinking})` : " -> unconfigured";
      console.log(`  ${name}: ${profile.description}${suffix}`);
    }
    reportUnconfigured(
      defaults,
      Object.fromEntries(Object.entries(config.profiles ?? {}).filter(([, value]) => value?.launchProfile)),
    );
    console.log(`Run from the target Herdr pane for root setup: node ${join(checkoutDirectory, "packages/herdr-tools/root-setup.mjs")} --harness <name>`);
  }
  await migrateLegacyState(projectRoot, options);
  // install.sh/install.ps1 no longer render their own banner; this keeps it
  // always shown at the end of the non-interactive installer path too,
  // matching the old unconditional welcome()/Welcome call.
  console.log(`\n${bannerText()}`);
}

function performConfigOnlyWriteDirect({ projectRoot, resolvedProfiles, existingConfig, preserveExisting = false }) {
  const configPath = join(projectRoot, ".baa-ton", "config.json");
  const config = { ...existingConfig, profiles: { ...existingConfig.profiles } };
  let profileChanges;
  if (preserveExisting) profileChanges = mergeDetectedProfiles(config, resolvedProfiles);
  else
    // Interactive edits: these are the user's explicit picks.
    for (const [name, resolved] of Object.entries(resolvedProfiles))
      config.profiles[name] = { ...config.profiles[name], agentKind: resolved.agentKind, launchProfile: resolved.launchProfile };
  writeJsonAtomic(configPath, config);
  return { configPath, config, profileChanges };
}

function reportProfileChanges(changes) {
  if (!changes) return;
  if (changes.preserved.length) console.log(`Kept existing profile choices: ${changes.preserved.join(", ")}`);
  if (changes.filled.length) console.log(`Filled missing profiles from detected defaults: ${changes.filled.join(", ")}`);
}

function reportOptionalSections(config) {
  const missing = missingOptionalConfigSections(config);
  if (!missing.length) return;
  console.log("Optional .baa-ton/config.json sections not configured (nothing is enabled automatically):");
  for (const section of missing) console.log(`  ${section.summary}`);
}

function reportUnconfigured(defaults, computed) {
  const remaining = unconfiguredProfiles(defaults, computed);
  if (remaining.length)
    console.log(`\nProfiles left unconfigured (no usable detection for any selected harness): ${remaining.join(", ")}. Dispatch fails closed for these until configured.`);
  console.log("\nExact provider/model/thinking/auth values remain user configuration and are live-qualified at dispatch.");
}

// ---------------------------------------------------------------------------
// Interactive wizard
// ---------------------------------------------------------------------------

class Checklist {
  constructor(tui, items) {
    this.tui = tui;
    this.items = items;
    this.cursor = 0;
    this.selected = new Set(items.filter((item) => item.checked).map((item) => item.id));
    this.onDone = undefined;
    this.onCancel = undefined;
  }

  handleInput(data) {
    if (matchesKey(data, Key.up)) this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, Key.down)) this.cursor = Math.min(this.items.length - 1, this.cursor + 1);
    else if (matchesKey(data, Key.space)) {
      const id = this.items[this.cursor].id;
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
    } else if (matchesKey(data, Key.enter)) {
      this.onDone?.([...this.selected]);
      return;
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
      return;
    } else return;
    this.tui.requestRender();
  }

  render(width) {
    const lines = this.items.map((item, index) => {
      const checked = this.selected.has(item.id);
      const isCursor = index === this.cursor;
      const pointer = isCursor ? brightCyan(">") : " ";
      const mark = checked ? brightGreen("x") : " ";
      const label = checked ? bold(item.label) : item.label;
      const status = item.detected ? green(`detected: ${item.detected.version}`) : gray("not detected");
      return truncateToWidth(`${pointer} [${mark}] ${label} (${status})`, width);
    });
    lines.push("");
    lines.push(dim(truncateToWidth("space: toggle   enter: confirm   esc/ctrl+c: quit without writing", width)));
    return lines;
  }
}

function formatOption(harnessId, entry) {
  return `${harnessId}/${entry.model} (${entry.thinking})`;
}

/** One colorized "profileName: harness/model (thinking)" line per profile, in defaults.profiles order, with unconfigured ones called out instead of silently omitted. */
function profileSummaryLines(profiles, profileOrder) {
  return profileOrder.map((name) => {
    const resolved = profiles[name];
    if (!resolved) return `  ${gray(`${name}: unconfigured`)}`;
    return `  ${bold(name)}: ${brightCyan(resolved.agentKind)}/${green(resolved.launchProfile.model)} (${yellow(resolved.launchProfile.thinking)})`;
  });
}

function availableModelsForHarness(detection) {
  if (!detection) return [];
  if (detection.catalog?.length) return detection.catalog;
  if (detection.defaultModel) return [{ id: detection.defaultModel, label: detection.defaultModel, thinkingLevels: undefined }];
  return [];
}

/**
 * A single SettingsList submenu Component that drills down harness -> model
 * -> thinking level, each stage filtered by the previous choice, instead of
 * cycling through one flat list of every combination. Escape steps back one
 * stage; Escape at the harness stage cancels the whole submenu (SettingsList's
 * own done() semantics: called with no argument, it leaves the row unchanged).
 */
class ProfilePicker {
  constructor({ selectedHarnessIds, detectionResults, harnessToProvider, done }) {
    this.detectionResults = detectionResults;
    this.harnessToProvider = harnessToProvider;
    this.done = done;
    this.harnessIds = selectedHarnessIds.filter((id) => availableModelsForHarness(detectionResults[id]).length > 0);
    this.chosenHarness = undefined;
    this.chosenModel = undefined;
    this.current = this.buildHarnessStage();
  }

  buildHarnessStage() {
    this.chosenHarness = undefined;
    this.chosenModel = undefined;
    const items = [
      { value: "__unconfigured__", label: "Unconfigured", description: "fails closed at dispatch -- never invents a value" },
      ...this.harnessIds.map((id) => {
        const count = availableModelsForHarness(this.detectionResults[id]).length;
        return { value: id, label: id, description: `${count} model(s) available` };
      }),
    ];
    const list = new SelectList(items, Math.min(items.length, 8), SELECT_THEME);
    list.onSelect = (item) => {
      if (item.value === "__unconfigured__") {
        this.done("unconfigured");
        return;
      }
      this.chosenHarness = item.value;
      this.current = this.buildModelStage();
    };
    list.onCancel = () => this.done();
    return list;
  }

  buildModelStage() {
    this.chosenModel = undefined;
    const models = availableModelsForHarness(this.detectionResults[this.chosenHarness]);
    const items = models.map((entry) => ({ value: entry.id, label: entry.label ?? entry.id }));
    const list = new SelectList(items, Math.min(Math.max(items.length, 1), 8), SELECT_THEME);
    list.onSelect = (item) => {
      this.chosenModel = models.find((entry) => entry.id === item.value);
      this.current = this.buildThinkingStage();
    };
    list.onCancel = () => {
      this.current = this.buildHarnessStage();
    };
    return list;
  }

  buildThinkingStage() {
    const levels = this.chosenModel.thinkingLevels?.length ? this.chosenModel.thinkingLevels : THINKING_LEVELS;
    const items = levels.map((level) => ({ value: level, label: level }));
    const list = new SelectList(items, Math.min(items.length, 8), SELECT_THEME);
    list.onSelect = (item) => {
      this.done(formatOption(this.chosenHarness, { model: this.chosenModel.id, thinking: item.value }));
    };
    list.onCancel = () => {
      this.current = this.buildModelStage();
    };
    return list;
  }

  render(width) {
    const provider = this.chosenHarness ? this.harnessToProvider[this.chosenHarness] : undefined;
    const breadcrumb = [this.chosenHarness, provider, this.chosenModel?.id].filter(Boolean).join(bold(" -> "));
    const title = breadcrumb ? `${bold("Choose:")} ${breadcrumb} -> ?` : bold("Choose a harness:");
    return [title, "", ...this.current.render(width), "", dim("esc: back a step, or cancel from the harness list")];
  }

  handleInput(data) {
    this.current.handleInput(data);
  }

  invalidate() {
    this.current.invalidate();
  }
}

function parseOption(value, harnessToProvider) {
  const match = value.match(/^([\w-]+)\/(.+) \(([\w-]+)\)$/);
  if (!match) return undefined;
  const [, harnessId, model, thinking] = match;
  const provider = harnessToProvider[harnessId];
  if (!provider) return undefined;
  return { agentKind: harnessId, launchProfile: { provider, model, thinking, auth: "subscription" } };
}

async function runWizard(options) {
  const isRealTty = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  if (!isRealTty || options.nonInteractive) return runNonInteractive(options);

  const terminal = new ProcessTerminal();
  // Alternate screen: takes over the terminal fully and restores whatever
  // was on screen before (including scrollback from earlier commands) on
  // exit, instead of TuiMainScreen's "render inline, keep history" mode.
  const tui = new TuiAltScreen(terminal);
  const header = new Container();
  const body = new Container();
  const footer = new Text("");
  for (const line of bannerLines()) header.addChild(new Text(line, 0, 0));
  const stepLine = new Text("");
  header.addChild(stepLine);
  // Plain-text dividers give the header/body/footer regions clear visual
  // separation without relying on a Box background color (which could
  // clash with the terminal's own light/dark theme).
  header.addChild(new Text(gray(DIVIDER), 0, 0));
  tui.addChild(header);
  tui.addChild(body);
  tui.addChild(new Text(gray(DIVIDER), 0, 0));
  tui.addChild(footer);

  let aborted = false;
  const abort = () => {
    aborted = true;
    tui.stop();
  };
  // Set by whichever step is currently awaiting input, to its own
  // resolvePromise(BACK); cleared once that step settles. Shift+Tab (with
  // PageUp as a fallback for terminals that map it oddly) is intercepted
  // globally (consume: true) so it works the same regardless of which
  // component -- Input, Checklist, SelectList, SettingsList, ProfilePicker
  // -- currently has focus, without teaching each of them about wizard
  // navigation individually.
  let requestBack = null;
  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      abort();
      return undefined;
    }
    if ((matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.pageUp)) && requestBack) {
      requestBack();
      return { consume: true };
    }
    return undefined;
  });

  function setStep(index, hint) {
    stepLine.setText(bold(brightMagenta(`Step ${index}/5 - ${STEP_TITLES[index - 1]}`)));
    footer.setText(hint ? dim(hint) : "");
    tui.requestRender();
  }

  function swapBody(component) {
    for (const child of [...(body.children ?? [])]) body.removeChild(child);
    body.addChild(component);
    tui.setFocus(component);
    tui.requestRender();
  }

  const defaults = loadDefaults();
  const defaultProjectRoot = resolve(options.projectRoot);
  if (!isAbsolute(defaultProjectRoot)) throw new Error("--project-root must resolve to an absolute path.");

  let projectRoot = defaultProjectRoot;
  let selected;
  let detectionResults = {};
  let resolvedProfiles = {};
  let existingConfig;
  const harnessToProvider = Object.fromEntries(HARNESSES.map((h) => [h.id, { claude: "claude-code", codex: "codex", pi: "pi", opencode: "opencode" }[h.id]]));

  try {
    tui.start();

    // Shift+Tab steps back one phase; state from every prior phase (project
    // root, harness selection, in-progress profile edits) is preserved and
    // re-shown, not reset, when a phase is re-entered this way.
    const canGoBackToProject = !options.configOnly && options.promptProject;
    let phase = options.configOnly ? "load-existing-config" : canGoBackToProject ? "project" : "harness";
    let workingProfiles;

    while (phase !== "done") {
      if (phase === "load-existing-config") {
        const configPath = join(projectRoot, ".baa-ton", "config.json");
        existingConfig = readJson(configPath, undefined);
        if (!existingConfig) throw new Error(`--config-only requires an existing ${configPath}; run the full wizard first.`);
        selected = existingConfig.selectedHarnesses ?? [];
        phase = "detection-results";
        continue;
      }

      if (phase === "project") {
        const result = await new Promise((resolvePromise) => {
          setStep(1, "Enter to accept, Esc/Ctrl+C to quit without writing");
          const input = new Input();
          input.setValue(projectRoot);
          // setValue clamps the cursor to the new value's length rather than
          // moving it there; on a fresh Input the cursor starts at 0, so a
          // prefilled value would otherwise leave the cursor stuck at the
          // beginning. Match the library's own Home/End convention.
          input.cursor = projectRoot.length;
          input.onSubmit = (value) => {
            const candidate = resolve(expandHome((value ?? "").trim() || defaultProjectRoot));
            if (!projectDirectoryIsUsable(candidate)) {
              footer.setText(yellow(`Not a directory: ${candidate}`));
              tui.requestRender();
              return;
            }
            resolvePromise(candidate);
          };
          swapBody(input);
        });
        if (aborted) return { aborted };
        projectRoot = result;
        phase = "harness";
        continue;
      }

      if (phase === "harness") {
        const detected = detectHarnesses();
        const result = await new Promise((resolvePromise) => {
          // Checklist renders its own "space: toggle ... quit without
          // writing" hint at the bottom of its own body; no footer hint
          // here or it's shown twice. Back navigation only offered once
          // there's actually an earlier phase to return to.
          setStep(2, canGoBackToProject ? "Shift+Tab: back to project directory" : undefined);
          const items = detected.map((harness) => ({
            id: harness.id,
            label: harness.label,
            detected: harness.detected,
            checked: selected ? selected.includes(harness.id) : Boolean(harness.detected),
          }));
          const checklist = new Checklist(tui, items);
          checklist.onDone = (ids) => resolvePromise(ids);
          checklist.onCancel = () => { abort(); resolvePromise([]); };
          swapBody(checklist);
          if (canGoBackToProject) requestBack = () => resolvePromise(BACK);
        });
        requestBack = null;
        if (aborted) return { aborted };
        if (result === BACK) { phase = "project"; continue; }
        selected = result;
        phase = "detection-results";
        continue;
      }

      if (phase === "detection-results") {
        // detectSelectedHarnesses shells out synchronously (execFileSync)
        // per harness -- it genuinely blocks the event loop, so a spinner
        // couldn't animate here even if we tried. Force an immediate paint
        // of a loading message *before* that blocking work starts, or the
        // last-drawn frame (the harness checklist) just sits there looking
        // hung until it's done.
        setStep(3, "Detecting each selected harness's configured model...");
        swapBody(new Text(dim("Running codex debug models, reading harness config files, etc. -- this can take a few seconds.")));
        tui.renderNow(true);
        detectionResults = await detectSelectedHarnesses(selected, projectRoot);

        if (options.configOnly) { phase = "profile-edit"; continue; }

        const result = await new Promise((resolvePromise) => {
          setStep(3, "Enter to continue, Shift+Tab: back to harness selection, esc/ctrl+c to quit without writing");
          const summary = new Container();
          summary.addChild(new Text(bold("What Baa-ton found for each selected harness:"), 0, 0));
          for (const harnessId of selected) {
            const detection = detectionResults[harnessId];
            const catalogIds = detection?.catalog?.map((entry) => entry.id) ?? [];
            const lines = [
              `${bold(brightCyan(harnessId))}: source=${detection?.source ?? "n/a"}, default=${green(detection?.defaultModel ?? "(none)")}, thinking=${green(detection?.defaultThinking ?? "(none)")}`,
              catalogIds.length
                ? dim(`  ${catalogIds.length} model(s) available: ${catalogIds.join(", ")}`)
                : gray("  no model catalog detected; only the default above will be offered"),
              ...((detection?.warnings ?? []).map((warning) => yellow(`  note: ${warning}`))),
            ];
            summary.addChild(new Text(lines.join("\n"), 0, 0));
          }
          const proceed = new Input({ placeholder: "Press Enter to continue", placeholderStyle: dim });
          proceed.onSubmit = () => resolvePromise();
          summary.addChild(proceed);
          swapBody(summary);
          tui.setFocus(proceed);
          requestBack = () => resolvePromise(BACK);
        });
        requestBack = null;
        if (aborted) return { aborted };
        if (result === BACK) { phase = "harness"; continue; }
        if (options.acceptDefaults) {
          resolvedProfiles = defaultLaunchProfiles(selected, detectionResults, defaults.profiles);
          workingProfiles = resolvedProfiles;
          phase = "confirm";
          continue;
        }
        phase = "template";
        continue;
      }

      const computedDefaults = defaultLaunchProfiles(selected, detectionResults, defaults.profiles);
      if (!workingProfiles) workingProfiles = computedDefaults;

      if (phase === "template") {
        const templates = buildProfileTemplates(selected, detectionResults, defaults.profiles);
        const profileCount = Object.keys(defaults.profiles).length;
        if (templates.length === 0) { phase = "profile-edit"; continue; }

        const profileOrder = Object.keys(defaults.profiles);
        const profilesForValue = (value) => templates.find((template) => template.id === value)?.profiles ?? computedDefaults;
        const previewFor = (value) => [dim("Preview of this starting point:"), ...profileSummaryLines(profilesForValue(value), profileOrder)].join("\n");

        const result = await new Promise((resolvePromise) => {
          setStep(4, "Pick a starting point -- Shift+Tab: back to detection results");
          const items = templates.map((template) => ({
            value: template.id,
            label: template.label,
            description: `${Object.keys(template.profiles).length}/${profileCount} profile(s) configured`,
          }));
          items.push({ value: "__custom__", label: "Start from current defaults", description: "configure every profile individually, no template applied" });
          const list = new SelectList(items, Math.min(items.length, 8), SELECT_THEME);
          // SelectList's own `description` is a single truncated line squeezed
          // onto each row -- not enough room for a real per-profile
          // breakdown. This preview panel updates on every highlight change
          // (onSelectionChange, arrow keys or mouse hover-click) instead.
          const preview = new Text(previewFor(items[0].value));
          list.onSelectionChange = (item) => preview.setText(previewFor(item.value));
          list.onSelect = (item) => resolvePromise(profilesForValue(item.value));
          list.onCancel = () => { abort(); resolvePromise(computedDefaults); };
          const container = new Container();
          container.addChild(list);
          container.addChild(new Text(""));
          container.addChild(preview);
          swapBody(container);
          tui.setFocus(list);
          requestBack = () => resolvePromise(BACK);
        });
        requestBack = null;
        if (aborted) return { aborted };
        if (result === BACK) { phase = "detection-results"; continue; }
        workingProfiles = result;
        phase = "profile-edit";
        continue;
      }

      if (phase === "profile-edit") {
        const result = await new Promise((resolvePromise) => {
          // SettingsList renders its own "Enter/Space to change · Esc to
          // cancel" hint at the bottom of its own body; no footer hint here
          // or it's shown twice, but back navigation still needs its own
          // hint since SettingsList doesn't know about it.
          setStep(4, options.configOnly ? undefined : "Shift+Tab: back to starting-point templates");
          const working = { ...workingProfiles };
          const items = Object.entries(defaults.profiles).map(([name, profile]) => {
            const current = working[name];
            const currentValue = current ? formatOption(current.agentKind, current.launchProfile) : "unconfigured";
            return {
              id: name,
              label: name,
              // SettingsList shows this only for the currently-highlighted
              // row -- what the profile is for, and that Enter opens the
              // picker to change it. The current value already has its own
              // column; repeating it here would go stale the moment it
              // changes, since this string isn't rebuilt on every edit.
              description: `${profile.description} Press Enter to change harness, model, or thinking level.`,
              currentValue,
              submenu: (_currentValue, done) =>
                new ProfilePicker({
                  selectedHarnessIds: selected,
                  detectionResults,
                  harnessToProvider,
                  done,
                }),
            };
          });
          // Escape is SettingsList's documented "cancel" key; here it means
          // "finish editing this step" (proceed to the summary), not abort.
          // A full abort is still available globally via the Ctrl+C listener.
          const settings = new SettingsList(
            items,
            items.length,
            SETTINGS_THEME,
            (id, newValue) => {
              if (newValue === "unconfigured") {
                delete working[id];
                return;
              }
              const parsed = parseOption(newValue, harnessToProvider);
              if (parsed) working[id] = parsed;
            },
            () => resolvePromise(working),
          );
          swapBody(settings);
          if (!options.configOnly) requestBack = () => resolvePromise(BACK);
        });
        requestBack = null;
        if (aborted) return { aborted };
        if (result === BACK) { phase = "template"; continue; }
        workingProfiles = result;
        resolvedProfiles = result;
        phase = "confirm";
        continue;
      }

      // phase === "confirm"
      const summaryLines = profileSummaryLines(resolvedProfiles, Object.keys(defaults.profiles));
      const missing = unconfiguredProfiles(defaults, resolvedProfiles);
      const canGoBackToProfileEdit = !options.configOnly && !options.acceptDefaults;
      const confirmResult = await new Promise((resolvePromise) => {
        setStep(5, canGoBackToProfileEdit ? "Shift+Tab: back to profile configuration" : undefined);
        const text = new Text(
          [
            `${bold("Project:")} ${projectRoot}`,
            `${bold("Selected harnesses:")} ${selected.join(", ") || "none"}`,
            "",
            bold("Profiles:"),
            ...summaryLines,
            missing.length
              ? yellow(`Unconfigured (fails closed at dispatch): ${missing.join(", ")}`)
              : brightGreen("All profiles configured."),
            "",
          ].join("\n"),
          0,
          0,
        );
        const choices = new SelectList(
          [
            { value: "write", label: "Write configuration" },
            { value: "quit", label: "Quit without writing" },
          ],
          2,
          SELECT_THEME,
        );
        choices.onSelect = (item) => {
          if (item.value === "write") resolvePromise(true);
          else { abort(); resolvePromise(false); }
        };
        choices.onCancel = () => { abort(); resolvePromise(false); };
        const container = new Container();
        container.addChild(text);
        container.addChild(choices);
        swapBody(container);
        tui.setFocus(choices);
        if (canGoBackToProfileEdit) requestBack = () => resolvePromise(BACK);
      });
      requestBack = null;
      if (aborted) return { aborted };
      if (confirmResult === BACK) { phase = "profile-edit"; continue; }
      if (!confirmResult) return { aborted: true };
      phase = "done";
    }

    let writeResult;
    if (options.configOnly) {
      writeResult = performConfigOnlyWriteDirect({ projectRoot, resolvedProfiles, existingConfig });
    } else {
      const detected = detectHarnesses();
      const instructionFiles = options.instructionPaths.length ? options.instructionPaths : instructionCandidates(projectRoot, selected);
      writeResult = performWrites({ projectRoot, detected, selected, instructionFiles, defaults, resolvedProfiles });
    }
    tui.stop();
    if (!options.quiet) console.log(`Baa-ton configuration written to ${writeResult.configPath}`);
    await migrateLegacyState(projectRoot, options);
    return { aborted: false };
  } finally {
    tui.stop();
  }
}

export async function runInstallTui(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const isRealTty = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  if (!isRealTty || options.nonInteractive) {
    await runNonInteractive(options);
    return;
  }
  const result = await runWizard(options);
  if (result?.aborted) {
    // 130 (128 + SIGINT) so the wrapper scripts can tell "user cancelled,
    // nothing was written" apart from a real failure and not throw on it.
    if (!options.quiet) console.log("Setup cancelled; nothing was written.");
    process.exitCode = 130;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runInstallTui(process.argv.slice(2)).catch((error) => {
    console.error(`baa-ton install-tui: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exitCode = 2;
  });
}
