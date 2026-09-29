import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveTaskProfile } from "../profile-config.mjs";

const launchProfile = { provider: "claude-code", model: "claude-sonnet-5", thinking: "high", auth: "subscription" };

test("a task profile's lanes run in bypassPermissions unless it names another permission mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "baa-permission-mode-"));
  try {
    await mkdir(join(cwd, ".baa-ton"));
    await writeFile(
      join(cwd, ".baa-ton", "config.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          implementation: { agentKind: "claude", launchProfile },
          review: { agentKind: "claude", permissionMode: "auto", launchProfile },
          planning: { agentKind: "claude", launchProfile: { ...launchProfile, permissionMode: "acceptEdits" } },
          quick: { agentKind: "claude", permissionMode: "yolo", launchProfile },
        },
      }),
    );
    assert.equal(resolveTaskProfile(cwd, "implementation").permissionMode, "bypassPermissions");
    assert.equal(resolveTaskProfile(cwd, "review").permissionMode, "auto");
    const planning = resolveTaskProfile(cwd, "planning");
    assert.equal(planning.permissionMode, "acceptEdits", "launchProfile.permissionMode works too");
    assert.deepEqual(Object.keys(planning.launchProfile).sort(), ["auth", "model", "provider", "thinking"], "the exact launch profile keeps its four fields");
    assert.throws(() => resolveTaskProfile(cwd, "quick"), /invalid permissionMode "yolo"/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a task profile keeps Claude's Artifact tools only when it says allowArtifact: true", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "baa-allow-artifact-"));
  try {
    await mkdir(join(cwd, ".baa-ton"));
    await writeFile(
      join(cwd, ".baa-ton", "config.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          implementation: { agentKind: "claude", launchProfile },
          review: { agentKind: "claude", allowArtifact: true, launchProfile },
          planning: { agentKind: "claude", allowArtifact: "yes", launchProfile },
        },
      }),
    );
    assert.equal(resolveTaskProfile(cwd, "implementation").allowArtifact, undefined);
    assert.equal(resolveTaskProfile(cwd, "review").allowArtifact, true);
    assert.throws(() => resolveTaskProfile(cwd, "planning"), /invalid allowArtifact/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
