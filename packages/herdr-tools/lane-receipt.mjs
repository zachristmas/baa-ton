#!/usr/bin/env node
/**
 * File a lane's receipt when its herdr-orchestrator MCP tools are not
 * available (the bridge died: Claude Code never restarts a dead MCP server).
 * Starts a one-shot bridge (mcp-server.mjs) with the lane's own identity (its
 * shell's BAA_STARTUP_INTENT) and calls herdr_complete through it.
 *
 * Usage (from the lane's worktree):
 *   node lane-receipt.mjs --summary-file <path>
 *   node lane-receipt.mjs --summary "<text>"
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bridge = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url));

export function receiptArguments(argv, env = process.env, read = (path) => readFileSync(path, "utf8")) {
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const summary = flag("--summary") ?? (flag("--summary-file") ? read(flag("--summary-file")) : undefined);
  if (!summary?.trim()) throw new Error("Give the receipt with --summary <text> or --summary-file <path>.");
  const intentPath = env.BAA_STARTUP_INTENT;
  if (!intentPath) throw new Error("BAA_STARTUP_INTENT is not set: run this from the lane's own shell.");
  const workflowId = flag("--workflow") ?? JSON.parse(read(intentPath)).workflowId;
  if (!workflowId) throw new Error(`No workflowId in ${intentPath}.`);
  return { workflowId, summary: summary.trim() };
}

/** One JSON-RPC exchange with a fresh bridge: initialize, then herdr_complete. */
export function fileReceipt({ workflowId, summary }, { env = process.env, cwd = process.cwd(), start = () => spawn(process.execPath, [bridge], { cwd, env: { ...env, HERDR_ENV: "1" }, stdio: ["pipe", "pipe", "inherit"] }) } = {}) {
  return new Promise((resolve, reject) => {
    const child = start();
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("The one-shot bridge did not answer within 120 s."));
    }, 120_000);
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
        if (message.id === 1)
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "herdr_complete", arguments: { workflowId, summary } } })}\n`);
        if (message.id === 2) {
          clearTimeout(timer);
          child.stdin.end();
          const text = (message.result?.content ?? []).map((item) => item.text).join("\n") || message.error?.message || JSON.stringify(message);
          if (message.error || message.result?.isError) reject(new Error(text));
          else resolve(text);
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lane-receipt", version: "1" } } })}\n`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${await fileReceipt(receiptArguments(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
