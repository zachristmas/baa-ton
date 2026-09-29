import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readClaudeDefaults,
  readCodexDefaults,
  readOpencodeDefaults,
  readPiDefaults,
} from "../harness-detect.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

function throwingExec() {
  throw new Error("command not found");
}

test("readClaudeDefaults resolves an alias to a concrete model via settings.json", () => {
  const result = readClaudeDefaults({ settingsPath: join(fixtures, "claude-settings.json") });
  assert.equal(result.defaultModel, "claude-sonnet-5-5");
  assert.equal(result.defaultThinking, "high");
  assert.equal(result.source, "file");
  assert.ok(result.catalog.length > 0);
  assert.deepEqual(result.warnings, []);
});

test("readClaudeDefaults falls back to static catalog on an unknown alias", () => {
  const result = readClaudeDefaults({ settingsPath: join(fixtures, "claude-settings-unknown-alias.json") });
  assert.equal(result.defaultModel, undefined);
  assert.equal(result.source, "static");
  assert.ok(result.warnings.length > 0);
});

test("readClaudeDefaults never throws when settings.json is missing", () => {
  const result = readClaudeDefaults({ settingsPath: join(fixtures, "does-not-exist.json") });
  assert.equal(result.source, "static");
  assert.ok(result.warnings.length > 0);
});

test("readCodexDefaults reads model + effort from config.toml and falls back to cache when the CLI is unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-home-"));
  try {
    await writeFile(join(directory, "config.toml"), await (await import("node:fs/promises")).readFile(join(fixtures, "config.toml"), "utf8"));
    await writeFile(join(directory, "models_cache.json"), await (await import("node:fs/promises")).readFile(join(fixtures, "models_cache.json"), "utf8"));
    const result = readCodexDefaults({ codexHome: directory, execFileSyncImpl: throwingExec });
    assert.equal(result.defaultModel, "gpt-5.6-terra");
    assert.equal(result.defaultThinking, "high");
    assert.equal(result.source, "file");
    assert.ok(result.catalog.some((entry) => entry.id === "gpt-5.6-sol"));
    assert.ok(result.warnings.some((warning) => warning.includes("cached model list")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readCodexDefaults uses the live CLI catalog when it succeeds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-home-"));
  try {
    await writeFile(join(directory, "config.toml"), 'model = "gpt-5.6-terra"\nmodel_reasoning_effort = "high"\n');
    const liveExec = () => JSON.stringify({ models: [{ slug: "gpt-5.6-live", display_name: "Live", supported_reasoning_levels: [{ effort: "low" }] }] });
    const result = readCodexDefaults({ codexHome: directory, execFileSyncImpl: liveExec });
    assert.equal(result.source, "file"); // file because config.toml resolved defaultModel
    assert.deepEqual(result.catalog, [{ id: "gpt-5.6-live", label: "Live", thinkingLevels: ["low"] }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readCodexDefaults spawns the CLI with shell:true so a Windows .cmd shim doesn't ENOENT", () => {
  const calls = [];
  const recordingExec = (file, args, options) => {
    calls.push({ file, args, options });
    return JSON.stringify({ models: [] });
  };
  readCodexDefaults({ codexHome: join(fixtures, "does-not-exist-dir"), execFileSyncImpl: recordingExec });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.shell, true);
});

test("readCodexDefaults never throws when nothing is available", () => {
  const result = readCodexDefaults({ codexHome: join(fixtures, "does-not-exist-dir"), execFileSyncImpl: throwingExec });
  assert.equal(result.defaultModel, undefined);
  assert.equal(result.source, "static");
  assert.ok(result.warnings.length >= 2);
});

test("readPiDefaults reads defaultModel/defaultThinking from settings.json and falls back to CLI text parsing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-home-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(directory, ".pi", "agent"), { recursive: true });
    await fs.writeFile(
      join(directory, ".pi", "agent", "settings.json"),
      JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-5.6-terra", defaultThinkingLevel: "high" }),
    );
    const liveExec = () => "gpt-5.6-terra  GPT 5.6 Terra\ngpt-5.6-sol    GPT 5.6 Sol\n";
    const result = await readPiDefaults({
      homeDirectory: directory,
      execFileSyncImpl: liveExec,
      importModelRuntime: async () => { throw new Error("sdk not available in test"); },
    });
    assert.equal(result.defaultModel, "gpt-5.6-terra");
    assert.equal(result.defaultThinking, "high");
    assert.equal(result.source, "file");
    assert.ok(result.catalog.some((entry) => entry.id === "gpt-5.6-sol"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readPiDefaults warns but still returns the catalog when defaultProvider is not openai-codex", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-home-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(directory, ".pi", "agent"), { recursive: true });
    await fs.writeFile(
      join(directory, ".pi", "agent", "settings.json"),
      JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-5" }),
    );
    const result = await readPiDefaults({
      homeDirectory: directory,
      execFileSyncImpl: throwingExec,
      importModelRuntime: async () => { throw new Error("sdk not available in test"); },
    });
    assert.equal(result.defaultModel, "claude-sonnet-5");
    assert.ok(result.warnings.some((warning) => warning.includes("not \"openai-codex\"")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readPiDefaults spawns the CLI fallback with shell:true so a Windows .cmd shim doesn't ENOENT", async () => {
  const calls = [];
  const recordingExec = (file, args, options) => {
    calls.push({ file, args, options });
    return "gpt-5.6-terra  GPT 5.6 Terra\n";
  };
  await readPiDefaults({
    homeDirectory: join(fixtures, "does-not-exist-dir"),
    execFileSyncImpl: recordingExec,
    importModelRuntime: async () => { throw new Error("sdk not available in test"); },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.shell, true);
});

test("readPiDefaults never throws when nothing is available", async () => {
  const result = await readPiDefaults({
    homeDirectory: join(fixtures, "does-not-exist-dir"),
    execFileSyncImpl: throwingExec,
    importModelRuntime: async () => { throw new Error("sdk not available"); },
  });
  assert.equal(result.defaultModel, undefined);
  assert.equal(result.source, "static");
  assert.ok(result.warnings.length > 0);
});

test("readOpencodeDefaults prefers a declared model over last-used state", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "opencode-config-"));
  const stateDir = await mkdtemp(join(tmpdir(), "opencode-state-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.copyFile(join(fixtures, "opencode.json"), join(configDir, "opencode.json"));
    const result = readOpencodeDefaults({ configDirectory: configDir, stateDirectory: stateDir, execFileSyncImpl: throwingExec });
    assert.equal(result.defaultModel, "openai/gpt-5.6-luna");
    assert.equal(result.source, "file");
    assert.ok(!result.warnings.some((warning) => warning.includes("undocumented")));
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("readOpencodeDefaults tolerates a // inside a string value (e.g. a $schema URL) and a real line comment", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "opencode-config-"));
  const stateDir = await mkdtemp(join(tmpdir(), "opencode-state-"));
  try {
    const fs = await import("node:fs/promises");
    // Real bug: a naive /\/\/.*$/ regex treats the // in "https://..." as a
    // comment start and deletes the rest of the line, including the closing
    // quote, corrupting the JSON. This fixture has both a genuine // line
    // comment and a $schema URL on the very next line, matching the file
    // that actually broke this in practice.
    await fs.copyFile(join(fixtures, "opencode-with-schema.jsonc"), join(configDir, "opencode.jsonc"));
    const result = readOpencodeDefaults({ configDirectory: configDir, stateDirectory: stateDir, execFileSyncImpl: throwingExec });
    assert.equal(result.defaultModel, "openai/gpt-5.6-luna");
    assert.equal(result.source, "file");
    assert.ok(!result.warnings.some((warning) => warning.includes("Could not read")));
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("readOpencodeDefaults falls back to the most-recent openai/* entry in model.json, with a warning", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "opencode-config-"));
  const stateDir = await mkdtemp(join(tmpdir(), "opencode-state-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.copyFile(join(fixtures, "model.json"), join(stateDir, "model.json"));
    const result = readOpencodeDefaults({ configDirectory: configDir, stateDirectory: stateDir, execFileSyncImpl: throwingExec });
    assert.equal(result.defaultModel, "openai/gpt-5.6-luna");
    assert.equal(result.source, "file");
    assert.ok(result.warnings.some((warning) => warning.includes("undocumented")));
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("readOpencodeDefaults spawns the CLI with shell:true so a Windows .cmd shim (e.g. Volta's opencode.cmd) doesn't ENOENT", () => {
  const calls = [];
  const recordingExec = (file, args, options) => {
    calls.push({ file, args, options });
    return "opencode/big-pickle\n";
  };
  readOpencodeDefaults({
    configDirectory: join(fixtures, "does-not-exist-dir"),
    stateDirectory: join(fixtures, "does-not-exist-dir-2"),
    execFileSyncImpl: recordingExec,
  });
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.options.shell, true);
  assert.deepEqual(calls[0].args, ["models", "--verbose"]);
});

test("readOpencodeDefaults parses cost and reasoning-effort variants from `opencode models --verbose`'s header+JSON-block output", () => {
  const verboseOutput = [
    "opencode/big-pickle",
    JSON.stringify({ id: "big-pickle", providerID: "opencode", name: "Big Pickle", cost: { input: 0, output: 0 }, variants: {} }, null, 2),
    "github-copilot/gpt-5.6-terra",
    JSON.stringify(
      { id: "gpt-5.6-terra", providerID: "github-copilot", name: "GPT 5.6 Terra", cost: { input: 2, output: 12 }, variants: { low: {}, high: {} } },
      null,
      2,
    ),
  ].join("\n");
  const result = readOpencodeDefaults({
    configDirectory: join(fixtures, "does-not-exist-dir"),
    stateDirectory: join(fixtures, "does-not-exist-dir-2"),
    execFileSyncImpl: () => verboseOutput,
  });
  assert.deepEqual(result.catalog, [
    { id: "opencode/big-pickle", label: "Big Pickle", thinkingLevels: [], provider: "opencode", cost: { input: 0, output: 0 } },
    { id: "github-copilot/gpt-5.6-terra", label: "GPT 5.6 Terra", thinkingLevels: ["low", "high"], provider: "github-copilot", cost: { input: 2, output: 12 } },
  ]);
});

test("readOpencodeDefaults never throws when nothing is available", () => {
  const result = readOpencodeDefaults({
    configDirectory: join(fixtures, "does-not-exist-dir"),
    stateDirectory: join(fixtures, "does-not-exist-dir-2"),
    execFileSyncImpl: throwingExec,
  });
  assert.equal(result.defaultModel, undefined);
  assert.equal(result.source, "static");
  assert.ok(result.warnings.length > 0);
});
