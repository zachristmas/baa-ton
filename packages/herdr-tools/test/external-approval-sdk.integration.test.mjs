import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerExternalApprovalBeforeToolCall } from "../external-approval-hook.mjs";
import { resolveApprovalSessionFile } from "../approval-session.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const command = "gh pr create --repo owner/repo --base main";
const model = { id: "test", name: "Test", api: "openai-completions", provider: "openai", baseUrl: "http://invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1024, maxTokens: 128 };
const binding = { repo: "/repo", head: "abc", branch: "topic", target: "main", baseRef: "main", headRef: "topic", targetRepo: "owner/repo", host: "github.com", remoteName: "origin", paneId: "w:p1", sessionId: "/session", caller: "root" };

async function runSdkToolCall(options = {}) {
  const state = { confirmations: 0, executions: [], blocks: [] };
  const priorApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "deterministic-test-key";
  const extension = (pi) => {
    registerExternalApprovalBeforeToolCall(pi, async () => ({
      enabled: options.enabled ?? true,
      caller: options.caller ?? "root",
      hasUI: options.hasUI ?? true,
      sessionFile: options.activeSession ? await resolveApprovalSessionFile({ sessionManager: { getSessionFile: () => options.activeSession } }, {}) : options.sessionFile === undefined ? "/session" : options.sessionFile,
      resolveBinding: async () => {
        if (options.mismatch) throw new Error("repository/hostname mismatch");
        return binding;
      },
      confirm: async () => { state.confirmations++; return options.confirm ?? true; },
    }));
    pi.on("tool_call", async (event) => { state.blocks.push(event); });
    pi.registerTool(createBashToolDefinition("/repo", { operations: { exec: async (cmd) => { state.executions.push(cmd); return { exitCode: 0 }; } } }));
  };
  const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.cwd(), noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [extension] });
  await loader.reload();
  const sessionManager = SessionManager.inMemory(process.cwd());
  if (options.activeSession) sessionManager.getSessionFile = () => options.activeSession;
  const { session } = await createAgentSession({ cwd: process.cwd(), model, tools: ["bash"], resourceLoader: loader, sessionManager });
  try {
    // The SDK agent's documented StreamFn seam supplies one deterministic model tool call.
    session.agent.getApiKey = async () => "deterministic-test-key";
    let modelTurns = 0;
    session.agent.streamFunction = async () => {
      modelTurns++;
      const toolCall = { type: "toolCall", id: "call-1", name: "bash", arguments: { command: options.command ?? command } };
      const message = { role: "assistant", content: modelTurns === 1 ? [toolCall] : [{ type: "text", text: "finished" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: modelTurns === 1 ? "toolUse" : "stop" };
      return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: message }; if (modelTurns === 1) yield { type: "toolcall_start", contentIndex: 0, partial: message }; if (modelTurns === 1) yield { type: "toolcall_end", contentIndex: 0, toolCall, partial: message }; yield { type: "done", reason: message.stopReason, message }; }, async result() { return message; } };
    };
    await session.prompt("Run the requested command.");
    state.toolResults = session.messages.filter((message) => message.role === "toolResult");
    return state;
  } finally {
    session.dispose();
    if (priorApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorApiKey;
  }
}

test("installed headless Pi SDK dispatch blocks external approval before fake Bash execution", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(source, /registerExternalApprovalBeforeToolCall\(pi,/);
  const allowed = await runSdkToolCall();
  assert.equal(allowed.confirmations, 0);
  assert.deepEqual(allowed.executions, []);
});

test("SDK seam resolves the active SessionManager file without PI_SESSION_FILE and remains headless-safe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "approval-session-"));
  const session = join(dir, "session.jsonl");
  await writeFile(session, "{}\n");
  const old = process.env.PI_SESSION_FILE;
  delete process.env.PI_SESSION_FILE;
  try {
    assert.equal(await resolveApprovalSessionFile({ sessionManager: { getSessionFile: () => session } }, {}), await (await import("node:fs/promises")).realpath(session));
    const allowed = await runSdkToolCall({ activeSession: session });
    assert.equal(allowed.confirmations, 0);
    assert.deepEqual(allowed.executions, []);
    const missing = await runSdkToolCall({ sessionFile: null });
    assert.equal(missing.confirmations, 0);
    assert.deepEqual(missing.executions, []);
    const child = await runSdkToolCall({ activeSession: session, caller: "child" });
    assert.equal(child.confirmations, 0);
    assert.deepEqual(child.executions, []);
  } finally {
    if (old === undefined) delete process.env.PI_SESSION_FILE;
    else process.env.PI_SESSION_FILE = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test("SDK tool dispatch blocks declined, ineligible and mismatched calls before fake Bash execution", async () => {
  for (const options of [{ confirm: false }, { caller: "child" }, { hasUI: false }, { sessionFile: null }, { mismatch: true }, { command: "env gh pr create --repo owner/repo" }, { command: "gh pr create --repo owner/repo; echo unsafe" }, { command: "gh pr create --hostname evil.test --repo owner/repo" }]) {
    const result = await runSdkToolCall(options);
    assert.deepEqual(result.executions, [], JSON.stringify(options));
    assert.equal(result.toolResults.length, 1, JSON.stringify(options));
    assert.equal(result.toolResults[0].isError, true, JSON.stringify(options));
  }
});
