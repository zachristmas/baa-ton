import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { routePermission } from "../permission-route.mjs";

const request = (status, extra = {}) => ({
  structuredContent: { kind: "request", request: { id: "request-1", status, ...extra } },
});

function fakeCall(responses) {
  const calls = [];
  return {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      const next = responses.shift();
      return typeof next === "function" ? next(args) : next;
    },
  };
}

function fakeClock() {
  let time = 0;
  return { now: () => time, sleep: async (ms) => void (time += ms) };
}

test("a request the policy grants at once is allowed without waiting", async () => {
  const bridge = fakeCall([request("granted", { answeredBy: "policy" })]);
  const routed = await routePermission({ call: bridge.call, toolName: "Bash", input: { command: "npm run build" }, ...fakeClock() });
  assert.deepEqual(routed.decision, { behavior: "allow" });
  assert.deepEqual(bridge.calls, [
    { name: "herdr_request", args: { action: "open", kind: "permission", toolName: "Bash", input: { command: "npm run build" } } },
  ]);
});

test("an open request waits for the root: grant allows, deny carries the note", async () => {
  const granted = fakeCall([request("open"), request("open"), request("granted", { answeredBy: "root" })]);
  const clock = fakeClock();
  const allowed = await routePermission({ call: granted.call, toolName: "Bash", input: { command: "x" }, pollMs: 1000, ...clock });
  assert.deepEqual(allowed.decision, { behavior: "allow" });
  assert.deepEqual(granted.calls.slice(1).map((call) => call.args), [
    { action: "status", requestId: "request-1" },
    { action: "status", requestId: "request-1" },
  ]);
  assert.equal(clock.now(), 2000);

  const denied = fakeCall([request("open"), request("denied", { note: "use the lane database instead" })]);
  const refused = await routePermission({ call: denied.call, toolName: "Bash", input: { command: "x" }, pollMs: 1000, ...fakeClock() });
  assert.equal(refused.decision.behavior, "deny");
  assert.match(refused.decision.message, /root denied request-1: use the lane database instead/);
});

test("no answer before the wait ends, or a failed open, leaves the normal prompt", async () => {
  const clock = fakeClock();
  const silent = fakeCall([request("open"), ...Array.from({ length: 10 }, () => request("open"))]);
  const timedOut = await routePermission({ call: silent.call, toolName: "Bash", input: {}, waitMs: 3000, pollMs: 1000, ...clock });
  assert.equal(timedOut.decision, undefined);
  assert.equal(timedOut.request.id, "request-1", "the request stays open for the root");
  assert.equal(clock.now(), 3000);

  const failed = fakeCall([{ isError: true, content: [{ type: "text", text: "herdr_request action=open is for a registered child lane." }] }]);
  const refused = await routePermission({ call: failed.call, toolName: "Bash", input: {}, ...fakeClock() });
  assert.equal(refused.decision, undefined);
  assert.match(refused.reason, /registered child lane/);
});

const FAKE_BRIDGE = `
import { appendFileSync } from "node:fs";
let buffer = "";
let statusCalls = 0;
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
    const message = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    appendFileSync(process.env.FAKE_BRIDGE_LOG, JSON.stringify({ method: message.method, params: message.params, intent: process.env.BAA_STARTUP_INTENT, herdr: process.env.HERDR_ENV }) + "\\n");
    if (message.method === "initialize") reply(message.id, { protocolVersion: "2024-11-05" });
    else if (message.params.arguments.action === "open") reply(message.id, { structuredContent: { kind: "request", request: { id: "request-9", status: "open" } } });
    else {
      statusCalls += 1;
      const status = statusCalls < 2 ? "open" : process.env.FAKE_BRIDGE_ANSWER;
      reply(message.id, { structuredContent: { kind: "request", request: { id: "request-9", status, note: "not on a shared database" } } });
    }
  }
});
`;

test("the hook routes an unclassified prompt through the lane's bridge and answers with the root's decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-permission-route-"));
  const bridge = join(directory, "fake-bridge.mjs");
  const bridgeLog = join(directory, "bridge.jsonl");
  const log = join(directory, "approvals.jsonl");
  await writeFile(bridge, FAKE_BRIDGE);
  const hook = fileURLToPath(new URL("../known-safe-hook.mjs", import.meta.url));
  const run = (tool, input, answer, extra = []) =>
    spawnSync(
      process.execPath,
      [hook, "--log", log, "--bridge", bridge, "--intent", "/lane/intent.json", "--wait-seconds", "20", "--poll-ms", "20", ...extra],
      {
        input: JSON.stringify({ session_id: "s-2", cwd: directory, hook_event_name: "PermissionRequest", tool_name: tool, tool_input: input }),
        encoding: "utf8",
        env: { ...process.env, FAKE_BRIDGE_LOG: bridgeLog, FAKE_BRIDGE_ANSWER: answer },
        timeout: 20_000,
      },
    );
  try {
    const granted = run("Bash", { command: "docker compose up -d db" }, "granted");
    assert.equal(granted.status, 0);
    assert.deepEqual(JSON.parse(granted.stdout).hookSpecificOutput.decision, { behavior: "allow" });
    const calls = (await readFile(bridgeLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls[0].method, "initialize");
    assert.deepEqual(calls[1].params, {
      name: "herdr_request",
      arguments: { action: "open", kind: "permission", toolName: "Bash", input: { command: "docker compose up -d db" } },
    });
    assert.ok(calls.every((call) => call.intent === "/lane/intent.json" && call.herdr === "1"), "the bridge gets the lane's startup intent");

    const denied = run("mcp__other__tool", { value: 1 }, "denied");
    const decision = JSON.parse(denied.stdout).hookSpecificOutput.decision;
    assert.equal(decision.behavior, "deny");
    assert.match(decision.message, /request-9: not on a shared database/);

    const timedOut = run("Bash", { command: "docker compose up -d db" }, "open", ["--wait-seconds", "0"]);
    assert.equal(timedOut.stdout, "", "no answer: the normal prompt shows");

    const question = run("AskUserQuestion", { questions: [] }, "granted");
    assert.equal(question.stdout, "", "interactive tools are never routed");

    const audit = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(
      audit.map((entry) => [entry.decision, entry.requestId, entry.tool]),
      [["allow", "request-9", "Bash"], ["deny", "request-9", "mcp__other__tool"], ["prompt", "request-9", "Bash"]],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
