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
  undeliverableMessages,
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
      assert.deepEqual(expected, { pane_id: "w9:p2" }, "only the pane must match; the live agent is followed");
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

test("the run state is durable: operator STOP/RESUME to a root and baa-ton run set it; other text never does", async () => {
  const { runStateFromText, runStateLine } = await import("../operator.mjs");
  assert.equal(runStateFromText("PAUSE EVERYTHING until I say so"), "paused");
  assert.equal(runStateFromText("stop now"), "paused");
  assert.equal(runStateFromText("RESUME: the pause is over"), "running");
  assert.equal(runStateFromText("Please pause after D12 if it fails"), undefined, "only the first word counts");
  const { env, cleanup } = await scratch();
  try {
    const lines = [];
    const out = (text) => lines.push(text);
    await runOperatorCli(["run", "status"], { env, out });
    assert.match(lines.at(-1), /^Run state: running\. A pause exists only when this line says PAUSED/);
    // Only Zach pauses the run: a STOP from anyone else is delivered but pauses nothing.
    const refused = await sendOperatorMessage({ target: "root", text: "PAUSE EVERYTHING, per the default", from: "ops-assistant", env, config: CONFIG, deliver: async () => [] });
    assert.match(refused.runStateRefused, /only Zach can pause/);
    await runOperatorCli(["run", "status"], { env, out });
    assert.match(lines.at(-1), /^Run state: running\./);
    await sendOperatorMessage({ target: "root", text: "PAUSE EVERYTHING, driving home", from: "zach", env, config: CONFIG, deliver: async () => [] });
    await runOperatorCli(["run", "status"], { env, out });
    assert.match(lines.at(-1), /^Run state: PAUSED by zach \(PAUSE EVERYTHING, driving home\)/);
    await sendOperatorMessage({ target: "herdr-a1/lane-1", text: "RESUME your build", env, config: CONFIG, deliver: async () => [] });
    await runOperatorCli(["run", "status"], { env, out });
    assert.match(lines.at(-1), /PAUSED/, "a message to a lane does not change the run state");
    await runOperatorCli(["run", "resume", "--from", "zach"], { env, out });
    assert.match(lines.at(-1), /^Run state: running \(set by zach at /);
    assert.equal(runStateLine({ state: "running", implicit: true }).includes("set by"), false);
  } finally {
    await cleanup();
  }
});

test("delivery follows the live pane: a root that switched agent kind and an agent registered in a stale workspace still get their messages (op-fb9634f3, op-bf424bda)", async () => {
  const store = { version: 1, agents: { "lane-admin": { paneId: "w2K:p1", workspaceId: "w2H", agentKind: "claude" } }, messages: [] };
  const root = { kind: "root", label: "root:cic", paneId: "w2J:p1", workspaceId: "w2J", agentKind: "pi" };
  const admin = resolveOperatorTarget("lane-admin", { agents: store.agents });
  const toRoot = addOperatorMessage(store, { target: "root:cic", resolved: root, text: "Requeue D10." });
  const toAdmin = addOperatorMessage(store, { target: "lane-admin", resolved: admin, text: "Status?" });
  const prompts = [];
  const seen = [];
  // The live panes: Claude in the root pane, and lane-admin in workspace w2K, not the registered w2H.
  const live = { "w2J:p1": { agent: "claude", workspace_id: "w2J", agent_status: "done" }, "w2K:p1": { agent: "claude", workspace_id: "w2K", agent_status: "idle" } };
  const effects = {
    ready: async (paneId, expected) => (seen.push([paneId, expected]), { ok: true, agent: live[paneId] }),
    prompt: async (paneId, text) => prompts.push({ paneId, text }),
  };
  await deliverOperatorMessages(store, effects);
  assert.deepEqual(prompts.map((prompt) => prompt.paneId), ["w2J:p1", "w2K:p1"]);
  assert.deepEqual(seen.map(([, expected]) => expected), [{ pane_id: "w2J:p1" }, { pane_id: "w2K:p1" }], "only the pane is required to match");
  assert.equal(toRoot.delivery.status, "delivered");
  assert.equal(toRoot.delivery.followed, "agent kind pi -> claude");
  assert.equal(toAdmin.delivery.followed, "workspace w2H -> w2K");
  // What the live pane says is remembered for the next message.
  assert.equal(toRoot.resolved.agentKind, "claude");
  assert.deepEqual(store.agents["lane-admin"], { paneId: "w2K:p1", workspaceId: "w2K", agentKind: "claude" });
});

test("a registered agent's message goes to the pane it is registered at now, not the pane it was sent to", async () => {
  const store = { version: 1, agents: { "lane-admin": { paneId: "w2K:p1", agentKind: "claude" } }, messages: [] };
  const message = addOperatorMessage(store, { target: "lane-admin", resolved: resolveOperatorTarget("lane-admin", { agents: store.agents }), text: "Status?" });
  store.agents["lane-admin"] = { paneId: "w9:p4", agentKind: "claude" };
  const prompts = [];
  await deliverOperatorMessages(store, { ready: async () => ({ ok: true, agent: { agent: "claude", agent_status: "idle" } }), prompt: async (paneId) => prompts.push(paneId), at: "2026-09-29T08:00:00.000Z" });
  assert.deepEqual(prompts, ["w9:p4"]);
  assert.equal(message.delivery.status, "delivered");
});

test("every held message shows why, and a persistent reason starts a clock that ends at delivery", async () => {
  const store = { version: 1, agents: {}, messages: [] };
  const target = { kind: "root", label: "root:cic", paneId: "w2J:p1" };
  const first = addOperatorMessage(store, { target: "root:cic", resolved: target, text: "One." });
  const second = addOperatorMessage(store, { target: "root:cic", resolved: target, text: "Two." });
  const T0 = Date.parse("2026-09-29T08:00:00.000Z");
  const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
  const noAgent = { ready: async () => ({ ok: false, reason: "no_agent_in_pane" }), prompt: async () => assert.fail("nothing is sent") };
  await deliverOperatorMessages(store, { ...noAgent, at: at(0) });
  assert.equal(first.delivery.reason, "no_agent_in_pane");
  assert.equal(second.delivery.reason, "no_agent_in_pane", "the message behind the first shows the reason too");
  assert.equal(first.delivery.blockedSince, at(0));
  await deliverOperatorMessages(store, { ...noAgent, at: at(20) });
  assert.equal(first.delivery.blockedSince, at(0), "the clock keeps its start");
  assert.deepEqual(undeliverableMessages(store, { now: T0 + 5 * 60_000 }), [], "not yet");
  const stuck = undeliverableMessages(store, { now: T0 + 20 * 60_000 });
  assert.deepEqual(stuck.map((group) => [group.label, group.reason, group.ids]), [["root:cic", "no_agent_in_pane", [first.id, second.id]]]);
  // A busy agent is expected to be busy: no clock.
  await deliverOperatorMessages(store, { ready: async () => ({ ok: true, agent: { agent_status: "working" } }), prompt: async () => assert.fail("busy"), at: at(30) });
  assert.equal(first.delivery.reason, "agent is working");
  assert.equal(first.delivery.blockedSince, undefined);
  assert.deepEqual(undeliverableMessages(store, { now: T0 + 90 * 60_000 }), []);
  // Delivered: gone from the list.
  await deliverOperatorMessages(store, { ready: async () => ({ ok: true, agent: { agent_status: "idle" } }), prompt: async () => undefined, at: at(40) });
  assert.equal(first.delivery.status, "delivered");
  assert.equal(first.delivery.blockedSince, undefined);
});
