import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// A child process per run: the resolve hook is process-wide.
test("fresh imports see edited modules, including modules those import, and share modules within a version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-fresh-"));
  try {
    const pkg = join(directory, "packages", "herdr-tools");
    await mkdir(pkg, { recursive: true });
    const helper = fileURLToPath(new URL("../fresh-modules.mjs", import.meta.url));
    const hook = fileURLToPath(new URL("../fresh-modules-hook.mjs", import.meta.url));
    const { copyFile } = await import("node:fs/promises");
    await copyFile(helper, join(pkg, "fresh-modules.mjs"));
    await copyFile(hook, join(pkg, "fresh-modules-hook.mjs"));
    await writeFile(join(pkg, "leaf.mjs"), "globalThis.__leafEvals = (globalThis.__leafEvals ?? 0) + 1;\nexport const value = 1;\nexport class Shared {}\n");
    await writeFile(join(pkg, "left.mjs"), 'import { value, Shared } from "./leaf.mjs";\nexport const left = value;\nexport const L = Shared;\n');
    await writeFile(join(pkg, "right.mjs"), 'import { value, Shared } from "./leaf.mjs";\nexport const right = value;\nexport const R = Shared;\n');
    await writeFile(join(pkg, "top.mjs"), 'import { left, L } from "./left.mjs";\nimport { right, R } from "./right.mjs";\nexport const sum = left + right;\nexport const shared = L === R;\n');
    const script = `
      import { writeFileSync, utimesSync } from "node:fs";
      const { freshImport, modulesVersion } = await import(${JSON.stringify(new URL(`file://${join(pkg, "fresh-modules.mjs")}`).href)});
      const base = ${JSON.stringify(new URL(`file://${pkg}/`).href)};
      const first = await freshImport("./top.mjs", base);
      const again = await freshImport("./top.mjs", base);
      writeFileSync(${JSON.stringify(join(pkg, "leaf.mjs"))}, "globalThis.__leafEvals = (globalThis.__leafEvals ?? 0) + 1;\\nexport const value = 5;\\nexport class Shared {}\\n");
      const later = new Date(Date.now() + 5000);
      utimesSync(${JSON.stringify(join(pkg, "leaf.mjs"))}, later, later);
      const second = await freshImport("./top.mjs", base);
      console.log(JSON.stringify({ first: first.sum, sameVersionSame: first === again, shared: first.shared && second.shared, second: second.sum, leafEvals: globalThis.__leafEvals }));
    `;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim().split("\n").at(-1));
    assert.equal(result.first, 2);
    assert.equal(result.sameVersionSame, true, "one version, one module instance");
    assert.equal(result.shared, true, "a module imported twice in one graph is shared");
    assert.equal(result.second, 10, "the edited transitive import is loaded fresh");
    assert.equal(result.leafEvals, 2, "evaluated once per version");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
