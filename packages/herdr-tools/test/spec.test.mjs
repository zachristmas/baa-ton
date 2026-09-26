import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  docxImageCount,
  finalReportPath,
  releaseShaFrom,
  specStatusTable,
  specSummaryLine,
  validateSpec,
  validateSpecState,
  verifySpec,
} from "../spec.mjs";

const item = (id, extra = {}) => ({
  id,
  title: `Item ${id}`,
  acceptance: { text: `Acceptance for ${id}.`, ...(extra.acceptance ?? {}) },
  ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "acceptance")),
});
const baseSpec = (items) => ({
  version: 1,
  target: { repo: ".", remote: "origin", branch: "feature/release" },
  stages: { build: { profile: "implementation" }, review: { profile: "review", differentFrom: "build" } },
  items,
});

/** A minimal stored (uncompressed) zip with the given entry names. */
function zip(names) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of names) {
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

test("a spec validates strictly", () => {
  const spec = validateSpec(baseSpec([
    item("I08"),
    item("I10", { dependsOn: ["I08"], owns: ["src/a/**"], migrations: 1, acceptance: { tests: ["npm test"], evidence: { report: "artifacts/i10.docx", minImages: 2 } } }),
  ]));
  assert.deepEqual(spec.defaults, { maxParallel: 4, maxBuildAttempts: 3, pushGate: "round", finalReport: "alongside", generatedArtifacts: ["**/openapi-spec.json", "packages/shared/api-clients/src/api/**"] });
  assert.equal(spec.items[1].acceptance.evidence.minImages, 2);
  assert.deepEqual(spec.items[0].acceptance.tests, []);
  for (const [bad, pattern] of [
    [{ ...baseSpec([item("A")]), extra: true }, /unsupported keys: extra/],
    [baseSpec([item("A"), item("A")]), /duplicated/],
    [baseSpec([item("A", { dependsOn: ["B"] })]), /unknown item B/],
    [baseSpec([item("A", { dependsOn: ["B"] }), item("B", { dependsOn: ["A"] })]), /dependency cycle: A -> B -> A/],
    [baseSpec([item("A", { acceptance: { evidence: { report: "../outside.docx" } } })]), /inside the target repository/],
    [baseSpec([item("A", { acceptance: { preview: ["/abs/spec.ts"] } })]), /inside the target repository/],
    [{ ...baseSpec([item("A")]), stages: { review: { profile: "review", differentFrom: "review" } } }, /another stage/],
    [{ ...baseSpec([item("A")]), stages: { ship: { profile: "x" } } }, /unsupported keys: ship/],
    [{ ...baseSpec([item("A")]), target: { repo: ".", remote: "origin", branch: "a..b" } }, /branch name/],
    [baseSpec([item("bad id!")]), /short identifier/],
    [baseSpec([]), /non-empty array/],
  ])
    assert.throws(() => validateSpec(bad), pattern);
  assert.throws(() => validateSpecState({ version: 1, items: { A: { state: "blocked" } } }), /without a reason/);
  assert.throws(() => validateSpecState({ version: 1, items: { A: { state: "shipped" } } }), /unknown state/);
  assert.deepEqual(validateSpecState(undefined), { version: 1, items: {} });
});

test("a .docx image count comes from its word/media entries", () => {
  assert.equal(docxImageCount(zip(["[Content_Types].xml", "word/document.xml", "word/media/image1.png", "word/media/image2.jpeg", "word/media/notes.txt"])), 2);
  assert.equal(docxImageCount(zip(["word/document.xml"])), 0);
  assert.equal(docxImageCount(Buffer.from("not a zip at all, just text")), undefined);
});

async function repoFixture() {
  const directory = await mkdtemp(join(tmpdir(), "baa-spec-"));
  // Isolated from the user's git config (signing, hooks, templates).
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
  const git = (...args) => execFileSync("git", ["-C", directory, ...args], { env, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const commit = async (file, text) => {
    await writeFile(join(directory, file), text);
    git("add", file);
    git("commit", "-q", "-m", file);
    return git("rev-parse", "HEAD");
  };
  return { directory, git, commit };
}

test("the verifier passes an item only when every check does, and names the first failure", async () => {
  const r = await repoFixture();
  try {
    const first = await r.commit("a.txt", "a");
    const second = await r.commit("b.txt", "b");
    r.git("update-ref", "refs/remotes/origin/feature/release", second);
    r.git("checkout", "-q", "-b", "side", first);
    const offBranch = await r.commit("c.txt", "c");
    await mkdir(join(r.directory, "artifacts"), { recursive: true });
    const { assembleDemo, TINY_PNG } = await import("../demo-report.mjs");
    const demo = assembleDemo({ steps: [{ action: "Open the page", shows: "the list", data: TINY_PNG }, { action: "Click Save", shows: "the saved row", data: TINY_PNG }] });
    const report = demo.docx;
    await writeFile(join(r.directory, "artifacts", "done.docx"), report);
    await writeFile(join(r.directory, "artifacts", "done.docx.steps.json"), JSON.stringify(demo.manifest));
    await writeFile(join(r.directory, "artifacts", "thin.docx"), zip(["word/media/image1.png"]));
    const sha256 = createHash("sha256").update(report).digest("hex");
    const spec = validateSpec(baseSpec([
      item("DONE", { acceptance: { tests: ["npm test"], preview: ["e2e/done.spec.ts"], evidence: { report: "artifacts/done.docx", minImages: 2 } } }),
      item("THIN", { acceptance: { evidence: { report: "artifacts/thin.docx", minImages: 2 } } }),
      item("OFF"),
      item("STALE", { acceptance: { tests: ["npm test"] } }),
      item("CHANGED", { acceptance: { evidence: { report: "artifacts/done.docx", minImages: 1 } } }),
      item("NEW"),
      item("WAIT"),
    ]));
    const state = validateSpecState({
      version: 1,
      items: {
        DONE: {
          state: "verifying",
          integratedSha: first,
          evidence: { sha256 },
          tests: [{ command: "npm test", sha: first, result: "pass" }],
          preview: [{ spec: "e2e/done.spec.ts", releaseSha: second, result: "pass" }],
        },
        THIN: { state: "reviewing", lane: { workflowId: "herdr-1", laneId: "lane-1" }, since: new Date(Date.now() - 5 * 60_000).toISOString() },
        OFF: { state: "integrating", integratedSha: offBranch },
        STALE: { state: "verifying", integratedSha: first, tests: [{ command: "npm test", sha: offBranch, result: "pass" }] },
        CHANGED: { state: "done", integratedSha: first, evidence: { sha256: "0".repeat(64) } },
        WAIT: { state: "blocked", blockedReason: "decision", note: "pick the migration slot" },
      },
    });
    const verification = await verifySpec(spec, state, { repo: r.directory });
    const byId = Object.fromEntries(verification.results.map((result) => [result.id, result]));
    assert.equal(verification.done, 1);
    assert.equal(byId.DONE.done, true);
    assert.deepEqual(byId.DONE.checks.map((check) => check.name), ["evidence", "integrated", "test: npm test", "preview: e2e/done.spec.ts"]);
    assert.match(byId.THIN.failing.detail, /report has 1 of 2 images/);
    assert.match(byId.OFF.failing.detail, /is not on origin\/feature\/release/);
    assert.equal(byId.STALE.failing.name, "test: npm test");
    assert.match(byId.STALE.failing.detail, /not recorded at the integrated commit/);
    assert.match(byId.CHANGED.failing.detail, /report changed since it was recorded/);
    assert.equal(byId.NEW.failing.detail, "no integrated commit recorded");

    // A preview pass on a release that does not contain the commit proves nothing.
    const notReleased = structuredClone(state);
    notReleased.items.DONE.preview[0].releaseSha = offBranch;
    notReleased.items.DONE.integratedSha = second;
    notReleased.items.DONE.tests[0].sha = second;
    const again = await verifySpec(spec, notReleased, { repo: r.directory });
    assert.equal(again.results[0].failing.name, "preview: e2e/done.spec.ts");

    const line = specSummaryLine(spec, state, verification);
    assert.equal(line, "spec 1/7 done · 1 pending · 1 reviewing · 1 integrating · 2 verifying · 1 blocked(decision)");
    const table = specStatusTable(spec, state, verification);
    assert.match(table, /^spec 1\/7 done/);
    assert.match(table, /THIN\s+reviewing\s+herdr-1\/lane-1\s+5m\s+evidence: report has 1 of 2 images/);
    assert.match(table, /WAIT\s+blocked\s+-\s+-\s+decision: pick the migration slot/);
    assert.match(table, /CHANGED\s+verifying/, "a recorded 'done' the verifier rejects is shown as verifying");
    assert.match(table, /DONE\s+done/);
  } finally {
    await rm(r.directory, { recursive: true, force: true });
  }
});

test("the verify CLI lists deferred items instead of crashing on them", async () => {
  const r = await repoFixture();
  try {
    const sha = await r.commit("a.txt", "a");
    r.git("update-ref", "refs/remotes/origin/feature/release", sha);
    await mkdir(join(r.directory, ".baa-ton", "herdr-orchestrator"), { recursive: true });
    await writeFile(join(r.directory, ".baa-ton", "spec.json"), JSON.stringify(baseSpec([item("ONE"), item("LATER")])));
    await writeFile(join(r.directory, ".baa-ton", "herdr-orchestrator", "spec-state.json"), JSON.stringify({ version: 1, items: { LATER: { state: "deferred" } } }));
    const cli = fileURLToPath(new URL("../spec.mjs", import.meta.url));
    const verify = spawnSync(process.execPath, [cli, "verify", r.directory], { encoding: "utf8" });
    assert.equal(verify.stderr, "");
    assert.equal(verify.status, 1);
    assert.equal(verify.stdout, "0/1 done\nONE: integrated: no integrated commit recorded\nLATER: deferred (not counted)\n");
    const require = createRequire(import.meta.url);
    const { default: extension } = await require("jiti")(import.meta.url).import("../index.ts");
    const tools = new Map();
    extension({ on() {}, registerCommand() {}, registerTool: (definition) => tools.set(definition.name, definition), async exec() { throw new Error("unexpected"); } });
    const result = await tools.get("herdr_spec").execute("spec", { action: "verify" }, undefined, undefined, { cwd: r.directory, mode: "json", hasUI: false, ui: { confirm: async () => false, notify() {} } });
    assert.equal(result.content[0].text, "0/1 done\nONE: integrated: no integrated commit recorded\nLATER: deferred (not counted)", "the root's tool too");
  } finally {
    await rm(r.directory, { recursive: true, force: true });
  }
});

test("the CLI and herdr_spec report the same verdict", async () => {
  const r = await repoFixture();
  try {
    const sha = await r.commit("a.txt", "a");
    r.git("update-ref", "refs/remotes/origin/feature/release", sha);
    await mkdir(join(r.directory, ".baa-ton", "herdr-orchestrator"), { recursive: true });
    await writeFile(join(r.directory, ".baa-ton", "spec.json"), JSON.stringify(baseSpec([item("ONE"), item("TWO")])));
    await writeFile(
      join(r.directory, ".baa-ton", "herdr-orchestrator", "spec-state.json"),
      JSON.stringify({ version: 1, items: { ONE: { state: "verifying", integratedSha: sha } } }),
    );
    const cli = fileURLToPath(new URL("../spec.mjs", import.meta.url));
    const verify = spawnSync(process.execPath, [cli, "verify", r.directory], { encoding: "utf8" });
    assert.equal(verify.status, 1, "not every item is done");
    assert.equal(verify.stdout, "1/2 done\nTWO: integrated: no integrated commit recorded\n");
    const status = spawnSync(process.execPath, [cli, "status", r.directory], { encoding: "utf8" });
    assert.equal(status.status, 0);
    assert.match(status.stdout, /^spec 1\/2 done · 1 pending\n/);

    const require = createRequire(import.meta.url);
    const { default: extension } = await require("jiti")(import.meta.url).import("../index.ts");
    const tools = new Map();
    extension({ on() {}, registerCommand() {}, registerTool: (definition) => tools.set(definition.name, definition), async exec() { throw new Error("unexpected"); } });
    const ctx = { cwd: r.directory, mode: "json", hasUI: false, ui: { confirm: async () => false, notify() {} } };
    const result = await tools.get("herdr_spec").execute("spec", { action: "verify" }, undefined, undefined, ctx);
    assert.equal(result.content[0].text, "1/2 done\nTWO: integrated: no integrated commit recorded");
    const none = await tools.get("herdr_spec").execute("spec", { action: "status" }, undefined, undefined, { ...ctx, cwd: tmpdir() });
    assert.equal(none.details.configured, false);
  } finally {
    await rm(r.directory, { recursive: true, force: true });
  }
});

test("release checks report the deployed SHA as JSON or text; final reports sit alongside by default", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(releaseShaFrom(JSON.stringify({ status: "ok", version: sha })), sha);
  assert.equal(releaseShaFrom(JSON.stringify({ build: { git: { commit: "ABCDEF1" } } })), "abcdef1");
  assert.equal(releaseShaFrom(JSON.stringify({ status: "ok", version: "1.4.2" })), undefined, "a semver is not a SHA");
  assert.equal(releaseShaFrom(`deployed ${sha} at 10:00`), sha);
  assert.equal(releaseShaFrom("<html>no build info</html>"), undefined);
  const alongside = validateSpec(baseSpec([item("A")]));
  const replace = validateSpec({ ...baseSpec([item("A")]), defaults: { finalReport: "replace" } });
  assert.equal(finalReportPath(alongside, "artifacts/a/evidence.docx"), "artifacts/a/evidence.final.docx");
  assert.equal(finalReportPath(alongside, "artifacts/report"), "artifacts/report.final");
  assert.equal(finalReportPath(replace, "artifacts/a/evidence.docx"), "artifacts/a/evidence.docx");
  assert.throws(() => validateSpec({ ...baseSpec([item("A")]), defaults: { finalReport: "both" } }), /finalReport/);
});

test("spec.defaults.generatedArtifacts defaults to the known generated files and accepts relative globs only", async () => {
  const base = { version: 1, target: { repo: ".", remote: "origin", branch: "b" }, items: [{ id: "A", title: "a", acceptance: { text: "a" } }] };
  assert.deepEqual(validateSpec(base).defaults.generatedArtifacts, ["**/openapi-spec.json", "packages/shared/api-clients/src/api/**"]);
  assert.deepEqual(validateSpec({ ...base, defaults: { generatedArtifacts: ["gen/**"] } }).defaults.generatedArtifacts, ["gen/**"]);
  assert.deepEqual(validateSpec({ ...base, defaults: { generatedArtifacts: [] } }).defaults.generatedArtifacts, []);
  for (const bad of [["/abs/**"], ["../x"], [""], "gen/**"]) assert.throws(() => validateSpec({ ...base, defaults: { generatedArtifacts: bad } }), /generatedArtifacts/);
});

test("a feature demo passes only with a caption beside every screenshot and one screenshot per recorded step", async () => {
  const { assembleDemo, TINY_PNG, writeDemoReport } = await import("../demo-report.mjs");
  const { docxCaptions } = await import("../spec.mjs");
  const step = (n) => ({ action: `Click control ${n}`, shows: `state ${n}`, data: TINY_PNG });
  const captioned = assembleDemo({ steps: [step(1), step(2), step(3)] });
  assert.deepEqual(docxCaptions(captioned.docx), { images: 3, uncaptioned: 0 });
  assert.deepEqual(docxCaptions(assembleDemo({ steps: [step(1), { ...step(2), captions: false }], compress: true }).docx), { images: 2, uncaptioned: 1 }, "Word-style deflated XML is read too");

  const r = await repoFixture();
  try {
    const sha = await r.commit("a.txt", "a");
    r.git("update-ref", "refs/remotes/origin/feature/release", sha);
    const artifacts = join(r.directory, "artifacts");
    await mkdir(artifacts, { recursive: true });
    const { writeFile: write } = await import("node:fs/promises");
    await write(join(artifacts, "good.docx"), captioned.docx);
    await write(join(artifacts, "good.docx.steps.json"), JSON.stringify(captioned.manifest));
    const bare = assembleDemo({ steps: [step(1), { ...step(2), captions: false }] });
    await write(join(artifacts, "bare.docx"), bare.docx);
    await write(join(artifacts, "bare.docx.steps.json"), JSON.stringify(bare.manifest));
    await write(join(artifacts, "short.docx"), captioned.docx);
    await write(join(artifacts, "short.docx.steps.json"), JSON.stringify({ version: 1, steps: [1, 2, 3, 4, 5].map((n) => ({ n, action: `step ${n}` })) }));
    await write(join(artifacts, "nosteps.docx"), captioned.docx);
    const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
    const spec = validateSpec(baseSpec([
      item("GOOD", { acceptance: { evidence: { report: "artifacts/good.docx", minImages: 3 } } }),
      item("BARE", { acceptance: { evidence: { report: "artifacts/bare.docx", minImages: 1 } } }),
      item("SHORT", { acceptance: { evidence: { report: "artifacts/short.docx", minImages: 1 } } }),
      item("NOSTEPS", { acceptance: { evidence: { report: "artifacts/nosteps.docx", minImages: 1 } } }),
    ]));
    const state = { version: 1, items: Object.fromEntries(["GOOD", "BARE", "SHORT", "NOSTEPS"].map((id) => [id, { integratedSha: sha, evidence: { sha256: hash(id === "BARE" ? bare.docx : captioned.docx) } }])) };
    const verdicts = Object.fromEntries((await verifySpec(spec, state, { repo: r.directory })).results.map((result) => [result.id, result]));
    assert.equal(verdicts.GOOD.done, true, JSON.stringify(verdicts.GOOD.failing));
    assert.match(verdicts.BARE.failing.detail, /1 of 2 screenshots have no caption/);
    assert.match(verdicts.SHORT.failing.detail, /3 screenshots for 5 recorded steps/);
    assert.match(verdicts.NOSTEPS.failing.detail, /no steps manifest beside the report/);
    void writeDemoReport;
  } finally {
    await rm(r.directory, { recursive: true, force: true });
  }
});

test("spec.defaults.evidence gives every item without its own a demo report", () => {
  const spec = validateSpec({ ...baseSpec([item("A"), item("B", { acceptance: { evidence: { report: "docs/b.docx", minImages: 4 } } })]), defaults: { evidence: { report: "artifacts/{id}-demo.docx", minImages: 3 } } });
  assert.deepEqual(spec.items[0].acceptance.evidence, { report: "artifacts/A-demo.docx", minImages: 3 });
  assert.deepEqual(spec.items[1].acceptance.evidence, { report: "docs/b.docx", minImages: 4 }, "an item's own evidence wins");
  assert.throws(() => validateSpec({ ...baseSpec([item("A")]), defaults: { evidence: { report: "artifacts/demo.docx" } } }), /must be a path containing \{id\}/);
});
