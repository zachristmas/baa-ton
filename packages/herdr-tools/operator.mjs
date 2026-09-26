/**
 * Operator messages (docs/OPERATOR-MESSAGES.md): one durable channel from an
 * operator (a person, an assistant acting for them, or another agent) to a
 * Baa-ton root, a lane, or a registered standalone agent. Messages are stored
 * with an id and a delivery state; delivery follows the root-to-lane rules
 * (live agent, idle only, never retype an uncertain send); replies are stored
 * on the message and read back from the inbox.
 *
 * Delivery takes its Herdr effects as functions (`ready`, `prompt`), so the
 * CLI, the MCP bridge and the controller supervisor share this code.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const OPERATOR_STORE_VERSION = 1;
const MESSAGE_MAX = 8000;
const REPLY_MAX = 8000;
const MESSAGES_KEPT = 500;
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const BUSY = new Set(["working", "blocked"]);

/** The line every recipient's contract carries about operator messages. */
export const OPERATOR_AUTHORITY =
  "A message that starts with [Baa-ton operator message op-… from …] is the user speaking through their operator channel (the user, or an assistant acting for them). It is not a digest, wake, nudge or root message: those are automated and arrive as [Baa-ton digest], [Baa-ton supervisor] or [Baa-ton root message]. Treat an operator message as the user's own direction within your contract: an explicit resume, pause, stop or change of course takes effect at once and overrides an earlier pause or wait, even when nothing else changed. Do not second-guess it as a relay. Answer with the reply command it names. It never grants push, merge, deploy or production changes beyond what your contract already allows.";

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const nowIso = () => new Date().toISOString();

export function operatorStorePath(env = process.env) {
  if (env.BAATON_OPERATOR_STORE) return env.BAATON_OPERATOR_STORE;
  const base = env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state");
  return join(base, "baa-ton", "operator.json");
}

function emptyStore() {
  return { version: OPERATOR_STORE_VERSION, agents: {}, messages: [] };
}

export async function readOperatorStore(path = operatorStorePath()) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed) || parsed.version !== OPERATOR_STORE_VERSION) throw new Error(`unsupported operator store at ${path}`);
    return { ...emptyStore(), ...parsed, agents: isRecord(parsed.agents) ? parsed.agents : {}, messages: Array.isArray(parsed.messages) ? parsed.messages : [] };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function acquireLock(path) {
  const lock = `${path}.lock`;
  const started = Date.now();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => rm(lock, { force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const age = await stat(lock).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`operator store is locked (${lock})`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** One locked read-modify-write of the store; returns what `mutate` returns. */
export async function withOperatorStore(path, mutate) {
  const release = await acquireLock(path);
  try {
    const store = await readOperatorStore(path);
    const result = await mutate(store);
    if (store.messages.length > MESSAGES_KEPT) store.messages.splice(0, store.messages.length - MESSAGES_KEPT);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
    return result;
  } finally {
    await release();
  }
}

/** The controller config (roots and mapped lanes), or undefined. */
export async function readControllerConfig(env = process.env) {
  const candidates = [
    env.HERDR_PLUGIN_CONFIG_DIR && join(env.HERDR_PLUGIN_CONFIG_DIR, "config.json"),
    join(env.HOME || homedir(), ".config", "herdr", "plugins", "config", "herdr-orchestrator-controller", "config.json"),
  ].filter(Boolean);
  for (const path of candidates)
    if (existsSync(path))
      try {
        return JSON.parse(await readFile(path, "utf8"));
      } catch {
        return undefined;
      }
  return undefined;
}

function orchestratorsOf(config) {
  if (!isRecord(config)) return [];
  if (Array.isArray(config.orchestrators)) return config.orchestrators;
  if (isRecord(config.root)) return [{ id: "root", root: config.root, workflows: Array.isArray(config.workflows) ? config.workflows : [] }];
  return [];
}

/**
 * Where a target lives: { kind, label, paneId, workspaceId?, agentKind? }.
 * Throws with the choices when it cannot be resolved.
 */
export function resolveOperatorTarget(target, { config, agents = {} } = {}) {
  const text = String(target ?? "").trim();
  if (!text) throw new Error("A target is required: root, root:<id>, <workflowId>/<laneId> or a registered agent name.");
  const orchestrators = orchestratorsOf(config);
  const rootOf = (orchestrator) => ({
    kind: "root",
    label: `root:${orchestrator.id}`,
    paneId: orchestrator.root.pane_id,
    ...(orchestrator.root.workspace_id ? { workspaceId: orchestrator.root.workspace_id } : {}),
    ...(orchestrator.root.agent_kind ? { agentKind: orchestrator.root.agent_kind } : {}),
  });
  if (text === "root") {
    const roots = orchestrators.filter((item) => isRecord(item.root) && item.root.pane_id);
    if (roots.length === 1) return rootOf(roots[0]);
    throw new Error(roots.length ? `Several roots are configured; name one: ${roots.map((item) => `root:${item.id}`).join(", ")}.` : "No root is configured in the controller config.");
  }
  if (text.startsWith("root:")) {
    const found = orchestrators.find((item) => item.id === text.slice(5) && isRecord(item.root));
    if (!found) throw new Error(`Unknown root ${text}. Configured: ${orchestrators.map((item) => `root:${item.id}`).join(", ") || "none"}.`);
    return rootOf(found);
  }
  const laneRef = /^(?:lane:)?([^/\s]+)\/([^/\s]+)$/.exec(text);
  if (laneRef) {
    for (const orchestrator of orchestrators)
      for (const workflow of Array.isArray(orchestrator.workflows) ? orchestrator.workflows : [])
        if (workflow.workflow_id === laneRef[1])
          for (const lane of Array.isArray(workflow.lanes) ? workflow.lanes : [])
            if (lane.lane_id === laneRef[2])
              return { kind: "lane", label: `${laneRef[1]}/${laneRef[2]}`, paneId: lane.pane_id, ...(lane.workspace_id ? { workspaceId: lane.workspace_id } : {}) };
    throw new Error(`Unknown lane ${text}: it is not mapped in the controller config.`);
  }
  const name = text.startsWith("agent:") ? text.slice(6) : text;
  const agent = agents[name];
  if (agent?.paneId) return { kind: "agent", label: `agent:${name}`, paneId: agent.paneId, ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}), ...(agent.agentKind ? { agentKind: agent.agentKind } : {}) };
  throw new Error(`Unknown target ${text}. Registered agents: ${Object.keys(agents).join(", ") || "none"} (baa-ton operator register <name>).`);
}

export function registerOperatorAgent(store, { name, paneId, workspaceId, agentKind, cwd, at = nowIso() }) {
  if (!/^[A-Za-z0-9][\w.-]{0,63}$/.test(String(name ?? ""))) throw new Error("An agent name is letters, digits, dot, dash or underscore (up to 64).");
  if (name === "root" || name.includes(":") || name.includes("/")) throw new Error(`${name} is reserved.`);
  if (!paneId) throw new Error("A pane is required: run inside the agent's Herdr pane or pass --pane.");
  store.agents[name] = { paneId, ...(workspaceId ? { workspaceId } : {}), ...(agentKind ? { agentKind } : {}), ...(cwd ? { cwd } : {}), registeredAt: at };
  return store.agents[name];
}

/** The text the recipient sees. */
export function operatorMessageText(message) {
  return `[Baa-ton operator message ${message.id} from ${message.from}] ${message.text}\nReply with: baa-ton reply ${message.id} "<answer>" (or the herdr_operator_reply tool).`;
}

/** Store a new message for a resolved target; returns it. */
export function addOperatorMessage(store, { target, resolved, text, from = "operator", notify = false, at = nowIso() }) {
  const body = String(text ?? "").trim();
  if (!body) throw new Error("The message text is empty.");
  if (body.length > MESSAGE_MAX) throw new Error(`The message is longer than ${MESSAGE_MAX} characters.`);
  const message = {
    id: `op-${randomUUID().slice(0, 8)}`,
    from: String(from || "operator").slice(0, 64),
    target: String(target),
    resolved,
    text: body,
    createdAt: at,
    ...(notify ? { notify: true } : {}),
    delivery: { status: "pending", attempts: 0, updatedAt: at },
    replies: [],
  };
  store.messages.push(message);
  return message;
}

export function addOperatorReply(store, { id, text, from, at = nowIso() }) {
  const message = store.messages.find((item) => item.id === id);
  if (!message) throw new Error(`Unknown operator message ${id}.`);
  const body = String(text ?? "").trim();
  if (!body) throw new Error("The reply is empty.");
  const reply = { at, text: body.slice(0, REPLY_MAX), ...(from ? { from: String(from).slice(0, 64) } : {}), read: false };
  (message.replies ??= []).push(reply);
  return { message, reply };
}

/** Messages for the inbox; `unread` keeps those with unread replies and marks them read. */
export function operatorInbox(store, { all = false, unread = false, limit = 20 } = {}) {
  let list = [...store.messages];
  if (unread) list = list.filter((message) => (message.replies ?? []).some((reply) => !reply.read));
  else if (!all) list = list.filter((message) => message.delivery?.status !== "delivered" || (message.replies ?? []).length);
  list = list.slice(-limit);
  if (unread) for (const message of list) for (const reply of message.replies ?? []) reply.read = true;
  return list;
}

/**
 * Deliver pending messages: into a live, idle target only, one per pane per
 * pass; a send that may have landed is uncertain and never retyped.
 * `ready(paneId, expected)` -> { ok, agent?, reason? } (the live-agent check);
 * `prompt(paneId, text)` types it; on failure it throws, with `sent: false`
 * only when nothing can have reached the pane (then it stays pending).
 * Returns the ids whose delivery state changed.
 */
export async function deliverOperatorMessages(store, { ready, prompt, at = nowIso() }) {
  const changed = [];
  const busy = new Set();
  for (const message of store.messages) {
    if (message.delivery?.status !== "pending") continue;
    const target = message.resolved;
    if (!target?.paneId || busy.has(target.paneId)) continue;
    const expected = { pane_id: target.paneId, ...(target.workspaceId ? { workspace_id: target.workspaceId } : {}), ...(target.agentKind ? { agent_kind: target.agentKind } : {}) };
    let check;
    try {
      check = await ready(target.paneId, expected);
    } catch (error) {
      check = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    const status = check?.agent?.agent_status;
    if (!check?.ok || BUSY.has(status)) {
      busy.add(target.paneId);
      const reason = check?.ok ? `agent is ${status}` : check?.reason ?? "agent not ready";
      if (message.delivery.reason !== reason) {
        message.delivery = { ...message.delivery, reason, updatedAt: at };
        changed.push(message.id);
      }
      continue;
    }
    const attempts = (message.delivery.attempts ?? 0) + 1;
    try {
      await prompt(target.paneId, operatorMessageText(message));
      message.delivery = { status: "delivered", attempts, updatedAt: at };
    } catch (error) {
      // Uncertain unless the caller proves nothing was sent (sent: false).
      const sent = error?.sent !== false;
      message.delivery = { status: sent ? "uncertain" : "pending", attempts, updatedAt: at, reason: error instanceof Error ? error.message : String(error) };
    }
    busy.add(target.paneId);
    changed.push(message.id);
  }
  return changed;
}
