import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const {
  claudeBinaryAvailable,
  claudeLaunchAdapter,
  CLAUDE_PERMISSION_PROMPT_TOOL,
  CLAUDE_PROVIDER,
} = await jiti.import("../claude-launch-adapter.ts");
const { mergeAttestation } = await import("../attest-merge.mjs");
const here = dirname(fileURLToPath(import.meta.url));
const helperPath = join(here, "..", "claude-startup-attest.mjs");
const profile = {
  provider: CLAUDE_PROVIDER,
  model: "claude-sonnet-5",
  thinking: "high",
  auth: "subscription",
};

test("Claude binary detection honors Windows executable extensions and PATHEXT", () => {
  const checked = [];
  assert.equal(
    claudeBinaryAvailable({
      platform: "win32",
      pathValue: "C:\\Users\\zchri\\.local\\bin",
      pathExt: ".COM;.EXE;.BAT;.CMD",
      fileExists: (path) => {
        checked.push(path);
        return path.endsWith("claude.exe");
      },
    }),
    true,
  );
  assert.ok(checked.some((path) => path.endsWith("claude.exe")));

  assert.equal(
    claudeBinaryAvailable({
      platform: "win32",
      pathValue: "/tmp/baa-claude-bin",
      pathExt: ".EXE;.CMD",
      fileExists: (path) => path.endsWith("claude.cmd"),
    }),
    true,
  );
  assert.equal(
    claudeBinaryAvailable({
      platform: "linux",
      pathValue: "/tmp/baa-claude-bin",
      fileExists: (path) => path.endsWith("claude.exe"),
    }),
    false,
  );
});

test("launchArguments emits exact model/effort and generated settings/mcp config", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "baa-claude-adapter-"));
  try {
    const adapter = claudeLaunchAdapter({
      bridge: "/bridge/mcp-server.mjs",
      attestHelper: "/bridge/claude-startup-attest.mjs",
      scratchDirectory: scratch,
    });
    adapter.preflight(profile);
    assert.equal(adapter.startupHandshake, undefined);
    assert.equal(adapter.capabilities.supportsLiveCapabilityDiscovery, false);
    assert.equal(adapter.capabilities.supportsStartupHandshake, false);
    assert.equal(adapter.discoverCatalog, undefined);
    assert.equal(
      adapter.attestationComplete({
        sessionId: "abc",
        operations: ["plan", "dispatch", "complete"],
      }),
      true,
    );
    assert.equal(
      adapter.attestationComplete({ sessionId: "abc", operations: ["plan"] }),
      false,
    );
    const context = { startupIntentPath: "/intents/lane.json" };
    const args = adapter.launchArguments(profile, "/source/index.ts", context);
    assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-5");
    assert.equal(args[args.indexOf("--effort") + 1], "high");
    const settings = JSON.parse(
      await readFile(args[args.indexOf("--settings") + 1], "utf8"),
    );
    const mcp = JSON.parse(
      await readFile(args[args.indexOf("--mcp-config") + 1], "utf8"),
    );
    assert.match(
      settings.hooks.SessionStart[0].hooks[0].command,
      /claude-startup-attest\.mjs/,
    );
    assert.ok(
      settings.permissions.deny.some((rule) => /^Bash\(git push/.test(rule)),
    );
    // Without these, a dispatched lane cannot fulfil its own contract
    // unattended -- every herdr_message/herdr_complete call would prompt
    // for permission with nobody present to answer it.
    assert.ok(
      settings.permissions.allow.includes(
        "mcp__herdr-orchestrator__herdr_message",
      ),
    );
    assert.ok(
      settings.permissions.allow.includes(
        "mcp__herdr-orchestrator__herdr_complete",
      ),
    );
    assert.ok(
      settings.permissions.deny.some((rule) => /^Bash\(git merge/.test(rule)),
    );
    const permissionHook = settings.hooks.PermissionRequest[0];
    assert.equal(permissionHook.matcher, "*", "every prompt is classified or routed");
    assert.match(
      permissionHook.hooks[0].command,
      /known-safe-hook\.mjs" --log ".*known-safe-approvals\.jsonl" --bridge "\/bridge\/mcp-server\.mjs" --intent ".+" --wait-seconds 600$/,
    );
    assert.equal(permissionHook.hooks[0].timeout, 660, "the hook outlives its own wait");
    assert.ok(existsSync(permissionHook.hooks[0].command.match(/^node "([^"]+)"/)[1]), "the hook script ships next to the adapter");
    assert.equal(settings.autoMode.allow[0], "$defaults", "built-in classifier rules are kept");
    assert.match(settings.autoMode.allow[1], /herdr_complete, herdr_message/);
    assert.match(settings.autoMode.allow[1], /does not bypass auto mode/);
    assert.equal(
      mcp.mcpServers["herdr-orchestrator"].args[0],
      "/bridge/mcp-server.mjs",
    );
    assert.deepEqual(mcp.mcpServers["herdr-orchestrator"].env, {
      BAA_STARTUP_INTENT: "/intents/lane.json",
      HERDR_ENV: "1",
    });
    assert.equal(args.includes("--permission-prompt-tool"), false);
    const resumed = adapter.resumeArguments(
      profile,
      {
        provider: CLAUDE_PROVIDER,
        sessionId: "claude-session-123",
        nativeHandle: { kind: "id", value: "claude-session-123" },
      },
      "/source/index.ts",
      context,
    );
    assert.deepEqual(
      resumed.slice(0, 2),
      ["--resume", "claude-session-123"],
    );
    assert.equal(resumed[resumed.indexOf("--model") + 1], profile.model);
    assert.equal(resumed[resumed.indexOf("--effort") + 1], profile.thinking);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("extraMcpServers merge into mcp-config and grant matching tool permission, without overriding herdr-orchestrator", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "baa-claude-extra-mcp-"));
  try {
    const adapter = claudeLaunchAdapter({
      bridge: "/bridge/mcp-server.mjs",
      attestHelper: "/bridge/claude-startup-attest.mjs",
      scratchDirectory: scratch,
    });
    const args = adapter.launchArguments(profile, "/source/index.ts", {
      startupIntentPath: "/intents/lane.json",
      extraMcpServers: {
        "cic-connect": { type: "http", url: "https://example.test/mcp" },
        // A lane-declared entry can never displace the fixed bridge, no
        // matter what the caller names it.
        "herdr-orchestrator": { command: "malicious", args: [] },
      },
    });
    const mcp = JSON.parse(
      await readFile(args[args.indexOf("--mcp-config") + 1], "utf8"),
    );
    assert.deepEqual(mcp.mcpServers["cic-connect"], {
      type: "http",
      url: "https://example.test/mcp",
    });
    assert.equal(
      mcp.mcpServers["herdr-orchestrator"].args[0],
      "/bridge/mcp-server.mjs",
    );
    const settings = JSON.parse(
      await readFile(args[args.indexOf("--settings") + 1], "utf8"),
    );
    assert.ok(settings.permissions.allow.includes("mcp__cic-connect__*"));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("permission broker launch flag is opt-in and preserves the exact tool name", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "baa-claude-permission-"));
  try {
    const adapter = claudeLaunchAdapter({
      bridge: "/bridge/mcp-server.mjs",
      attestHelper: "/bridge/claude-startup-attest.mjs",
      scratchDirectory: scratch,
      permissionPromptTool: CLAUDE_PERMISSION_PROMPT_TOOL,
    });
    const args = adapter.launchArguments(profile, "/source/index.ts", {
      startupIntentPath: "/intents/lane.json",
    });
    const flag = args.indexOf("--permission-prompt-tool");
    assert.equal(
      args.slice(flag, flag + 2).join(" "),
      `--permission-prompt-tool ${CLAUDE_PERMISSION_PROMPT_TOOL}`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("permission broker can be enabled by an explicit default-off environment opt-in", () => {
  const previous = process.env.BAA_CLAUDE_PERMISSION_PROMPT_TOOL;
  process.env.BAA_CLAUDE_PERMISSION_PROMPT_TOOL = "1";
  try {
    const adapter = claudeLaunchAdapter({
      bridge: "/b.js",
      attestHelper: "/a.js",
      scratchDirectory: "/tmp",
    });
    const args = adapter.launchArguments(profile, "/source/index.ts", {
      startupIntentPath: "/intents/lane.json",
    });
    assert.deepEqual(
      args.slice(
        args.indexOf("--permission-prompt-tool"),
        args.indexOf("--permission-prompt-tool") + 2,
      ),
      ["--permission-prompt-tool", CLAUDE_PERMISSION_PROMPT_TOOL],
    );
  } finally {
    if (previous === undefined)
      delete process.env.BAA_CLAUDE_PERMISSION_PROMPT_TOOL;
    else process.env.BAA_CLAUDE_PERMISSION_PROMPT_TOOL = previous;
  }
});

test("permission broker rejects an empty opt-in value", () => {
  const adapter = claudeLaunchAdapter({
    bridge: "/b.js",
    attestHelper: "/a.js",
    scratchDirectory: "/tmp",
    permissionPromptTool: " ",
  });
  assert.throws(
    () =>
      adapter.launchArguments(profile, "/source/index.ts", {
        startupIntentPath: "/intents/lane.json",
      }),
    /non-empty string/,
  );
});

test("preflight rejects foreign providers", () => {
  const adapter = claudeLaunchAdapter({
    bridge: "/b.js",
    attestHelper: "/a.js",
    scratchDirectory: "/tmp",
  });
  assert.throws(
    () => adapter.preflight({ ...profile, provider: "openai-codex" }),
    /claude-code subscription launch adapter/,
  );
});

test("verifyStartup matches native session identity and filters unknown operations", () => {
  const adapter = claudeLaunchAdapter({
    bridge: "/b.js",
    attestHelper: "/a.js",
    scratchDirectory: "/tmp",
  });
  const native = {
    agent: "claude",
    pane_id: "w17:p9",
    workspace_id: "w17",
    agent_session: { kind: "path", value: "/claude/sessions/x.jsonl" },
  };
  const attestation = {
    paneId: "w17:p9",
    workspaceId: "w17",
    nonce: "n",
    source: "/source/index.ts",
    profile,
    sessionPath: "/claude/sessions/x.jsonl",
    operations: ["plan", "dispatch", "complete", "not-an-operation"],
  };
  const proof = adapter.verifyStartup(native, attestation);
  assert.equal(proof.session.kind, "path");
  assert.equal(proof.session.value, "/claude/sessions/x.jsonl");
  assert.deepEqual(proof.operations, ["plan", "dispatch", "complete"]);
  assert.throws(
    () =>
      adapter.verifyStartup(native, {
        ...attestation,
        sessionPath: "/claude/sessions/other.jsonl",
      }),
    /does not match native identity/,
  );
});

test("SessionStart helper merges lane identity and preserves bridge operations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-claude-helper-"));
  try {
    const intentPath = join(directory, "intent.json");
    await writeFile(
      intentPath,
      JSON.stringify({
        version: 1,
        nonce: "nonce-1",
        paneId: "w17:p9",
        workspaceId: "w17",
        source: "/source/index.ts",
        profile,
      }),
      { mode: 0o600 },
    );
    // A lazy bridge may have written only a partial set; the hook must seed
    // the stable contract while preserving the identity merge.
    await mergeAttestation(intentPath, { operations: ["plan", "complete"] });
    const { spawn } = require("node:child_process");
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [helperPath], {
        env: {
          ...process.env,
          BAA_STARTUP_INTENT: intentPath,
          HERDR_PANE_ID: "w17:p9",
          HERDR_WORKSPACE_ID: "w17",
        },
      });
      child.stderr.on("data", (chunk) => reject(new Error(String(chunk))));
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`exit ${code}`)),
      );
      child.stdin.end(
        JSON.stringify({
          session_id: "abc",
          transcript_path: "/claude/projects/p/abc.jsonl",
        }),
      );
    });
    const ready = JSON.parse(await readFile(`${intentPath}.ready`, "utf8"));
    assert.equal(ready.sessionPath, "/claude/projects/p/abc.jsonl");
    assert.equal(ready.sessionId, "abc");
    assert.equal(ready.nonce, "nonce-1");
    assert.equal(ready.source, "/source/index.ts");
    assert.deepEqual(ready.profile, profile);
    assert.deepEqual(ready.operations, ["plan", "dispatch", "complete"]);
    // Wrong pane binding must fail closed.
    await assert.rejects(
      new Promise((_, reject) => {
        const child = spawn(process.execPath, [helperPath], {
          env: {
            ...process.env,
            BAA_STARTUP_INTENT: intentPath,
            HERDR_PANE_ID: "w17:p8",
            HERDR_WORKSPACE_ID: "w17",
          },
        });
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error("expected failure")),
        );
        child.stdin.end("{}");
      }),
      /expected failure/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
