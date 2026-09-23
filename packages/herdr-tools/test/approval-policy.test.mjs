import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const {
  STANDING_GRANTS,
  validateApprovalPolicy,
  approvalPolicyHash,
  outsidePolicyReason,
  standingDecision,
  authorizeStanding,
} = await jiti.import("../approval-policy.ts");

const policy = {
  version: 2,
  grants: ["dispatch", "retry", "resume", "retire", "lease", "runtime-launch"],
  runtimeLaunch: {
    commands: [
      { name: "compose", start: "docker compose -p {lane} up -d", stop: "docker compose -p {lane} down" },
      { name: "web", start: "npm run dev -- --port {lease.app[0]}" },
    ],
  },
};
const profiled = { taskProfile: "implementation", lanes: [{ id: "lane-1" }] };

test("a full policy validates and grants come back in canonical order", () => {
  const validated = validateApprovalPolicy({ ...policy, grants: [...policy.grants].reverse() });
  assert.deepEqual(validated.grants, [...STANDING_GRANTS]);
  assert.equal(validated.runtimeLaunch.commands[0].stop, "docker compose -p {lane} down");
});

test("push, merge, deploy, production, close, sweep and reparent can never be granted", () => {
  for (const grant of ["push", "merge", "deploy", "production", "close", "sweep", "reparent", "external-message"])
    assert.throws(
      () => validateApprovalPolicy({ version: 2, grants: ["dispatch", grant] }),
      /always requires explicit confirmation/,
      grant,
    );
  assert.throws(() => validateApprovalPolicy({ version: 2, grants: ["anything"] }), /cannot grant anything/);
});

test("shape errors fail closed", () => {
  for (const [input, pattern] of [
    [undefined, /must be an object/],
    [{ version: 1, grants: ["dispatch"] }, /version must be 2/],
    [{ version: 2, grants: [] }, /non-empty/],
    [{ version: 2, grants: ["dispatch", "dispatch"] }, /duplicates/],
    [{ version: 2, grants: ["dispatch"], extra: true }, /unsupported keys: extra/],
    [{ version: 2, grants: ["dispatch"], runtimeLaunch: { commands: [{ name: "x", start: "up" }] } }, /requires the runtime-launch grant/],
  ])
    assert.throws(() => validateApprovalPolicy(input), pattern);
});

test("runtime templates reject shell metacharacters and duplicate names", () => {
  for (const start of [
    "docker compose up; rm -rf /",
    "npm run dev && curl x",
    "echo $HOME",
    "echo `id`",
    "a  b",
    "run > out",
    "sh -c 'x'",
  ])
    assert.throws(
      () => validateApprovalPolicy({ version: 2, grants: ["runtime-launch"], runtimeLaunch: { commands: [{ name: "x", start }] } }),
      /no shell metacharacters/,
      start,
    );
  assert.throws(
    () => validateApprovalPolicy({
      version: 2,
      grants: ["runtime-launch"],
      runtimeLaunch: { commands: [{ name: "x", start: "a" }, { name: "x", start: "b" }] },
    }),
    /duplicated/,
  );
});

test("the hash ignores key order and formatting but not content", () => {
  const reordered = { runtimeLaunch: policy.runtimeLaunch, grants: [...policy.grants].reverse(), version: 2 };
  const a = approvalPolicyHash(validateApprovalPolicy(policy));
  assert.equal(approvalPolicyHash(validateApprovalPolicy(reordered)), a);
  assert.match(a, /^[0-9a-f]{64}$/);
  const narrower = { ...policy, grants: policy.grants.filter((grant) => grant !== "retire") };
  assert.notEqual(approvalPolicyHash(validateApprovalPolicy(narrower)), a);
});

test("dispatch is inside policy only for configured task profiles without extra MCP servers", () => {
  const validated = validateApprovalPolicy(policy);
  assert.equal(outsidePolicyReason(validated, profiled, "dispatch"), undefined);
  assert.equal(outsidePolicyReason(validated, { lanes: [{ id: "a", taskProfile: "quick" }] }, "dispatch"), undefined);
  assert.match(outsidePolicyReason(validated, { lanes: [{ id: "a" }] }, "dispatch"), /no configured taskProfile/);
  assert.match(
    outsidePolicyReason(validated, { taskProfile: "quick", lanes: [{ id: "a", launchProfile: { model: "x" } }] }, "retry"),
    /ad-hoc launchProfile/,
  );
  assert.match(
    outsidePolicyReason(validated, { taskProfile: "quick", lanes: [{ id: "a", mcpServers: { db: {} } }] }, "dispatch"),
    /extra MCP servers/,
  );
  assert.equal(outsidePolicyReason(validated, { lanes: [{ id: "a" }] }, "resume"), undefined);
  const dispatchOnly = validateApprovalPolicy({ version: 2, grants: ["dispatch"] });
  assert.match(outsidePolicyReason(dispatchOnly, profiled, "retry"), /does not grant retry/);
});

test("decisions: none, outside, needs-ack, granted", () => {
  assert.equal(standingDecision(undefined, undefined, profiled, "dispatch").kind, "none");
  const invalid = standingDecision({ version: 2, grants: ["merge"] }, undefined, profiled, "dispatch");
  assert.equal(invalid.kind, "none");
  assert.match(invalid.reason, /invalid/);
  assert.equal(standingDecision(policy, undefined, { lanes: [{ id: "a" }] }, "dispatch").kind, "outside");
  const needsAck = standingDecision(policy, undefined, profiled, "dispatch");
  assert.equal(needsAck.kind, "needs-ack");
  const ack = { hash: needsAck.hash, grants: needsAck.policy.grants, ackedAt: "t", rootPaneId: "p" };
  assert.equal(standingDecision(policy, ack, profiled, "dispatch").kind, "granted");
  const widened = { version: 2, grants: ["dispatch", "retry"] };
  assert.equal(standingDecision(widened, ack, profiled, "dispatch").kind, "needs-ack", "a changed policy needs a new ack");
});

function ports(overrides = {}) {
  const dialogs = [];
  let ack;
  return {
    dialogs,
    get stored() {
      return ack;
    },
    policy: () => policy,
    ack: async () => ack,
    interactive: true,
    confirm: async (title, message) => {
      dialogs.push({ title, message });
      return true;
    },
    now: () => "2026-09-23T00:00:00.000Z",
    rootPaneId: "w-root:p1",
    remember(result) {
      if (result.ack) ack = result.ack;
    },
    ...overrides,
  };
}

test("first routine dispatch shows one policy dialog, later ones none", async () => {
  const p = ports();
  const first = await authorizeStanding(p, profiled, "dispatch", "dispatch wf-1");
  assert.equal(first.granted, true);
  assert.equal(p.dialogs.length, 1);
  assert.match(p.dialogs[0].message, /Runs without a dialog: dispatch, retry, resume, retire, lease, runtime-launch/);
  assert.match(p.dialogs[0].message, /Always asks: push, merge, deploy, production, close, sweep, reparent/);
  assert.match(p.dialogs[0].message, /Record this policy and dispatch wf-1\?/);
  assert.deepEqual(first.evidence.map((item) => item.kind), ["approval-policy-acknowledged", "authorization-policy-granted"]);
  assert.equal(first.ack.rootPaneId, "w-root:p1");
  p.remember(first);
  const second = await authorizeStanding(p, profiled, "retry", "dispatch wf-2");
  assert.equal(second.granted, true);
  assert.equal(second.ack, undefined);
  assert.equal(p.dialogs.length, 1, "no dialog once acknowledged");
});

test("no policy configured means no evidence and the one-off dialog", async () => {
  const result = await authorizeStanding(ports({ policy: () => undefined }), profiled, "dispatch", "x");
  assert.deepEqual(result, { granted: false, evidence: [] });
});

test("an unreadable config or invalid policy falls back with evidence", async () => {
  const unreadable = await authorizeStanding(ports({ policy: () => { throw new Error("bad json"); } }), profiled, "dispatch", "x");
  assert.equal(unreadable.granted, false);
  assert.match(unreadable.evidence[0].text, /cannot read approvalPolicy: bad json/);
  const invalid = await authorizeStanding(ports({ policy: () => ({ version: 2, grants: ["deploy"] }) }), profiled, "dispatch", "x");
  assert.equal(invalid.granted, false);
  assert.equal(invalid.evidence[0].kind, "approval-policy-not-applied");
});

test("a headless root never acknowledges implicitly", async () => {
  const p = ports({ interactive: false });
  const result = await authorizeStanding(p, profiled, "dispatch", "x");
  assert.equal(result.granted, false);
  assert.equal(p.dialogs.length, 0);
  assert.match(result.evidence[0].text, /not acknowledged; run herdr_policy action=ack/);
});

test("declining the policy dialog records nothing and falls back", async () => {
  const p = ports({ confirm: async () => false });
  const result = await authorizeStanding(p, profiled, "dispatch", "x");
  assert.equal(result.granted, false);
  assert.equal(result.ack, undefined);
  assert.match(result.evidence[0].text, /acknowledgement declined/);
});

test("operations outside policy fall back without a policy dialog", async () => {
  const p = ports();
  const result = await authorizeStanding(p, { lanes: [{ id: "a" }] }, "dispatch", "x");
  assert.equal(result.granted, false);
  assert.equal(p.dialogs.length, 0);
  assert.match(result.evidence[0].text, /Standing dispatch: lane a has no configured taskProfile/);
});

test("a dirty worktree keeps the acknowledgement but falls back", async () => {
  const p = ports({ cleanWorktree: async () => { throw new Error("worktreeCwd must be clean before Herdr dispatch."); } });
  const result = await authorizeStanding(p, profiled, "dispatch", "x");
  assert.equal(result.granted, false);
  assert.ok(result.ack, "the user did confirm the policy");
  assert.match(result.evidence.at(-1).text, /must be clean/);
});
