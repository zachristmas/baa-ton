import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const {
  requestPayload,
  requestSummary,
  requestKey,
  expandTemplate,
  matchRuntimeCommand,
  plainCommandTokens,
  openRequests,
  retireStopCommands,
} = await jiti.import("../lane-requests.ts");
const { validateApprovalPolicy } = await jiti.import("../approval-policy.ts");

const policy = validateApprovalPolicy({
  version: 2,
  grants: ["runtime-launch", "lease"],
  runtimeLaunch: {
    commands: [
      { name: "compose", start: "docker compose -p {lane} up -d", stop: "docker compose -p {lane} down" },
      { name: "web", start: "npm run dev -- --port {lease.app[1]} --db {lease.postgres}" },
      { name: "azurite", start: "azurite --blobPort {lease.azurite:blob[0]} --location .azurite-{workflow}" },
    ],
  },
});
const lease = (resource, extra) => ({ id: `lease-${resource}`, resource, label: "default", state: "active", workflowId: "wf-1", laneId: "lane-a", ...extra });
const context = {
  workflowId: "wf-1",
  laneId: "lane-a",
  leases: [
    lease("app", { ports: [3610, 3611] }),
    lease("postgres", { name: "cic_wf1_lane_a" }),
    lease("azurite", { label: "blob", ports: [10070, 10071, 10072] }),
  ],
};

test("payloads are validated and bounded per kind", () => {
  assert.deepEqual(requestPayload("lease", { resource: "app", label: "test" }), { resource: "app", label: "test" });
  assert.deepEqual(requestPayload("runtime-launch", { command: "  npm run dev  " }), { command: "npm run dev" });
  assert.deepEqual(requestPayload("approval", { text: "Run the migration" }), { text: "Run the migration" });
  assert.deepEqual(
    requestPayload("permission", { toolName: "Bash", input: { command: "ls" } }),
    { toolName: "Bash", input: { command: "ls" } },
  );
  assert.throws(() => requestPayload("lease", {}), /needs resource/);
  assert.throws(() => requestPayload("runtime-launch", { command: " " }), /exact command/);
  assert.throws(() => requestPayload("runtime-launch", { command: "x".repeat(501) }), /at most 500/);
  assert.throws(() => requestPayload("approval", { text: "x".repeat(2001) }), /at most 2000/);
  assert.throws(() => requestPayload("permission", { toolName: "Bash" }), /toolName and input/);
});

test("summaries are one line and keys identify identical requests", () => {
  assert.equal(requestSummary("lease", { resource: "app", label: "test" }), "lease app:test");
  assert.equal(requestSummary("runtime-launch", { command: "use ports\n3610/3611 and launch" }), "runtime launch: use ports 3610/3611 and launch");
  assert.equal(requestSummary("permission", { toolName: "Bash", input: { command: "npm run dev" } }), "permission Bash: npm run dev");
  assert.equal(requestKey("lease", { resource: "app" }), requestKey("lease", { resource: "app" }));
  assert.notEqual(requestKey("lease", { resource: "app" }), requestKey("lease", { resource: "redis" }));
});

test("templates expand only with this lane's leases", () => {
  assert.equal(expandTemplate("docker compose -p {lane} up -d", context), "docker compose -p lane-a up -d");
  assert.equal(
    expandTemplate("npm run dev -- --port {lease.app[1]} --db {lease.postgres}", context),
    "npm run dev -- --port 3611 --db cic_wf1_lane_a",
  );
  assert.equal(expandTemplate("x {lease.redis}", context), undefined, "no redis lease");
  assert.equal(expandTemplate("x {lease.app[5]}", context), undefined, "no such port");
  assert.equal(expandTemplate("x {lease.postgres[0]}", context), undefined, "names have no index");
  assert.equal(expandTemplate("x {secret}", context), undefined, "unknown placeholder");
});

test("runtime commands match start or stop exactly for this lane", () => {
  assert.deepEqual(
    matchRuntimeCommand(policy, "docker compose -p lane-a up -d", context)?.template.name,
    "compose",
  );
  assert.equal(matchRuntimeCommand(policy, "docker  compose -p lane-a down", context)?.phase, "stop");
  assert.equal(
    matchRuntimeCommand(policy, "npm run dev -- --port 3611 --db cic_wf1_lane_a", context)?.template.name,
    "web",
  );
  assert.equal(
    matchRuntimeCommand(policy, "azurite --blobPort 10070 --location .azurite-wf-1", context)?.template.name,
    "azurite",
  );
  for (const command of [
    "npm run dev -- --port 3604 --db cic_wf1_lane_a",
    "docker compose -p lane-b up -d",
    "docker compose -p lane-a up -d && rm -rf /",
    "docker compose -p lane-a up -d; curl x",
    "docker compose -p lane-a up",
    "sudo docker compose -p lane-a up -d",
  ])
    assert.equal(matchRuntimeCommand(policy, command, context), undefined, command);
  const noGrant = validateApprovalPolicy({ version: 2, grants: ["lease"] });
  assert.equal(matchRuntimeCommand(noGrant, "docker compose -p lane-a up -d", context), undefined);
});

test("shell syntax never tokenizes", () => {
  assert.deepEqual(plainCommandTokens(" npm  run dev "), ["npm", "run", "dev"]);
  for (const command of ["a | b", "a > b", "$(x)", "`x`", "a 'b'", "a \"b\"", "a*", "~/x", "a\\b"])
    assert.equal(plainCommandTokens(command), undefined, command);
});

test("open requests come oldest first", () => {
  const requests = [
    { id: "b", status: "open", requestedAt: "2026-09-23T10:00:01Z" },
    { id: "a", status: "open", requestedAt: "2026-09-23T10:00:00Z" },
    { id: "c", status: "granted", requestedAt: "2026-09-23T09:00:00Z" },
  ];
  assert.deepEqual(openRequests(requests).map((request) => request.id), ["a", "b"]);
});

test("a retiring lane stops exactly the templates it was granted, once each", () => {
  const granted = (id, template, extra = {}) => ({ id, laneId: "lane-a", status: "granted", template, requestedAt: "t", ...extra });
  const requests = [
    granted("r1", "compose:start"),
    granted("r2", "compose:start"),
    granted("r3", "web:start"),
    granted("r4", "compose:stop"),
    granted("r5", "azurite:start", { laneId: "lane-b" }),
    { id: "r6", laneId: "lane-a", status: "open", template: "azurite:start", requestedAt: "t" },
  ];
  assert.deepEqual(retireStopCommands(policy, requests, context), [["docker", "compose", "-p", "lane-a", "down"]]);
  assert.deepEqual(retireStopCommands(undefined, requests, context), []);
});
