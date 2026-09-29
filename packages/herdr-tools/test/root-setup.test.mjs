import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeRootLaunchCommand, claudeRootMcpConfig, claudeRootMcpConfigPath, removeFromMcpJson } from "../root-setup.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "root-setup.mjs");
const identity = (configDir) => ({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1", HERDR_PLUGIN_CONFIG_DIR: configDir });

test("a Claude root's MCP servers come from a per-pane file passed with --mcp-config, not project scope", () => {
  const id = identity("/cfg");
  assert.equal(claudeRootMcpConfigPath(id), "/cfg/root-mcp/w1-w1_p1.json");
  assert.deepEqual(Object.keys(claudeRootMcpConfig(id).mcpServers), ["herdr-orchestrator"]);
  assert.equal(claudeRootMcpConfig(id).mcpServers["herdr-orchestrator"].env.HERDR_PANE_ID, "w1:p1");
  const command = claudeRootLaunchCommand(id);
  assert.match(command, /^claude --mcp-config '\/cfg\/root-mcp\/w1-w1_p1\.json'$/);
  assert.doesNotMatch(command, /strict-mcp-config/, "a root may need claude.ai connectors");
});

test("root-setup for Claude prints the file launch path and never the project-scope `claude mcp add`", async () => {
  const dir = await mkdtemp(join(tmpdir(), "root-setup-"));
  try {
    const env = { ...process.env, HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1", HERDR_PLUGIN_CONFIG_DIR: join(dir, "cfg") };
    const printed = spawnSync(process.execPath, [script, "--harness", "claude"], { cwd: dir, env, encoding: "utf8" });
    assert.equal(printed.status, 0, printed.stderr);
    assert.doesNotMatch(printed.stdout, /claude mcp add/);
    assert.match(printed.stdout, /claude --mcp-config /);
    const written = spawnSync(process.execPath, [script, "--harness", "claude", "--write"], { cwd: dir, env, encoding: "utf8" });
    assert.equal(written.status, 0, written.stderr);
    const file = JSON.parse(await readFile(join(dir, "cfg", "root-mcp", "w1-w1_p1.json"), "utf8"));
    assert.ok(file.mcpServers["herdr-orchestrator"]);
    await assert.rejects(readFile(join(dir, ".mcp.json"), "utf8"), /ENOENT/, "no project-scope .mcp.json is written");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("removing the project-scope entries needs --verified-live and the new launch file, and removes only the two servers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "root-setup-"));
  try {
    const cfg = join(dir, "cfg");
    const env = { ...process.env, HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1", HERDR_PLUGIN_CONFIG_DIR: cfg, PATH: dir };
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { "herdr-orchestrator": { command: "node" }, playwright: { command: "npx" }, other: { command: "x" } } }));
    const run = (...extra) => spawnSync(process.execPath, [script, "--harness", "claude", "--remove-project-scope", ...extra], { cwd: dir, env, encoding: "utf8" });
    assert.notEqual(run().status, 0, "refuses without --verified-live");
    assert.notEqual(run("--verified-live").status, 0, "refuses without the new launch file");
    await mkdir(join(cfg, "root-mcp"), { recursive: true });
    await writeFile(claudeRootMcpConfigPath(identity(cfg)), "{}");
    const done = run("--verified-live");
    assert.equal(done.status, 0, done.stderr);
    const after = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(after.mcpServers), ["other"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("removeFromMcpJson reports what it removed", () => {
  const config = { mcpServers: { playwright: {}, keep: {} } };
  assert.deepEqual(removeFromMcpJson(config), ["playwright"]);
  assert.deepEqual(Object.keys(config.mcpServers), ["keep"]);
  assert.deepEqual(removeFromMcpJson({}), []);
});
