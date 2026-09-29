import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSetupConfig,
  configureSkillContent,
  configureSkillPath,
  endSkillContent,
  endSkillPath,
  installProjectSkills,
  replacedSkillsNotice,
  resetSkillContent,
  resetSkillPath,
  instructionCandidates,
  managedReferenceBlock,
  portableBaaReference,
  startSkillContent,
  startSkillPath,
  sweepSkillContent,
  sweepSkillPath,
  uninstallSkillContent,
  uninstallSkillPath,
  updateSkillContent,
  updateSkillPath,
  updateManagedReference,
} from "../setup.mjs";
import { resolveTaskProfile, taskProfileConfigPath } from "../profile-config.mjs";
import { EXIT_COMMANDS } from "../root-relaunch.mjs";

test("managed BAA references are idempotent and replace stale paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-setup-"));
  try {
    const path = join(directory, "AGENTS.md");
    await writeFile(path, "# Project\n\nExisting instructions.\n");
    updateManagedReference(path, join(directory, "one", "BAA.md"));
    const first = await readFile(path, "utf8");
    assert.match(first, /`one\/BAA\.md`/);
    updateManagedReference(path, join(directory, "BAA.md"));
    const second = await readFile(path, "utf8");
    assert.match(second, /`BAA\.md`/);
    assert.doesNotMatch(second, /one\/BAA\.md/);
    assert.doesNotMatch(second, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    updateManagedReference(path, join(directory, "BAA.md"));
    assert.equal(await readFile(path, "utf8"), second);
    assert.equal(second.match(/baa-ton:start/g).length, 1);
    assert.match(second, /Existing instructions\./);
    assert.match(second, new RegExp(managedReferenceBlock("BAA.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(second, /explicitly selected Herdr orchestration session/);
    assert.match(second, /Otherwise ignore it\./);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup config preserves exact user profiles while adding defaults", async () => {
  const defaults = {
    profiles: {
      planning: {
        description: "Plan.",
        readOnly: true,
        thinking: "high",
        costPreference: "medium",
        contextPreference: "large",
        preferredHarnesses: ["claude"],
      },
    },
  };
  const config = buildSetupConfig({
    projectRoot: "/project",
    baaPath: "/install/BAA.md",
    detected: [{ id: "claude", label: "Claude Code", binary: "claude", detected: { location: "/bin/claude", version: "test" } }],
    selected: ["claude"],
    instructionFiles: ["/project/CLAUDE.md"],
    defaults,
  });
  assert.deepEqual(config.selectedHarnesses, ["claude"]);
  assert.equal(config.profiles.planning.readOnly, true);
});

test("selected harnesses receive idempotent project-local start skills", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-skills-"));
  try {
    const selected = ["pi", "claude", "codex", "opencode"];
    assert.equal(
      startSkillPath(directory, "pi"),
      join(directory, ".pi", "skills", "baa-ton-start", "SKILL.md"),
    );
    const first = installProjectSkills({
      projectRoot: directory,
      selected,
      baaPath: join(directory, "BAA.md"),
    });
    assert.equal(first.length, selected.length * 7);
    assert.deepEqual(first.map((skill) => skill.skipped), Array(selected.length * 7).fill(false));
    for (const harness of selected) {
      const skills = [
        [startSkillPath(directory, harness), startSkillContent({ harness, baaPath: join(directory, "BAA.md"), projectRoot: directory }), "baa-ton-start"],
        [configureSkillPath(directory, harness), configureSkillContent({ baaPath: join(directory, "BAA.md"), projectRoot: directory }), "baa-ton-configure"],
        [updateSkillPath(directory, harness), updateSkillContent({ projectRoot: directory }), "baa-ton-update"],
        [uninstallSkillPath(directory, harness), uninstallSkillContent(), "baa-ton-uninstall"],
        [sweepSkillPath(directory, harness), sweepSkillContent(), "baa-ton-sweep"],
        [resetSkillPath(directory, harness), resetSkillContent({ projectRoot: directory }), "baa-ton-reset"],
        [endSkillPath(directory, harness), endSkillContent({ harness }), "baa-ton-end"],
      ];
      for (const [path, expected, name] of skills) {
        const content = await readFile(path, "utf8");
        assert.match(content, new RegExp(`name: ${name}`));
        assert.equal(content, expected);
      }
    }
    const second = installProjectSkills({
      projectRoot: directory,
      selected,
      baaPath: join(directory, "BAA.md"),
    });
    assert.deepEqual(second.map((skill) => skill.changed), Array(selected.length * 7).fill(false));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rerunning the wizard removes the owned legacy setup skill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-start-migration-"));
  const legacyPath = join(directory, ".claude", "skills", "baa-ton-setup", "SKILL.md");
  try {
    await mkdir(join(directory, ".claude", "skills", "baa-ton-setup"), { recursive: true });
    await writeFile(
      legacyPath,
      "<!-- baa-ton:setup-skill:start -->\nlegacy\n<!-- baa-ton:setup-skill:end -->\n",
    );
    installProjectSkills({
      projectRoot: directory,
      selected: ["claude"],
      baaPath: join(directory, "BAA.md"),
    });
    await assert.rejects(() => readFile(legacyPath, "utf8"), { code: "ENOENT" });
    assert.match(await readFile(startSkillPath(directory, "claude"), "utf8"), /name: baa-ton-start/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("baa-ton-end uses current supported discovery and invocation metadata for each harness", () => {
  // Current docs checked 2026-09-30: https://code.claude.com/docs/en/skills,
  // https://developers.openai.com/codex/skills/, https://opencode.ai/docs/skills/ and /docs/tui/;
  // Pi's installed docs/skills.md. Codex project discovery is .agents/skills (not .codex/skills).
  const directory = "/project";
  const expectedPaths = {
    claude: join(directory, ".claude", "skills", "baa-ton-end", "SKILL.md"),
    codex: join(directory, ".agents", "skills", "baa-ton-end", "SKILL.md"),
    opencode: join(directory, ".opencode", "skills", "baa-ton-end", "SKILL.md"),
    pi: join(directory, ".pi", "skills", "baa-ton-end", "SKILL.md"),
  };
  for (const [harness, path] of Object.entries(expectedPaths)) {
    const skill = endSkillContent({ harness });
    assert.equal(endSkillPath(directory, harness), path);
    assert.match(skill, /name: baa-ton-end/);
    assert.ok(skill.includes(`herdr pane run "$HERDR_PANE_ID" '${EXIT_COMMANDS[harness]}'`));
  }
  assert.match(endSkillContent({ harness: "claude" }), /disable-model-invocation: true[\s\S]*`\/baa-ton-end`/);
  assert.match(endSkillContent({ harness: "codex" }), /explicit `\$baa-ton-end`[\s\S]*`\/skills`/);
  assert.doesNotMatch(endSkillContent({ harness: "codex" }), /disable-model-invocation/);
  assert.match(endSkillContent({ harness: "opencode" }), /native `skill` tool[\s\S]*No named slash-invocation syntax is claimed/);
  assert.doesNotMatch(endSkillContent({ harness: "opencode" }), /`\/baa-ton-end`/);
  assert.match(endSkillContent({ harness: "pi" }), /disable-model-invocation: true[\s\S]*`\/skill:baa-ton-end`/);

  const endFlow = endSkillContent({ harness: "pi" });
  const ordered = [
    `action: "status"`,
    `action: "stop"`,
    "herdr_retire",
    "herdr_housekeep",
    "herdr_sweep",
    "Before exit, report",
    "herdr pane run",
  ].map((needle) => endFlow.indexOf(needle));
  assert.ok(ordered.every((index) => index >= 0) && ordered.join() === [...ordered].sort((a, b) => a - b).join(), `end flow is out of order: ${ordered}`);
  assert.match(endFlow, /Never set `paused`|only the operator can pause/);
  assert.match(endFlow, /This end flow never executes a sweep/);
});

test("configured task profile resolves an exact launch profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-profile-"));
  try {
    await mkdir(join(directory, ".baa-ton"));
    await writeFile(
      taskProfileConfigPath(directory),
      JSON.stringify({
        version: 1,
        profiles: {
          planning: {
            agentKind: "claude",
            launchProfile: {
              provider: "claude-code",
              model: "claude-sonnet-5",
              thinking: "high",
              auth: "subscription",
            },
          },
        },
      }),
    );
    const profile = resolveTaskProfile(directory, "planning");
    assert.equal(profile.agentKind, "claude");
    assert.equal(profile.readOnly, true);
    assert.deepEqual(profile.launchProfile, {
      provider: "claude-code",
      model: "claude-sonnet-5",
      thinking: "high",
      auth: "subscription",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unconfigured task profile fails closed instead of guessing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-profile-missing-"));
  try {
    assert.throws(
      () => resolveTaskProfile(directory, "sustained"),
      /no exact launchProfile/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("BAA references stay portable across machines", () => {
  assert.equal(portableBaaReference("/project/AGENTS.md", "/project/BAA.md"), "BAA.md");
  assert.equal(portableBaaReference("/project/docs/AGENTS.md", "/project/BAA.md"), "../BAA.md");
});

test("a CLAUDE.md that imports AGENTS.md does not get a second managed reference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-candidates-"));
  try {
    await writeFile(join(directory, "AGENTS.md"), "# Project\n");
    await writeFile(join(directory, "CLAUDE.md"), "@AGENTS.md\n");
    const importing = instructionCandidates(directory, ["claude", "codex"]).filter((path) => path.startsWith(directory));
    assert.deepEqual(importing, [join(directory, "AGENTS.md")]);
    await writeFile(join(directory, "CLAUDE.md"), "# Claude-only instructions\n");
    const separate = instructionCandidates(directory, ["claude", "codex"]).filter((path) => path.startsWith(directory));
    assert.deepEqual(separate.sort(), [join(directory, "AGENTS.md"), join(directory, "CLAUDE.md")].sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("harness skill directories that alias one another share one start skill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-skill-alias-"));
  try {
    await mkdir(join(directory, ".claude"));
    await symlink(".claude", join(directory, ".agents"));
    const written = installProjectSkills({
      projectRoot: directory,
      selected: ["claude", "codex"],
      baaPath: join(directory, "BAA.md"),
    });
    assert.equal(written.length, 7);
    const start = await readFile(startSkillPath(directory, "claude"), "utf8");
    assert.match(start, /--harness <harness>/);
    assert.match(start, /`claude` or `codex`/);
    assert.match(start, /current claude or codex session/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unmanaged baa-ton skill file is replaced by the managed copy and the original is kept", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-sweep-owned-"));
  try {
    const path = sweepSkillPath(directory, "claude");
    await mkdir(join(directory, ".claude", "skills", "baa-ton-sweep"), { recursive: true });
    await writeFile(path, "---\nname: baa-ton-sweep\n---\nmine\n");
    const written = installProjectSkills({ projectRoot: directory, selected: ["claude"], baaPath: join(directory, "BAA.md") });
    // Baa-ton manages every baa-ton-* skill: the copy is replaced, the original kept beside it.
    assert.equal(await readFile(path, "utf8"), sweepSkillContent());
    assert.equal(await readFile(`${path}.pre-baa-ton`, "utf8"), "---\nname: baa-ton-sweep\n---\nmine\n");
    assert.equal(written.find((skill) => skill.path === path).replaced, `${path}.pre-baa-ton`);
    const notice = replacedSkillsNotice(written);
    assert.match(notice, /^Replaced 1 unmanaged Baa-ton skill file\(s\)/);
    assert.ok(notice.includes(path));
    // A rerun changes nothing and keeps the first backup.
    const again = installProjectSkills({ projectRoot: directory, selected: ["claude"], baaPath: join(directory, "BAA.md") });
    assert.equal(again.some((skill) => skill.changed || skill.replaced), false);
    assert.equal(replacedSkillsNotice(again), undefined);
    assert.equal(await readFile(`${path}.pre-baa-ton`, "utf8"), "---\nname: baa-ton-sweep\n---\nmine\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the start skill carries a condensed core inline instead of sending the root to read BAA.md at boot", async () => {
  const { BAA_CORE, startSkillContent } = await import("../setup-core.mjs");
  assert.ok(BAA_CORE.length < 1500, `core is ${BAA_CORE.length} chars`);
  assert.match(BAA_CORE, /Escalation policy: ask the user only about unclear requirements/);
  const skill = startSkillContent({ harness: "claude", baaPath: "/install/BAA.md", projectRoot: "/project" });
  assert.ok(skill.includes(BAA_CORE));
  assert.doesNotMatch(skill, /1\. Read `\/install\/BAA\.md`/);
  assert.match(skill, /read the section you need/);
});

test("the start skill evaluates first, remediates only when detached, then starts without waiting", async () => {
  const { startSkillContent } = await import("../setup-core.mjs");
  const skill = startSkillContent({ harness: "claude", baaPath: "/install/BAA.md", projectRoot: "/project" });
  const order = ["--check", "--relaunch", "herdr_bootstrap_root", "continue the task already in this conversation"].map((needle) => skill.indexOf(needle));
  assert.ok(order.every((index) => index > 0) && [...order].sort((a, b) => a - b).join() === order.join(), `steps out of order: ${order}`);
  assert.match(skill, /Do not restart a session that is already attached/);
  assert.doesNotMatch(skill, /wait for the user's task\. Do not initialize/);
});
