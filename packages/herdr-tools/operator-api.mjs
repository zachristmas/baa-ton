/**
 * The operator channel's entry points, shared by the `baa-ton` CLI, the Pi
 * extension's tools and the MCP bridge (docs/OPERATOR-MESSAGES.md).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  OPERATOR_AUTHORITY,
  addOperatorMessage,
  addOperatorReply,
  operatorInbox,
  operatorStorePath,
  readControllerConfig,
  readOperatorStore,
  registerOperatorAgent,
  resolveOperatorTarget,
  runState,
  runStateFromText,
  setRunState,
  withOperatorStore,
} from "./operator.mjs";

const execFileAsync = promisify(execFile);

/** Deliver pending messages now, when this process can reach Herdr; the supervisor tick does it otherwise. */
async function deliverNow({ env = process.env, deliver } = {}) {
  if (deliver) return deliver();
  if (!env.HERDR_SOCKET_PATH) return [];
  try {
    const { JsonLineHerdrClient, deliverOperatorQueue } = await import("../controller/controller.mjs");
    return await deliverOperatorQueue({ herdr: new JsonLineHerdrClient(env.HERDR_SOCKET_PATH), storePath: operatorStorePath(env) });
  } catch {
    return [];
  }
}

async function notify(title, body, run = (args) => execFileAsync("herdr", args, { timeout: 5_000 })) {
  try {
    await run(["notification", "show", title, "--body", body.slice(0, 400), "--sound", "request"]);
  } catch {
    // Best effort: the reply is stored either way.
  }
}

export async function sendOperatorMessage({ target, text, from, notify: notifyOnReply = false, env = process.env, config, deliver } = {}) {
  const path = operatorStorePath(env);
  const controllerConfig = config ?? (await readControllerConfig(env));
  const message = await withOperatorStore(path, (store) => {
    const resolved = resolveOperatorTarget(target, { config: controllerConfig, agents: store.agents });
    const added = addOperatorMessage(store, { target, resolved, text, from: from || env.BAATON_OPERATOR || "operator", notify: notifyOnReply });
    // STOP / PAUSE / RESUME to a root sets the durable run state.
    const wanted = resolved.kind === "root" ? runStateFromText(text) : undefined;
    if (wanted) added.runState = setRunState(store, { state: wanted, reason: String(text).slice(0, 200), by: added.from });
    return added;
  });
  await deliverNow({ env, deliver });
  const stored = (await readOperatorStore(path)).messages.find((item) => item.id === message.id) ?? message;
  return stored;
}

export async function replyToOperator({ id, text, from, env = process.env, runHerdr } = {}) {
  const path = operatorStorePath(env);
  const { message, reply } = await withOperatorStore(path, (store) => addOperatorReply(store, { id, text, from: from || env.BAATON_AGENT_NAME }));
  if (message.notify) await notify(`Baa-ton: reply to ${message.id}`, `${message.resolved?.label ?? message.target}: ${reply.text}`, runHerdr);
  return { id: message.id, target: message.target, reply };
}

export async function readOperatorInbox({ all = false, unread = false, limit = 20, env = process.env } = {}) {
  const path = operatorStorePath(env);
  if (unread) return withOperatorStore(path, (store) => operatorInbox(store, { unread: true, limit }));
  return operatorInbox(await readOperatorStore(path), { all, limit });
}

export async function registerAgent({ name, paneId, workspaceId, agentKind, cwd, sessionId, resume, env = process.env } = {}) {
  const path = operatorStorePath(env);
  // The agent's working folder bounds the unattended policy for its prompts.
  // A Claude Code session id makes the agent resumable: with `resume` set, the
  // supervisor relaunches it in its pane if that pane dies (agent-revive.mjs).
  const session = sessionId ?? env.CLAUDE_CODE_SESSION_ID;
  const resumeCommand = resume === true ? (session ? `claude --resume ${session}` : undefined) : resume || undefined;
  if (resume && !resumeCommand) throw new Error("--resume needs a Claude Code session (CLAUDE_CODE_SESSION_ID) or an explicit --resume-command.");
  const agent = await withOperatorStore(path, (store) =>
    registerOperatorAgent(store, {
      name,
      paneId: paneId ?? env.HERDR_PANE_ID,
      workspaceId: workspaceId ?? env.HERDR_WORKSPACE_ID,
      agentKind,
      cwd: cwd ?? process.cwd(),
      sessionId: session,
      resume: resumeCommand,
    }),
  );
  return { name, ...agent, instructions: OPERATOR_AUTHORITY };
}

export async function unregisterAgent({ name, env = process.env } = {}) {
  return withOperatorStore(operatorStorePath(env), (store) => {
    const existed = Boolean(store.agents[name]);
    delete store.agents[name];
    return existed;
  });
}

export async function listAgents({ env = process.env } = {}) {
  return (await readOperatorStore(operatorStorePath(env))).agents;
}

export { deliverNow as deliverOperatorNow };

export async function readRunState({ env = process.env } = {}) {
  return runState(await readOperatorStore(operatorStorePath(env)));
}

export async function changeRunState({ state, reason, from, env = process.env } = {}) {
  return withOperatorStore(operatorStorePath(env), (store) => setRunState(store, { state, reason, by: from || env.BAATON_OPERATOR || "operator" }));
}

/** One line per message for the CLI and tools. */
export function formatInbox(messages) {
  if (!messages.length) return "No operator messages.";
  return messages
    .map((message) => {
      const head = `${message.id} -> ${message.resolved?.label ?? message.target} [${message.delivery?.status}${message.delivery?.reason && message.delivery.status === "pending" ? `: ${message.delivery.reason}` : ""}] ${message.text.replace(/\s+/g, " ").slice(0, 100)}`;
      const replies = (message.replies ?? []).map((reply) => `  reply ${reply.at}${reply.from ? ` from ${reply.from}` : ""}: ${reply.text}`);
      return [head, ...replies].join("\n");
    })
    .join("\n");
}
