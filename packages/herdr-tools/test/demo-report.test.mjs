import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TINY_PNG, createDemoRecorder, probePreviewHealth } from "../demo-report.mjs";
import { docxCaptions, docxImageCount, previewHealthProblem, validateSpec } from "../spec.mjs";
import { verifyObjective } from "../spec-driver.mjs";

test("the recorder takes one screenshot per step and writes a captioned demo with its steps manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-demo-"));
  try {
    const page = { screenshot: async ({ path }) => writeFile(path, TINY_PNG) };
    const demo = createDemoRecorder({ dir: join(directory, "steps") });
    await demo.step(page, "Open the orders page", "the empty list");
    await demo.step(page, "Click New order", "the order form");
    await demo.step(page, "Submit the form", "the saved order");
    const out = join(directory, "d24.docx");
    await demo.finish({ out, title: "D24: packing slip" });
    const buffer = await readFile(out);
    assert.equal(docxImageCount(buffer), 3);
    assert.deepEqual(docxCaptions(buffer), { images: 3, uncaptioned: 0 });
    const manifest = JSON.parse(await readFile(`${out}.steps.json`, "utf8"));
    assert.deepEqual(manifest.steps.map((step) => [step.n, step.action]), [[1, "Open the orders page"], [2, "Click New order"], [3, "Submit the form"]]);
    await assert.rejects(demo.step(page, ""), /needs its action/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the CLI builds the demo from saved screenshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-demo-cli-"));
  try {
    await writeFile(join(directory, "a.png"), TINY_PNG);
    await writeFile(join(directory, "b.png"), TINY_PNG);
    await writeFile(join(directory, "steps.json"), JSON.stringify({ steps: [{ action: "Visit", shows: "home", image: "a.png" }, { action: "Click", shows: "detail", image: "b.png" }] }));
    const cli = fileURLToPath(new URL("../demo-report.mjs", import.meta.url));
    const out = join(directory, "report.docx");
    const run = spawnSync(process.execPath, [cli, "--steps", join(directory, "steps.json"), "--out", out], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /2 captioned step/);
    assert.deepEqual(docxCaptions(await readFile(out)), { images: 2, uncaptioned: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a demo of the preview is evidence only while the preview is healthy at every screenshot (D01 passed on a crash-looping replica)", async () => {
  const response = (status, body) => async () => ({ status, text: async () => body });
  assert.deepEqual(await probePreviewHealth("https://pv.example.test/healthz", { fetchImpl: response(200, "ok"), now: () => "T" }), { url: "https://pv.example.test/healthz", status: 200, wake: false, at: "T" });
  assert.equal((await probePreviewHealth("https://pv.example.test/", { fetchImpl: response(200, "<title>Waking up...</title><h1>Waking up the preview…</h1>") })).wake, true, "a wake page served with 200");
  assert.equal((await probePreviewHealth("https://pv.example.test/healthz", { fetchImpl: response(503, "") })).status, 503);
  const down = await probePreviewHealth("https://pv.example.test/healthz", { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(down.status, 0);
  assert.match(down.error, /ECONNREFUSED/);

  const dir = await mkdtemp(join(tmpdir(), "baa-demo-health-"));
  try {
    const page = { screenshot: async ({ path }) => writeFile(path, TINY_PNG), url: () => "https://pv.example.test/admin/stores" };
    let status = 503;
    const demo = createDemoRecorder({ dir, health: "https://pv.example.test/healthz", probe: async (url) => ({ url, status, wake: false, at: "T" }) });
    await assert.rejects(demo.step(page, "Open stores", "the list"), /preview is not healthy[\s\S]*never evidence/);
    assert.equal(demo.steps.length, 0, "nothing captured while it is down");
    status = 200;
    await demo.step(page, "Open stores", "the list");
    assert.deepEqual(demo.steps[0].health, { url: "https://pv.example.test/healthz", status: 200, wake: false, at: "T" });
    assert.equal(demo.steps[0].url, "https://pv.example.test/admin/stores");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const spec = validateSpec({
    version: 1,
    target: { repo: ".", remote: "origin", branch: "main", preview: { url: "https://pv.example.test", health: "/healthz" } },
    items: [
      { id: "P", title: "Preview", acceptance: { text: "p", evidence: { report: "a/p.docx", onPreview: true } } },
      { id: "L", title: "Local", acceptance: { text: "l", evidence: { report: "a/l.docx" } } },
    ],
  });
  const [onPreview, local] = spec.items;
  const healthy = { url: "https://pv.example.test/healthz", status: 200, wake: false };
  assert.equal(previewHealthProblem(spec, onPreview, [{ n: 1, health: healthy }, { n: 2, health: healthy }]), undefined);
  assert.match(previewHealthProblem(spec, onPreview, [{ n: 1, health: healthy }, { n: 2 }]), /step 2 of this preview demo has no preview health check[\s\S]*https:\/\/pv\.example\.test\/healthz/);
  assert.match(previewHealthProblem(spec, onPreview, [{ n: 1, health: { ...healthy, status: 503 } }]), /not healthy when step 1 was captured .*503/);
  assert.match(previewHealthProblem(spec, onPreview, [{ n: 1, health: { ...healthy, wake: true } }]), /wake page when step 1/);
  assert.equal(previewHealthProblem(spec, local, [{ n: 1, url: "http://localhost:5173/" }]), undefined, "a local demo needs no preview check");
  assert.match(previewHealthProblem(spec, local, [{ n: 1, url: "https://pv.example.test/stores" }]), /no preview health check/, "a demo whose steps show the preview is a preview demo");
  assert.match(verifyObjective(spec, onPreview, { reportPath: "a/p.final.docx" }), /createDemoRecorder\(\{ dir, health: "https:\/\/pv\.example\.test\/healthz" \}\)[\s\S]*never a pass/);
  assert.doesNotMatch(verifyObjective(spec, local, { reportPath: "a/l.final.docx" }), /health:/);
  assert.throws(
    () => validateSpec({ version: 1, target: { repo: ".", remote: "origin", branch: "main" }, items: [{ id: "P", title: "P", acceptance: { text: "p", evidence: { report: "a.docx", onPreview: true } } }] }),
    /onPreview needs spec\.target\.preview/,
  );
});
