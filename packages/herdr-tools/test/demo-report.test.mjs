import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TINY_PNG, createDemoRecorder } from "../demo-report.mjs";
import { docxCaptions, docxImageCount } from "../spec.mjs";

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
