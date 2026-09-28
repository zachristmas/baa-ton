import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TINY_PNG, createDemoRecorder, healthUrlFor, probePreviewHealth } from "../demo-report.mjs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
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
  assert.match(verifyObjective(spec, onPreview, { reportPath: "a/p.final.docx" }), /step 1 included[\s\S]*createDemoRecorder\(\{ dir: "<steps dir>", previewUrl: "https:\/\/pv\.example\.test\/healthz" \}\)[\s\S]*--record <steps\.json>[\s\S]*never a pass/);
  assert.doesNotMatch(verifyObjective(spec, local, { reportPath: "a/l.final.docx" }), /health:/);
  assert.throws(
    () => validateSpec({ version: 1, target: { repo: ".", remote: "origin", branch: "main" }, items: [{ id: "P", title: "P", acceptance: { text: "p", evidence: { report: "a.docx", onPreview: true } } }] }),
    /onPreview needs spec\.target\.preview/,
  );
});

test("a preview demo can not skip the health check: the recorder checks a deployed page's own host with no option, and the CLI records and requires it per step", async () => {
  assert.equal(healthUrlFor({ previewUrl: "https://pv.example.test/" }), "https://pv.example.test/");
  assert.equal(healthUrlFor({ pageUrl: "https://ca-preview.example.test/admin/stores?x=1" }), "https://ca-preview.example.test/", "a deployed page, no option: its own origin");
  assert.equal(healthUrlFor({ pageUrl: "http://localhost:5173/stores" }), undefined, "a local stack needs no preview check");
  assert.equal(healthUrlFor({ pageUrl: "http://192.168.1.20:3000/" }), undefined);

  const dir = await mkdtemp(join(tmpdir(), "baa-demo-auto-"));
  let body = "<title>GlobalShop</title>";
  let status = 200;
  const server = createServer((request, response) => {
    response.writeHead(status, { "content-type": "text/html" });
    response.end(body);
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const preview = `http://127.0.0.1:${server.address().port}/`;
  const tool = fileURLToPath(new URL("../demo-report.mjs", import.meta.url));
  // Async: the preview server answers from this same process.
  const run = (...args) => new Promise((resolveRun) => execFile(process.execPath, [tool, ...args], { cwd: dir, encoding: "utf8" }, (error, stdout, stderr) => resolveRun({ status: error ? (error.code ?? 1) : 0, stdout, stderr })));
  try {
    // Recorder with previewUrl: step 1 is checked like every other.
    const checks = [];
    const page = { screenshot: async ({ path }) => writeFile(path, TINY_PNG), url: () => "https://pv.example.test/admin" };
    const demo = createDemoRecorder({ dir: join(dir, "rec"), previewUrl: "https://pv.example.test/", probe: async (url) => (checks.push(url), { url, status: 200, wake: false, at: "T" }) });
    await demo.step(page, "Open admin", "the dashboard");
    assert.deepEqual(checks, ["https://pv.example.test/"]);
    assert.equal(demo.steps[0].health.status, 200);
    // No option at all, a deployed page: still checked.
    const auto = createDemoRecorder({ dir: join(dir, "auto"), probe: async (url) => (checks.push(url), { url, status: 503, wake: false, at: "T" }) });
    await assert.rejects(auto.step(page, "Open admin", "x"), /not healthy/);
    assert.equal(checks.at(-1), "https://pv.example.test/");

    // CLI: --record checks at capture; --steps --preview-url refuses unchecked steps.
    await writeFile(join(dir, "s1.png"), TINY_PNG);
    await writeFile(join(dir, "s2.png"), TINY_PNG);
    let result = await run("--record", "steps/steps.json", "--image", "s1.png", "--action", "Open stores", "--shows", "the list", "--url", `${preview}stores`, "--preview-url", preview);
    assert.equal(result.status, 0, result.stderr);
    body = "<title>Waking up...</title><h1>Waking up the preview…</h1>";
    result = await run("--record", "steps/steps.json", "--image", "s2.png", "--action", "Open orders", "--preview-url", preview);
    assert.notEqual(result.status, 0, "a wake page is refused at capture");
    assert.match(result.stderr, /not healthy[\s\S]*a wake page/);
    body = "ok";
    result = await run("--record", "steps/steps.json", "--image", "s2.png", "--action", "Open orders", "--preview-url", preview);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(join(dir, "steps", "steps.json"), "utf8"));
    assert.deepEqual(manifest.steps.map((step) => [step.image, step.health.status, step.health.wake]), [["../s1.png", 200, false], ["../s2.png", 200, false]]);
    result = await run("--steps", "steps/steps.json", "--out", "out/demo.docx", "--preview-url", preview);
    assert.equal(result.status, 0, result.stderr);
    const written = JSON.parse(await readFile(join(dir, "out", "demo.docx.steps.json"), "utf8"));
    assert.ok(written.steps.every((step) => step.health?.status === 200), "the checks travel into the report's manifest");

    // Screenshots taken without the check: the report is refused.
    await writeFile(join(dir, "bare.json"), JSON.stringify({ steps: [{ action: "Open", image: "s1.png" }] }));
    result = await run("--steps", "bare.json", "--out", "out/bare.docx", "--preview-url", preview);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /step 1 has no healthy preview check from its capture[\s\S]*--record/);
    await writeFile(join(dir, "deployed.json"), JSON.stringify({ steps: [{ action: "Open", image: "s1.png", url: "https://pv.example.test/x" }] }));
    assert.notEqual((await run("--steps", "deployed.json", "--out", "out/d.docx")).status, 0, "a step on a deployed host needs it even without --preview-url");
    await writeFile(join(dir, "local.json"), JSON.stringify({ steps: [{ action: "Open", image: "s1.png", url: "http://localhost:5173/" }] }));
    assert.equal((await run("--steps", "local.json", "--out", "out/l.docx")).status, 0, "a local demo builds as before");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
