import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { demoPinLines, findDemoPins } from "../demo-pins.mjs";

test("an item's own demo scripts' pinned ports and database are found and handed to its lane (D03 stalled on a lease mismatch)", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "baa-demo-pins-"));
  try {
    await mkdir(join(worktree, "scripts", "demo-d03"), { recursive: true });
    await mkdir(join(worktree, "scripts", "demo-d30"), { recursive: true });
    await writeFile(join(worktree, "scripts", "demo-d03", "guard.mjs"), "const GATEWAY_PORT = 3700;\nconst url = 'postgres://demo:demo@localhost:5432/gsd_demo_store_create_20260921';\nfetch('http://localhost:3719/health');\n");
    await writeFile(join(worktree, "scripts", "demo-d03", "lane-config.sh"), "export BACKOFFICE_PORT=3719\nexport DB_NAME=gsd_demo_store_create_20260921\n");
    await writeFile(join(worktree, "scripts", "demo-d30", "lane-config.sh"), "export PORT=4999\n");
    const pins = findDemoPins(worktree, "D03");
    assert.deepEqual(pins, { dirs: ["scripts/demo-d03"], ports: [3700, 3719, 5432], databases: ["gsd_demo_store_create_20260921"] });
    const [line] = demoPinLines(pins);
    assert.match(line, /scripts\/demo-d03\) pin ports 3700, 3719, 5432 and database gsd_demo_store_create_20260921/);
    assert.match(line, /Do not edit the demo scripts to use leased values, and do not stop over a lease mismatch/);
    assert.equal(findDemoPins(worktree, "D07"), undefined, "no demo scripts, no pins");
    assert.deepEqual(demoPinLines(undefined), []);
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});
