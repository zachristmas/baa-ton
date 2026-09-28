import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { receiptArguments } from "../lane-receipt.mjs";

test("the receipt fallback reads the lane's workflow from its startup intent and the receipt from a file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baa-lane-receipt-"));
  try {
    await writeFile(join(dir, "intent.json"), JSON.stringify({ workflowId: "herdr-553df5e1", laneId: "lane-1" }));
    await writeFile(join(dir, "receipt.txt"), "PARTIAL: rebased; demo not produced\n");
    assert.deepEqual(receiptArguments(["--summary-file", join(dir, "receipt.txt")], { BAA_STARTUP_INTENT: join(dir, "intent.json") }), { workflowId: "herdr-553df5e1", summary: "PARTIAL: rebased; demo not produced" });
    assert.throws(() => receiptArguments(["--summary", "x"], {}), /BAA_STARTUP_INTENT is not set/);
    assert.throws(() => receiptArguments([], { BAA_STARTUP_INTENT: join(dir, "intent.json") }), /--summary/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lane's MCP bridge survives a stray SIGTERM (killall node) while its session is there, and ends with its stdin", async () => {
  const bridge = fileURLToPath(new URL("../mcp-server.mjs", import.meta.url));
  const child = spawn(process.execPath, [bridge], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HERDR_ENV: "1" } });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`);
  for (let tries = 0; tries < 600 && !out.includes('"id":1'); tries += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(out, /"id":1/, "the bridge answered");
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(child.exitCode, null, "still running after SIGTERM");
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.stdin.end();
  assert.equal(await closed, 0, "exits when its session's stdin ends");
});
