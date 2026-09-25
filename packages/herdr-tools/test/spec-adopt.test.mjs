import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { adoptSpec, adoptionTable, globToRegExp, isSecretPath, itemOwnedChanges, proposeAdoption } from "../spec-adopt.mjs";
import { specSummaryLine, validateSpec, verifySpec } from "../spec.mjs";

function docx(images) {
  const names = ["word/document.xml", ...Array.from({ length: images }, (_, index) => `word/media/image${index + 1}.png`)];
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of names) {
    const bytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(bytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(bytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, bytes);
    centrals.push(central, bytes);
    offset += 30 + bytes.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("secret-looking files are never staged, tracked or not", () => {
  for (const path of ["config/app.secret.json", "SECRETS.md", ".env", ".env.local", "apps/web/.env.production", "lane-a.lane-secrets.json"])
    assert.equal(isSecretPath(path), true, path);
  for (const path of ["src/environment.ts", "docs/envelope.md", "src/secretary/x.ts".replace("secretary/", "sec/"), "README.md"])
    assert.equal(isSecretPath(path), false, path);
  const porcelain = [
    " M src/orders/checkout.ts",
    "?? src/orders/new-rule.ts",
    "?? src/orders/.env.local",
    "?? src/orders/db.lane-secrets.json",
    " M src/admin/other.ts",
    "R  src/orders/old.ts -> src/orders/renamed.ts",
    '?? "src/orders/with space.ts"',
  ].join("\n");
  assert.deepEqual(itemOwnedChanges(porcelain, ["src/orders/**"]), {
    paths: ["src/orders/checkout.ts", "src/orders/new-rule.ts", "src/orders/renamed.ts", "src/orders/with space.ts"],
    secrets: ["src/orders/.env.local", "src/orders/db.lane-secrets.json"],
    outside: ["src/admin/other.ts"],
  });
  // Shared files the item touches are committed too, by explicit path.
  const shared = [" M src/orders/a.ts", " M db/migrations/meta/_journal.json", " M api/openapi.yaml", " M .gitignore", "?? artifacts/run-1/log.txt"].join("\n");
  assert.deepEqual(itemOwnedChanges(shared, ["src/orders/**"], ["db/migrations/meta/_journal.json", "api/*.yaml", ".gitignore"]), {
    paths: ["src/orders/a.ts", "db/migrations/meta/_journal.json", "api/openapi.yaml", ".gitignore"],
    secrets: [],
    outside: ["artifacts/run-1/log.txt"],
  });
  // No owns: commit nothing; every change goes to the root.
  assert.deepEqual(itemOwnedChanges(" M a.ts\n?? artifacts/x.png\n?? .env", [], ["a.ts"]), { paths: [], secrets: [".env"], outside: ["a.ts", "artifacts/x.png"] });
  assert.equal(globToRegExp("src/**/*.ts").test("src/a/b/c.ts"), true);
  assert.equal(globToRegExp("src/**/*.ts").test("src/c.ts"), true);
  assert.equal(globToRegExp("src/*.ts").test("src/a/c.ts"), false);
});

async function projectFixture() {
  const directory = await mkdtemp(join(tmpdir(), "baa-adopt-"));
  const project = join(directory, "project");
  const artifacts = join(directory, "artifacts");
  await mkdir(join(project, ".baa-ton", "herdr-orchestrator"), { recursive: true });
  await mkdir(artifacts, { recursive: true });
  const report = docx(3);
  await writeFile(join(artifacts, "r-report.docx"), report);
  await writeFile(join(artifacts, "i-report.docx"), docx(2));
  const receipt = (summary) => ({ id: "r", summary, delivery: "delivered" });
  const spec = {
    version: 1,
    target: { repo: ".", remote: "origin", branch: "feature/release" },
    items: [
      { id: "DEF", title: "Deferred", acceptance: { text: "Deferred to the next release." } },
      { id: "ACC", title: "Accepted", owns: ["src/acc/**"], adopt: { worktree: join(directory, "wt-acc"), branch: "demo/acc", accepted: true }, acceptance: { text: "a" } },
      { id: "REV", title: "Reviewed", owns: ["src/rev/**"], adopt: { workflow: "herdr-built", review: "herdr-review" }, acceptance: { text: "r" } },
      { id: "LIVE", title: "Live", owns: ["src/live/**"], adopt: { worktree: join(directory, "wt-live"), branch: "demo/live", workflow: "herdr-live" }, acceptance: { text: "l" } },
      {
        id: "RPT",
        title: "Report only",
        owns: ["src/rpt/**"],
        adopt: { worktree: join(directory, "wt-rpt"), branch: "demo/rpt", report: join(artifacts, "r-report.docx") },
        acceptance: { text: "p", evidence: { report: "artifacts/rpt.docx", minImages: 2 } },
      },
      { id: "NEW", title: "Nothing yet", owns: ["src/new/**"], acceptance: { text: "n" } },
      { id: "GONE", title: "Missing", owns: ["src/gone/**"], adopt: { workflow: "herdr-missing", report: join(artifacts, "none.docx") }, acceptance: { text: "g" } },
    ],
  };
  const manifest = {
    version: 2,
    workflows: [
      { id: "herdr-built", status: "completed", lanes: [{ id: "lane-1", status: "completion-reported", completionReceipt: receipt("Committed on demo/rev.") }] },
      { id: "herdr-review", status: "completed", lanes: [{ id: "lane-1", status: "completion-reported", completionReceipt: receipt("VERDICT: PASS\nLooks right.") }] },
      { id: "herdr-live", status: "running", lanes: [{ id: "lane-1", status: "working" }] },
    ],
  };
  await writeFile(join(project, ".baa-ton", "spec.json"), JSON.stringify(spec));
  await writeFile(join(project, ".baa-ton", "herdr-orchestrator", "manifest.json"), JSON.stringify(manifest));
  return { directory, project, artifacts, report, spec, manifest };
}

test("each item gets its starting state from the work that exists", async () => {
  const f = await projectFixture();
  try {
    const spec = validateSpec(f.spec);
    const { state, rows } = await proposeAdoption({ spec, manifest: f.manifest, repo: f.project, now: "2026-09-24T12:00:00.000Z" });
    const states = Object.fromEntries(Object.entries(state.items).map(([id, record]) => [id, record.state]));
    assert.deepEqual(states, { DEF: "deferred", ACC: "integrating", REV: "integrating", LIVE: "building", RPT: "reviewing", NEW: "pending", GONE: "pending" });
    assert.deepEqual(state.items.LIVE.lane, { workflowId: "herdr-live", laneId: "lane-1" }, "attached to the live legacy lane");
    assert.equal(state.items.LIVE.branch, "demo/live");
    assert.equal(state.items.ACC.worktree, join(f.directory, "wt-acc"));
    assert.deepEqual(state.items.RPT.evidence, {
      path: join(f.artifacts, "r-report.docx"),
      sha256: createHash("sha256").update(f.report).digest("hex"),
      images: 3,
      adoptedAt: "2026-09-24T12:00:00.000Z",
    });
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    assert.match(byId.REV.reason, /VERDICT: PASS/);
    assert.deepEqual(byId.GONE.warnings, ["workflow herdr-missing is not in the manifest", `report ${join(f.artifacts, "none.docx")} is missing`]);
    assert.equal(state.items.GONE.history[0].from, "adopt");
    const table = adoptionTable(rows);
    assert.match(table, /^adopt 7 item\(s\): 1 deferred · 2 integrating · 1 building · 1 reviewing · 2 pending/);
    assert.match(table, /LIVE\s+building\s+attached to live workflow herdr-live\/lane-1/);
    assert.match(table, /\[warning: workflow herdr-missing is not in the manifest/);

    // The verifier accepts the absolute adopted report and leaves deferred items out of M.
    const verification = await verifySpec(spec, state, { repo: f.project, ancestor: async () => false });
    assert.equal(verification.total, 6);
    assert.equal(verification.deferred, 1);
    const rpt = verification.results.find((result) => result.id === "RPT");
    assert.deepEqual(rpt.checks[0], { name: "evidence", ok: true, detail: "3 images, hash matches" });
    assert.match(specSummaryLine(spec, state, verification), /^spec 0\/6 done · 1 pending|^spec 0\/6 done/);
    assert.match(specSummaryLine(spec, state, verification), /1 deferred$/);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("adopt writes under the lock, never over a running state, and the CLI dry run writes nothing", async () => {
  const f = await projectFixture();
  const statePath = join(f.project, ".baa-ton", "herdr-orchestrator", "spec-state.json");
  try {
    const cli = fileURLToPath(new URL("../spec.mjs", import.meta.url));
    const dry = spawnSync(process.execPath, [cli, "adopt", f.project, "--dry-run"], { encoding: "utf8" });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /^adopt 7 item\(s\):/);
    assert.match(dry.stdout, /Dry run: nothing written\.\n$/);
    await assert.rejects(stat(statePath), /ENOENT/);

    const written = await adoptSpec({ cwd: f.project });
    assert.equal(written.written, true);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).items.LIVE.state, "building");
    await assert.rejects(adoptSpec({ cwd: f.project }), /already tracks 7 item\(s\); adopt only starts a run/);
    assert.equal((await adoptSpec({ cwd: f.project, force: true })).written, true);
    await assert.rejects(stat(join(f.project, ".baa-ton", "herdr-orchestrator", ".manifest.json.herdr-orchestrator.lock")), /ENOENT/, "the lock is released");
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("the adopt field is validated strictly", () => {
  const base = (adopt) => ({ version: 1, target: { repo: ".", remote: "origin", branch: "b" }, items: [{ id: "A", title: "a", acceptance: { text: "a" }, adopt }] });
  assert.equal(validateSpec(base({ worktree: "/abs/wt", branch: "demo/a", report: "/abs/r.docx", workflow: "herdr-1", review: "herdr-2", accepted: false })).items[0].adopt.branch, "demo/a");
  for (const [adopt, pattern] of [
    [{ worktree: "relative/wt", branch: "demo/a" }, /absolute path/],
    [{ report: "/abs/../escape.docx" }, /absolute path/],
    [{ worktree: "/abs/wt" }, /needs adopt\.branch/],
    [{ branch: "main" }, /feature branch/],
    [{ workflow: "herdr 1" }, /workflow id/],
    [{ accepted: "yes" }, /true or false/],
    [{ extra: 1 }, /unsupported keys: extra/],
  ])
    assert.throws(() => validateSpec(base(adopt)), pattern);
});
