import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPiModelRegistry, findPiPackageRoot } from "../pi-model-registry.mjs";

test("the registry comes from the nearest installed pi-coding-agent, created without a refresh", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-reg-"));
  try {
    const pkg = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    await mkdir(join(pkg, "dist", "core"), { recursive: true });
    await writeFile(join(pkg, "package.json"), "{}");
    await writeFile(join(pkg, "dist", "core", "model-runtime.js"), "export const ModelRuntime = { create: async (o) => ({ options: o }) };");
    await writeFile(join(pkg, "dist", "core", "model-registry.js"), "export class ModelRegistry { constructor(rt) { this.rt = rt; } }");
    const nested = join(dir, "a", "b");
    await mkdir(nested, { recursive: true });
    assert.equal(findPiPackageRoot(nested), pkg);
    const registry = await createPiModelRegistry(nested);
    assert.deepEqual(registry.rt.options, { refreshOnCreate: false });
    await assert.rejects(createPiModelRegistry(tmpdir() + "/none-x"), /not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
