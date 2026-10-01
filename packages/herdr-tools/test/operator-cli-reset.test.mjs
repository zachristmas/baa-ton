import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runOperatorCli } from "../operator-cli.mjs";
import { STATE_SUBPATH } from "../reset.mjs";

test("reset --yes applies one fingerprinted plan without a follow-up prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "baa-cli-reset-"));
  const stateDir = join(root, STATE_SUBPATH);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "manifest.json"), JSON.stringify({ version: 2, workflows: [] }));
  const output = [];
  try {
    const result = await runOperatorCli(["reset", "--project-root", root, "--yes"], { env: {}, out: (line) => output.push(line) });
    assert.equal(result.applied, true);
    assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
    assert.match(output[0], /Baa-ton reset done/);
    assert.doesNotMatch(output.join("\n"), /confirm|are you sure|proceed\?/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
