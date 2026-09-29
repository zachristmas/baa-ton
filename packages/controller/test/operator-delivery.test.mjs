import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deliverOperatorQueue } from "../controller.mjs";

const store = (messages, agents = {}) => ({ version: 1, agents, messages });
const message = (id, resolved, target) => ({ id, from: "ops", target, resolved, text: "Requeue D10.", createdAt: "2026-09-29T07:26:04.000Z", delivery: { status: "pending", attempts: 0, updatedAt: "2026-09-29T07:26:04.000Z" }, replies: [] });

test("the supervisor delivers a root message to the live agent in the pane even though the root was registered as another agent kind, and lane-admin's from a stale workspace (op-fb9634f3, op-bf424bda)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-operator-delivery-"));
  const path = join(directory, "operator.json");
  await writeFile(
    path,
    JSON.stringify(
      store(
        [
          message("op-root", { kind: "root", label: "root:cic", paneId: "w2J:p1", workspaceId: "w2J", agentKind: "pi" }, "root:cic"),
          message("op-admin", { kind: "agent", label: "agent:lane-admin", paneId: "w2K:p1", workspaceId: "w2H", agentKind: "claude" }, "lane-admin"),
        ],
        { "lane-admin": { paneId: "w2K:p1", workspaceId: "w2H", agentKind: "claude" } },
      ),
    ),
  );
  const prompts = [];
  const live = { "w2J:p1": { agent: "claude", name: "claude", workspace_id: "w2J", agent_status: "done" }, "w2K:p1": { agent: "claude", name: "claude", workspace_id: "w2K", agent_status: "idle" } };
  const herdr = {
    async request(method, params) {
      if (method === "agent.get") return { type: "agent_info", agent: { pane_id: params.target, interactive_ready: true, ...live[params.target] } };
      if (method === "agent.prompt") {
        prompts.push(params);
        return {};
      }
      throw new Error(`Unexpected Herdr method ${method}`);
    },
    // A live agent's foreground process is not the bare shell.
    async processInfo() {
      return { result: { process_info: { shell_pid: 1, foreground_processes: [{ pid: 99 }] } } };
    },
  };
  try {
    const changed = await deliverOperatorQueue({ herdr, storePath: path, timestamp: "2026-09-29T07:40:00.000Z" });
    assert.deepEqual(changed.sort(), ["op-admin", "op-root"]);
    assert.deepEqual(prompts.map((prompt) => prompt.target).sort(), ["w2J:p1", "w2K:p1"]);
    const saved = JSON.parse(await readFile(path, "utf8"));
    const byId = Object.fromEntries(saved.messages.map((item) => [item.id, item]));
    assert.equal(byId["op-root"].delivery.status, "delivered");
    assert.equal(byId["op-root"].delivery.followed, "agent kind pi -> claude");
    assert.equal(byId["op-admin"].delivery.status, "delivered");
    assert.equal(byId["op-admin"].delivery.followed, "workspace w2H -> w2K");
    assert.deepEqual(saved.agents["lane-admin"], { paneId: "w2K:p1", workspaceId: "w2K", agentKind: "claude" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a pane with no agent leaves the message pending with the reason recorded and the clock started", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-operator-delivery-"));
  const path = join(directory, "operator.json");
  await writeFile(path, JSON.stringify(store([message("op-1", { kind: "root", label: "root:cic", paneId: "w2J:p1", agentKind: "pi" }, "root:cic")])));
  const herdr = {
    async request(method) {
      if (method === "agent.get") return { type: "agent_info", agent: {} };
      throw new Error(`Unexpected Herdr method ${method}`);
    },
  };
  try {
    await deliverOperatorQueue({ herdr, storePath: path, timestamp: "2026-09-29T07:40:00.000Z" });
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.messages[0].delivery.status, "pending");
    assert.equal(saved.messages[0].delivery.reason, "no_agent_in_pane");
    assert.equal(saved.messages[0].delivery.blockedSince, "2026-09-29T07:40:00.000Z");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
