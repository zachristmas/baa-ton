/**
 * Route a lane's permission prompt to its root as a formal lane request.
 *
 * `--permission-prompt-tool` only applies to non-interactive (`-p`) runs, and
 * dispatched lanes run interactively in panes, so the PermissionRequest hook
 * does the routing instead. It opens `herdr_request kind=permission` through
 * the lane's own MCP bridge (same identity checks as the lane's tool calls):
 * an acknowledged approvalPolicy answers it at once where it matches,
 * otherwise the request reaches the root digest and the hook waits a bounded
 * time for the root's grant or deny. On timeout, or on any failure, it
 * returns no decision and Claude shows its normal prompt.
 */
import { spawn as spawnProcess } from "node:child_process";

export const DEFAULT_WAIT_MS = 10 * 60_000;
export const DEFAULT_POLL_MS = 5_000;

function requestOf(response) {
  const details = response?.structuredContent;
  return !response?.isError && details?.kind === "request" ? details.request : undefined;
}

function answer(request) {
  if (request?.status === "granted") return { behavior: "allow" };
  if (request?.status === "denied")
    return {
      behavior: "deny",
      message: `The root denied ${request.id}${request.note ? `: ${request.note}` : "."} Do not retry the same command; adjust or ask the root with herdr_request.`,
    };
  return undefined;
}

/**
 * @param {{ call: (name: string, args: object) => Promise<any>, toolName: string, input: object,
 *   waitMs?: number, pollMs?: number, sleep?: (ms: number) => Promise<void>, now?: () => number }} options
 * @returns {Promise<{ decision?: { behavior: "allow" } | { behavior: "deny", message: string }, request?: object, reason?: string }>}
 */
export async function routePermission({ call, toolName, input, waitMs = DEFAULT_WAIT_MS, pollMs = DEFAULT_POLL_MS, sleep, now = Date.now }) {
  const pause = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const opened = await call("herdr_request", { action: "open", kind: "permission", toolName, input });
  let request = requestOf(opened);
  if (!request) return { reason: opened?.content?.[0]?.text ?? "the request could not be opened" };
  const deadline = now() + waitMs;
  while (!answer(request) && now() < deadline) {
    await pause(Math.min(pollMs, Math.max(0, deadline - now())));
    const status = requestOf(await call("herdr_request", { action: "status", requestId: request.id }));
    if (status) request = status;
  }
  const decision = answer(request);
  return decision ? { decision, request } : { request, reason: "no answer before the wait ended" };
}

/**
 * A minimal MCP client for one spawned bridge process: initialize, then
 * tools/call by line-delimited JSON-RPC. Rejects on process exit.
 */
export function bridgeClient({ bridge, env, spawn = spawnProcess, callTimeoutMs = 60_000 }) {
  const child = spawn(process.execPath, [bridge], { env, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  let buffer = "";
  let nextId = 1;
  let exited;
  const failAll = (error) => {
    exited = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  child.on("error", failAll);
  child.on("exit", (code) => failAll(new Error(`bridge exited (${code})`)));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      if (exited) return reject(exited);
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`bridge call ${method} timed out`));
      }, callTimeoutMs);
      pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const ready = request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "baa-ton-permission-hook", version: "1" } });
  return {
    async call(name, args) {
      await ready;
      return request("tools/call", { name, arguments: args });
    },
    close() {
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}
