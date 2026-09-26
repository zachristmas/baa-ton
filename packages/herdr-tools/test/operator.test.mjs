import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  OPERATOR_AUTHORITY,
  addOperatorMessage,
  deliverOperatorMessages,
  operatorStorePath,
  readOperatorStore,
  resolveOperatorTarget,
  withOperatorStore,
} from "../operator.mjs";
import { readOperatorInbox, replyToOperator, sendOperatorMessage } from "../operator-api.mjs";
import { parseArgs, runOperatorCli } from "../operator-cli.mjs";

const CONFIG = {
  version: 2,
  orchestrators: [
    {
      id: "task",
      root: { target: "root", target_kind: "name", pane_id: "w1:p1", workspace_id: "w1", agent_kind: "pi" },
      workflows: [{ workflow_id: "herdr-a1", lanes: [{ lane_id: "lane-1", pane_id: "w2:p3", workspace_id: "w2" }] }],
    },
  ],
};

async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), "baa-operator-"));
  const env = { HOME: directory, BAATON_OPERATOR_STORE: join(directory, "state", "operator.json") };
  return { directory, env, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("targets resolve to the root, a mapped lane or a registered agent", () => {
  assert.deepEqual(resolveOperatorTarget("root", { config: CONFIG }), { kind: "root", label: "root:task", paneId: "w1:p1", workspaceId: "w1", agentKind: "pi" });
  assert.equal(resolveOperatorTarget("root:task", { config: CONFIG }).paneId, "w1:p1");
  assert.deepEqual(resolveOperatorTarget("herdr-a1/lane-1", { config: CONFIG }), { kind: "lane", label: "herdr-a1/lane-1", paneId: "w2:p3", workspaceId: "w2" });
  const agents = { "lane-admin": { paneId: "w9:p2", agentKind: "claude" } };
  assert.equal(resolveOperatorTarget("lane-admin", { config: CONFIG, agents }).label, "agent:lane-admin");
  assert.equal(resolveOperatorTarget("agent:lane-admin", { config: CONFIG, agents }).agentKind, "claude");
  const two = { orchestrators: [...CONFIG.orchestrators, { id: "other", root: { pane_id: "w5:p1" }, workflows: [] }] };
  assert.throws(() => resolveOperatorTarget("root", { config: two }), /Several roots are configured; name one: root:task, root:other/);
  assert.throws(() => resolveOperatorTarget("herdr-a1/lane-9", { config: CONFIG }), /not mapped/);
  assert.throws(() => resolveOperatorTarget("nobody", { config: CONFIG, agents }), /Registered agents: lane-admin/);
});

test("delivery: only into a live, idle agent, one per pane, never retyping an uncertain send", async () => {
  const store = { version: 1, agents: {}, messages: [] };
  const target = { kind: "agent", label: "agent:a", paneId: "w9:p2", agentKind: "claude" };
  const first = addOperatorMessage(store, { target: "a", resolved: target, text: "Please rerun the suite.", from: "ops-assistant" });
  const second = addOperatorMessage(store, { target: "a", resolved: target, text: "And report back." });
  let status = "working";
  const prompts = [];
  const effects = {
    ready: async (paneId, expected) => {
      assert.deepEqual(expected, { pane_id: "w9:p2", agent_kind: "claude" });
      return { ok: true, agent: { agent_status: status } };
    },
    prompt: async (paneId, text) => prompts.push({ paneId, text }),
  };
  await deliverOperatorMessages(store, effects);
  assert.equal(prompts.length, 0, "held while busy");
  assert.equal(first.delivery.status, "pending");
  assert.equal(first.delivery.reason, "agent is working");
  status = "idle";
  await deliverOperatorMessages(store, effects);
  assert.equal(prompts.length, 1, "one message per pane per pass");
  assert.match(prompts[0].text, new RegExp(`^\\[Baa-ton operator message ${first.id} from ops-assistant\\] Please rerun the suite\\.`));
  assert.match(prompts[0].text, new RegExp(`baa-ton reply ${first.id}`));
  assert.equal(first.delivery.status, "delivered");
  // A send that may have landed is uncertain and never retyped.
  await deliverOperatorMessages(store, { ...effects, prompt: async () => { throw new Error("socket closed after write"); } });
  assert.equal(second.delivery.status, "uncertain");
  await deliverOperatorMessages(store, effects);
  assert.equal(prompts.length, 1);
  // Nothing sent (sent: false): stays pending for the next pass.
  const third = addOperatorMessage(store, { target: "a", resolved: target, text: "Third." });
  await deliverOperatorMessages(store, { ...effects, prompt: async () => { throw Object.assign(new Error("no socket"), { sent: false }); } });
  assert.equal(third.delivery.status, "pending");
  // The live-agent check failing (a bare shell, no agent) holds it too.
  await deliverOperatorMessages(store, { ...effects, ready: async () => ({ ok: false, reason: "pane_shows_shell_prompt" }) });
  assert.equal(third.delivery.reason, "pane_shows_shell_prompt");
});

test("the CLI stores a message with an id and a state; replies come back through the inbox", async () => {
  const { env, cleanup } = await scratch();
  try {
    const lines = [];
    const out = (text) => lines.push(text);
    await runOperatorCli(["operator", "register", "lane-admin", "--pane", "w9:p2", "--kind", "claude"], { env, out });
    assert.match(lines.at(-1), /registered lane-admin at pane w9:p2/);
    assert.match(lines.at(-1), /operator channel/);
    // No Herdr socket here: stored as pending for the supervisor to deliver.
    const message = await runOperatorCli(["message", "lane-admin", "Status", "please?", "--from", "ops-assistant", "--notify"], { env, out });
    assert.match(message.id, /^op-[0-9a-f]{8}$/);
    assert.equal(message.delivery.status, "pending");
    assert.equal(message.text, "Status please?");
    assert.match(lines.at(-1), new RegExp(`${message.id} -> agent:lane-admin: pending`));
    const notified = [];
    await replyToOperator({ id: message.id, text: "Suite green; merging.", from: "lane-admin", env, runHerdr: async (args) => notified.push(args) });
    assert.equal(notified.length, 1, "--notify raises a notification on the reply");
    assert.equal(notified[0][2], `Baa-ton: reply to ${message.id}`);
    const unread = await readOperatorInbox({ unread: true, env });
    assert.deepEqual(unread.map((item) => item.replies.map((reply) => reply.text)), [["Suite green; merging."]]);
    assert.equal((await readOperatorInbox({ unread: true, env })).length, 0, "read once");
    await runOperatorCli(["inbox", "--all"], { env, out });
    assert.match(lines.at(-1), /reply .* from lane-admin: Suite green; merging\./);
    await assert.rejects(runOperatorCli(["message", "nobody", "hi"], { env, out }), /Unknown target nobody/);
    await assert.rejects(replyToOperator({ id: "op-00000000", text: "x", env }), /Unknown operator message/);
    assert.equal(operatorStorePath(env), env.BAATON_OPERATOR_STORE);
  } finally {
    await cleanup();
  }
});

test("sending delivers at once when it can, through the same rules", async () => {
  const { env, cleanup } = await scratch();
  try {
    const typed = [];
    const message = await sendOperatorMessage({
      target: "root",
      text: "Pause after this item.",
      env,
      config: CONFIG,
      deliver: () =>
        withOperatorStore(env.BAATON_OPERATOR_STORE, (store) =>
          deliverOperatorMessages(store, { ready: async () => ({ ok: true, agent: { agent_status: "idle" } }), prompt: async (paneId, text) => typed.push({ paneId, text }) }),
        ),
    });
    assert.equal(message.delivery.status, "delivered");
    assert.equal(typed[0].paneId, "w1:p1");
    assert.equal((await readOperatorStore(env.BAATON_OPERATOR_STORE)).messages.length, 1);
  } finally {
    await cleanup();
  }
});

test("the controller delivers operator messages with its live-agent check, and the contract names the channel", async () => {
  const { env, cleanup } = await scratch();
  try {
    const { deliverOperatorQueue } = await import("../../controller/controller.mjs");
    await withOperatorStore(env.BAATON_OPERATOR_STORE, (store) => {
      addOperatorMessage(store, { target: "root", resolved: { kind: "root", label: "root:task", paneId: "w1:p1", workspaceId: "w1", agentKind: "pi" }, text: "Hello." });
    });
    const calls = [];
    let shell = true;
    const herdr = {
      async request(method, params) {
        calls.push(method);
        if (method === "agent.get") return { type: "agent_info", agent: { agent: "pi", pane_id: "w1:p1", workspace_id: "w1", agent_status: "idle" } };
        if (method === "agent.prompt") return { type: "agent_prompted" };
        throw new Error(method);
      },
      // Herdr can keep an agent record briefly after the agent exits.
      async processInfo() {
        return { shell_pid: 10, foreground_processes: shell ? [{ pid: 10 }] : [{ pid: 11 }] };
      },
    };
    await deliverOperatorQueue({ herdr, storePath: env.BAATON_OPERATOR_STORE });
    assert.equal(calls.includes("agent.prompt"), false, "never typed into a bare shell");
    shell = false;
    assert.equal((await deliverOperatorQueue({ herdr, storePath: env.BAATON_OPERATOR_STORE })).length, 1);
    assert.equal((await readOperatorStore(env.BAATON_OPERATOR_STORE)).messages[0].delivery.status, "delivered");

    const require = createRequire(import.meta.url);
    const { laneContract } = await require("jiti")(import.meta.url).import("../index.ts");
    const contract = laneContract({ id: "w", agentKind: "claude", lanes: [] }, { id: "l", objective: "x", readOnly: false, agentKind: "claude", status: "planned" });
    assert.ok(contract.includes(OPERATOR_AUTHORITY));
    assert.match(OPERATOR_AUTHORITY, /the user speaking through their operator channel/);
    assert.match(OPERATOR_AUTHORITY, /not a digest, wake, nudge or root message/);
    assert.match(OPERATOR_AUTHORITY, /explicit resume, pause, stop or change of course takes effect at once and overrides an earlier pause/);
    assert.match(OPERATOR_AUTHORITY, /never grants push, merge, deploy or production/);
  } finally {
    await cleanup();
  }
});

test("CLI flags", () => {
  assert.deepEqual(parseArgs(["lane-admin", "hi", "--from", "me", "--notify", "there"]), { positional: ["lane-admin", "hi", "there"], flags: { from: "me", notify: true } });
  assert.deepEqual(parseArgs(["x", "--", "--not-a-flag"]).positional, ["x", "--not-a-flag"]);
});
