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
  assert.deepEqual(spec.defaults, { maxParallel: 4, maxBuildAttempts: 3, pushGate: "round", finalReport: "alongside" });
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
    const report = zip(["word/document.xml", "word/media/image1.png", "word/media/image2.png"]);
    await writeFile(join(r.directory, "artifacts", "done.docx"), report);
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
