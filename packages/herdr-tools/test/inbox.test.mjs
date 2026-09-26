import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HERDR_LINK_PROTOCOL,
  MESSAGE_STATES,
  answerMessage,
  enqueueWakeHint,
  getMessage,
  makeEnvelope,
  markDelivery,
  markState,
  pendingMessages,
  reconcilePending,
  releasePermission,
  storePath,
  putMessage,
  readStore,
} from "../inbox/index.mjs";

const endpoint = (pane_id) => ({
  workspace_id: "w-test",
  pane_id,
  agent: "codex",
});

test("inbox persists herdr-link/1 envelopes, dedupes logical retries, and separates occurrences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-inbox-"));
  const path = storePath({ stateDir: directory });
  try {
    const common = {
      logicalKey: "workflow/wf/lane/a/completion",
      kind: "completion",
      from: endpoint("w-child:p1"),
      to: endpoint("w-root:p1"),
      payload: { summary: "done" },
    };
    const [first, retry] = await Promise.all([
      putMessage(path, common),
      putMessage(path, common),
    ]);
    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.message.occurrence_id, first.message.occurrence_id);
    assert.equal(first.message.envelope.protocol, HERDR_LINK_PROTOCOL);
    assert.deepEqual(first.message.envelope.from, endpoint("w-child:p1"));
    assert.deepEqual(first.message.envelope.to, endpoint("w-root:p1"));
    assert.deepEqual(
      Object.keys(first.message.states),
      MESSAGE_STATES,
      "all durable delivery states are present from creation",
    );
    assert.ok(first.message.states.stored.at);
    assert.equal(first.message.states.notified, null);

    const occurrence = await putMessage(path, {
      ...common,
      occurrenceId: "blocked-occurrence-2",
      kind: "lifecycle",
      payload: { status: "blocked" },
      dedupe: "occurrence",
    });
    assert.equal(occurrence.created, true);
    assert.notEqual(occurrence.message.occurrence_id, first.message.occurrence_id);
    assert.equal((await readStore(path)).messages.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("wake hints coalesce while each pending message remains independently reconcilable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-inbox-hints-"));
  const path = storePath({ stateDir: directory });
  try {
    const base = {
      kind: "lifecycle",
      from: endpoint("w-child:p1"),
      to: endpoint("w-root:p1"),
      dedupe: "occurrence",
    };
    const one = await putMessage(path, {
      ...base,
      logicalKey: "lane/a/blocked",
      occurrenceId: "occ-1",
      payload: { status: "blocked" },
    });
    const two = await putMessage(path, {
      ...base,
      logicalKey: "lane/a/done",
      occurrenceId: "occ-2",
      payload: { status: "done" },
    });
    const firstHint = await enqueueWakeHint(path, {
      recipient: endpoint("w-root:p1"),
      occurrenceId: one.message.occurrence_id,
    });
    const secondHint = await enqueueWakeHint(path, {
      recipient: endpoint("w-root:p1"),
      occurrenceId: two.message.occurrence_id,
    });
    assert.equal(firstHint.created, true);
    assert.equal(secondHint.created, true);
    assert.equal(firstHint.hint.id, secondHint.hint.id);
    assert.deepEqual(secondHint.hint.occurrence_ids, ["occ-1", "occ-2"]);

    const delivered = [];
    const reconciled = await reconcilePending(path, {
      recipient: endpoint("w-root:p1"),
      kinds: ["lifecycle"],
      deliver: async (message) => {
        delivered.push(message.occurrence_id);
        await markDelivery(path, message.occurrence_id, "notified");
        await markState(path, message.occurrence_id, "received");
        await markState(path, message.occurrence_id, "acknowledged");
        await markState(path, message.occurrence_id, "resolved");
        return "ok";
      },
    });
    assert.deepEqual(delivered.sort(), ["occ-1", "occ-2"]);
    assert.equal(reconciled.length, 2);
    assert.equal((await pendingMessages(path)).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("permission answers stay pending across uncertainty and release exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-inbox-permission-"));
  const path = storePath({ stateDir: directory });
  try {
    const stored = await putMessage(path, {
      logicalKey: "lane/a/permission/Bash",
      occurrenceId: "permission-1",
      kind: "permission-request",
      from: endpoint("w-child:p1"),
      to: endpoint("w-root:p1"),
      payload: { tool_name: "Bash", input: { command: "npm test" } },
    });
    const uncertain = await answerMessage(path, "permission-1", "allow", {
      uncertain: true,
    });
    assert.equal(uncertain.stored, true);
    const pending = await releasePermission(path, "permission-1");
    assert.equal(pending.pending, true);
    assert.equal(pending.uncertain, true);
    assert.equal(pending.released, false);

    await markDelivery(path, "permission-1", "acknowledged");
    const released = await releasePermission(path, "permission-1");
    assert.equal(released.released, true);
    assert.equal(released.decision.behavior, "allow");
    assert.equal(released.decision.updatedInput.command, "npm test");
    assert.equal(released.message.states.resolved !== null, true);
    const replay = await releasePermission(path, "permission-1");
    assert.equal(replay.released, false);
    assert.equal(replay.replay, true);
    assert.equal(replay.decision.behavior, "allow");
    assert.equal((await getMessage(path, stored.message.occurrence_id)).resolution.release_count, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lane in another workspace is not inbox-routable: its receipt goes through the manifest instead", async () => {
  const { inboxRoutable } = await import("../inbox/index.mjs");
  assert.equal(inboxRoutable(endpoint("w-root:p2"), endpoint("w-root:p1")), true);
  // The live failure: a lane in its worktree's workspace (w2G) reporting to the
  // root in w22. The bridge built an envelope anyway, and herdr_complete failed.
  assert.equal(inboxRoutable({ ...endpoint("w2G:p2"), workspace_id: "w2G" }, { ...endpoint("w22:p1"), workspace_id: "w22" }), false);
  assert.equal(inboxRoutable(undefined, endpoint("w-root:p1")), false);
  const { readFile: read } = await import("node:fs/promises");
  const bridge = await read(new URL("../mcp-server.mjs", import.meta.url), "utf8");
  const persist = bridge.slice(bridge.indexOf("async function persistBridgeMessage"), bridge.indexOf("async function finishBridgeMessage"));
  assert.ok(persist.indexOf("inboxRoutable(") > 0 && persist.indexOf("inboxRoutable(") < persist.indexOf("makeEnvelope("), "the bridge skips the inbox for cross-workspace routes before building an envelope");
});

test("herdr-link/1 envelope rejects cross-workspace routes", () => {
  assert.throws(
    () =>
      makeEnvelope({
        logicalKey: "cross-workspace",
        kind: "completion",
        from: endpoint("w-child:p1"),
        to: { ...endpoint("w-root:p1"), workspace_id: "w-other" },
      }),
    /same Herdr workspace/,
  );
});

