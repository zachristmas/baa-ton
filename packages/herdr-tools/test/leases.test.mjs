import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const {
  validateRuntimeConfig,
  allocateLease,
  ledgerConflicts,
  releaseLeases,
  leaseName,
  leaseLines,
  probePort,
} = await jiti.import("../leases.ts");

const config = validateRuntimeConfig({
  leases: {
    app: { kind: "port-block", size: 4, range: [3600, 3615] },
    azurite: { kind: "port-block", size: 3, range: [10000, 10008] },
    redis: { kind: "port", range: [6400, 6401] },
    postgres: { kind: "name", prefix: "cic" },
  },
  dispatchLeases: ["app", "postgres"],
  maxPerLane: { postgres: 2 },
});

let counter = 0;
const ports = (busy = []) => ({
  probe: async (port) => !busy.includes(port),
  now: () => "2026-09-23T00:00:00.000Z",
  id: () => `lease-${++counter}`,
});
const request = (laneId, resource, extra = {}) => ({
  workflowId: "herdr-ab12cd34",
  laneId,
  resource,
  grantedBy: "dispatch",
  ...extra,
});

test("config validation fails closed on bad shapes", () => {
  for (const [input, pattern] of [
    [{}, /at least one resource/],
    [{ leases: { App: { kind: "port", range: [4000, 4001] } } }, /lowercase/],
    [{ leases: { a: { kind: "port", range: [80, 90] } } }, /1024/],
    [{ leases: { a: { kind: "port-block", size: 4, range: [4000, 4001] } } }, /smaller than one block/],
    [{ leases: { a: { kind: "name", prefix: "1x" } } }, /prefix/],
    [{ leases: { a: { kind: "port", range: [4000, 4010] }, b: { kind: "port", range: [4005, 4020] } } }, /overlapping/],
    [{ leases: { a: { kind: "port", range: [4000, 4001] } }, dispatchLeases: ["b"] }, /dispatchLeases/],
    [{ leases: { a: { kind: "port", range: [4000, 4001] } }, maxPerLane: { b: 1 } }, /names no configured/],
    [{ leases: { a: { kind: "queue" } } }, /kind must be/],
  ])
    assert.throws(() => validateRuntimeConfig(input), pattern);
});

test("two lanes never receive overlapping blocks (the D13/D18 collision)", async () => {
  const ledger = [];
  const d13 = await allocateLease(ledger, config, request("d13", "app"), ports());
  const d18 = await allocateLease(ledger, config, request("d18", "app"), ports());
  assert.deepEqual(d13.lease.ports, [3600, 3601, 3602, 3603]);
  assert.deepEqual(d18.lease.ports, [3604, 3605, 3606, 3607]);
  const a13 = await allocateLease(ledger, config, request("d13", "azurite"), ports());
  const a18 = await allocateLease(ledger, config, request("d18", "azurite"), ports());
  assert.deepEqual(a13.lease.ports, [10000, 10001, 10002]);
  assert.deepEqual(a18.lease.ports, [10003, 10004, 10005]);
  assert.deepEqual(ledgerConflicts(ledger), []);
});

test("asking again returns the existing lease", async () => {
  const ledger = [];
  const first = await allocateLease(ledger, config, request("l1", "redis"), ports());
  const again = await allocateLease(ledger, config, request("l1", "redis", { grantedBy: "lane-policy" }), ports());
  assert.equal(again.created, false);
  assert.equal(again.lease.id, first.lease.id);
  assert.equal(ledger.length, 1);
});

test("slots with an outside listener are skipped", async () => {
  const ledger = [];
  const { lease } = await allocateLease(ledger, config, request("l1", "app"), ports([3602]));
  assert.deepEqual(lease.ports, [3604, 3605, 3606, 3607]);
});

test("exhaustion and per-lane limits refuse with a reason", async () => {
  const ledger = [];
  await allocateLease(ledger, config, request("l1", "redis"), ports());
  await allocateLease(ledger, config, request("l2", "redis"), ports());
  await assert.rejects(allocateLease(ledger, config, request("l3", "redis"), ports()), /No free redis slot in 6400-6401/);
  await allocateLease(ledger, config, request("l1", "postgres"), ports());
  await allocateLease(ledger, config, request("l1", "postgres", { label: "test" }), ports());
  await assert.rejects(
    allocateLease(ledger, config, request("l1", "postgres", { label: "third" }), ports()),
    /already holds 2 postgres lease\(s\) \(limit 2\)/,
  );
  await assert.rejects(allocateLease(ledger, config, request("l1", "kafka"), ports()), /Unknown lease resource "kafka"/);
});

test("released slots are reused and a conflicting ledger refuses allocation", async () => {
  const ledger = [];
  const first = await allocateLease(ledger, config, request("l1", "app"), ports());
  const released = releaseLeases(ledger, (lease) => lease.laneId === "l1", "lane closed", "t");
  assert.equal(released.length, 1);
  assert.equal(first.lease.state, "released");
  assert.equal(first.lease.releaseReason, "lane closed");
  const second = await allocateLease(ledger, config, request("l2", "app"), ports());
  assert.deepEqual(second.lease.ports, [3600, 3601, 3602, 3603]);
  ledger.push({ ...second.lease, id: "lease-hand-edit", laneId: "l9" });
  assert.match(ledgerConflicts(ledger)[0], /port 3600 is held by/);
  await assert.rejects(allocateLease(ledger, config, request("l3", "redis"), ports()), /Lease ledger has conflicts/);
});

test("names are deterministic, sanitized, labelled and bounded", () => {
  const pg = config.leases.postgres;
  assert.equal(leaseName(pg, "herdr-AB12cd34", "lane-1"), "cic_ab12cd34_lane_1");
  assert.equal(leaseName(pg, "herdr-ab12cd34", "lane-1", "test"), "cic_ab12cd34_lane_1_test");
  const short = { kind: "name", prefix: "cic", maxLength: 24 };
  const a = leaseName(short, "herdr-ab12cd34", "implement-the-whole-thing-1");
  const b = leaseName(short, "herdr-ab12cd34", "implement-the-whole-thing-2");
  assert.ok(a.length <= 24 && b.length <= 24);
  assert.notEqual(a, b, "truncated names keep distinct hash suffixes");
  assert.match(a, /^[a-z0-9_]+$/);
});

test("lease lines are compact", async () => {
  const ledger = [];
  await allocateLease(ledger, config, request("l1", "app"), ports());
  await allocateLease(ledger, config, request("l1", "postgres", { label: "test" }), ports());
  const lines = leaseLines(ledger);
  assert.match(lines[0], /^app = 3600-3603 \(lease-\d+\)$/);
  assert.match(lines[1], /^postgres:test = cic_ab12cd34_l1_test/);
});

test("the real probe sees a listener", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen({ port: 0, host: "127.0.0.1" }, resolve));
  const { port } = server.address();
  try {
    assert.equal(await probePort(port), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await probePort(port), true);
});

test("sequence leases hand out the lowest free number, padded, and never share one", async () => {
  const config = validateRuntimeConfig({ leases: { migration: { kind: "sequence", start: 56, digits: 4 } }, maxPerLane: { migration: 3 } });
  const ports = { probe: async () => true, now: () => "t" };
  const ledger = [];
  const ask = (laneId, label) => allocateLease(ledger, config, { resource: "migration", label, workflowId: "herdr-seq", laneId, grantedBy: "lane-policy" }, ports);
  const a = await ask("lane-a");
  const b = await ask("lane-b");
  const a2 = await ask("lane-a", "second");
  assert.deepEqual([a.lease.number, b.lease.number, a2.lease.number], [56, 57, 58]);
  assert.deepEqual(leaseLines([a.lease, a2.lease]), [`migration = 0056 (${a.lease.id})`, `migration:second = 0058 (${a2.lease.id})`]);
  releaseLeases(ledger, (lease) => lease.id === b.lease.id, "item integrated", "t");
  assert.equal((await ask("lane-c")).lease.number, 57, "a released number is reused");
  ledger.push({ ...a.lease, id: "lease-dup" });
  assert.deepEqual(ledgerConflicts(ledger), [`migration 56 is held by ${a.lease.id}, lease-dup`]);
  for (const [bad, pattern] of [
    [{ leases: { migration: { kind: "sequence", start: -1 } } }, /start must be/],
    [{ leases: { migration: { kind: "sequence", digits: 9 } } }, /digits must be/],
    [{ leases: { migration: { kind: "sequence", range: [1, 2] } } }, /unsupported keys: range/],
  ])
    assert.throws(() => validateRuntimeConfig(bad), pattern);
  assert.equal(validateRuntimeConfig({ leases: { m: { kind: "sequence" } } }).leases.m.start, 1);
});
