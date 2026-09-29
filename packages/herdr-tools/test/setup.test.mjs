import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, readlink, lstat, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSetupConfig,
  configureSkillContent,
  configureSkillPath,
  endSkillContent,
  endSkillPath,
  installProjectSkills,
  planProjectSkills,
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

async function snapshotProject(root) {
  const entries = [];
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = join(prefix, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) entries.push({ path: relativePath, type: "symlink", target: await readlink(path) });
      else if (stat.isDirectory()) {
        entries.push({ path: relativePath, type: "directory" });
        await visit(path, relativePath);
      } else if (stat.isFile()) entries.push({ path: relativePath, type: "file", content: (await readFile(path)).toString("base64") });
      else entries.push({ path: relativePath, type: "other" });
    }
  }
  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function generatedScalarFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "generated skill has delimited YAML frontmatter");
  const fields = {};
  for (const line of match[1].split("\n").filter(Boolean)) {
    const field = line.match(/^([a-z][a-z-]*): (.+)$/);
    assert.ok(field, `generated frontmatter uses a supported simple scalar: ${line}`);
    assert.equal(Object.hasOwn(fields, field[1]), false, `frontmatter field ${field[1]} is unique`);
    fields[field[1]] = field[2];
  }
  return fields;
}

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
    assert.equal(generatedScalarFrontmatter(await readFile(endSkillPath(directory, "claude"), "utf8"))["disable-model-invocation"], "true");
    assert.equal(generatedScalarFrontmatter(await readFile(endSkillPath(directory, "codex"), "utf8"))["disable-model-invocation"], undefined);
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
  // Codex's local skill-creator quick validator rejects Claude's
  // disable-model-invocation key, so installation fails closed on that alias.
  // Pi's docs/skills.md support the field; OpenCode 1.18.31's `debug skill --pure`
  // discovered a synthetic Claude+OpenCode grouped skill carrying it.
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

  assert.throws(
    () => endSkillContent({ harness: ["claude", "codex"] }),
    /Codex's skill frontmatter validator rejects that field[\s\S]*Split these skill directories/,
    "the content generator must never emit a Codex-invalid shared skill",
  );
  assert.throws(
    () => endSkillContent({ harness: ["pi", "codex"] }),
    /Codex's skill frontmatter validator rejects that field[\s\S]*Split these skill directories/,
  );
  const claudePi = endSkillContent({ harness: ["claude", "pi"] });
  assert.equal(generatedScalarFrontmatter(claudePi)["disable-model-invocation"], "true", "Claude and Pi share the supported opt-out");
  assert.equal(generatedScalarFrontmatter(endSkillContent({ harness: "codex" }))["disable-model-invocation"], undefined);

  for (const harness of ["claude", "codex", "opencode", "pi"]) {
    const generated = endSkillContent({ harness });
    const rootCheck = generated.split("\n").find((line) => line.startsWith("1."));
    assert.match(rootCheck, /herdr_doctor/);
    assert.match(rootCheck, /root-identity.*exactly `ok`/);
    assert.match(rootCheck, /status is `warn` and its detail begins `Current root identity matches\.`/);
    assert.match(rootCheck, /Stop on every other status or detail/);
    if (harness !== "pi") assert.doesNotMatch(generated, /herdr_root_identity/, `${harness} must not invoke a Pi-only root tool`);
  }

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
  assert.match(endFlow, /preserves workflow records for any existing recorded worktree so the following sweep can still discover them/);
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

test("Claude and OpenCode can share skill paths with OpenCode's loader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-skill-opencode-alias-"));
  try {
    await mkdir(join(directory, ".claude", "skills"), { recursive: true });
    await mkdir(join(directory, ".opencode"));
    await symlink("../.claude/skills", join(directory, ".opencode", "skills"));
    const written = installProjectSkills({
      projectRoot: directory,
      selected: ["claude", "opencode"],
      baaPath: join(directory, "BAA.md"),
    });
    assert.equal(written.length, 7);
    const end = await readFile(endSkillPath(directory, "claude"), "utf8");
    assert.equal(await readFile(endSkillPath(directory, "opencode"), "utf8"), end);
    assert.equal(generatedScalarFrontmatter(end)["disable-model-invocation"], "true");
    assert.match(end, /opencode: OpenCode discovers this skill for its native `skill` tool/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude and Pi can share skill paths with their verified user-only frontmatter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-skill-pi-alias-"));
  try {
    await mkdir(join(directory, ".claude", "skills"), { recursive: true });
    await mkdir(join(directory, ".pi"));
    await symlink("../.claude/skills", join(directory, ".pi", "skills"));
    const written = installProjectSkills({
      projectRoot: directory,
      selected: ["claude", "pi"],
      baaPath: join(directory, "BAA.md"),
    });
    assert.equal(written.length, 7);
    const end = await readFile(endSkillPath(directory, "claude"), "utf8");
    assert.equal(await readFile(endSkillPath(directory, "pi"), "utf8"), end);
    assert.equal(generatedScalarFrontmatter(end)["disable-model-invocation"], "true");
    assert.match(end, /claude: Invoke directly with `\/baa-ton-end`/);
    assert.match(end, /pi: Invoke directly with `\/skill:baa-ton-end`/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("incompatible Claude and Codex skill paths fail before any writes or replacements", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-skill-alias-"));
  const legacyPath = join(directory, ".claude", "skills", "baa-ton-setup", "SKILL.md");
  const unmanagedPath = endSkillPath(directory, "claude");
  const legacy = "<!-- baa-ton:setup-skill:start -->\nlegacy\n<!-- baa-ton:setup-skill:end -->\n";
  const unmanaged = "---\nname: baa-ton-end\ndescription: Keep this file\n---\nuser-owned\n";
  try {
    await mkdir(join(directory, ".claude", "skills", "baa-ton-setup"), { recursive: true });
    await mkdir(join(directory, ".claude", "skills", "baa-ton-end"), { recursive: true });
    await mkdir(join(directory, ".agents"));
    await symlink("../.claude/skills", join(directory, ".agents", "skills"));
    await writeFile(legacyPath, legacy);
    await writeFile(unmanagedPath, unmanaged);
    assert.throws(
      () => installProjectSkills({
        projectRoot: directory,
        selected: ["pi", "claude", "codex"],
        baaPath: join(directory, "BAA.md"),
      }),
      /disable-model-invocation[\s\S]*Codex's skill frontmatter validator rejects that field[\s\S]*Split these skill directories/,
    );
    assert.equal(await readFile(legacyPath, "utf8"), legacy, "preflight precedes legacy-skill deletion");
    assert.equal(await readFile(unmanagedPath, "utf8"), unmanaged, "preflight preserves unmanaged skills");
    await assert.rejects(() => readFile(`${unmanagedPath}.pre-baa-ton`, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(startSkillPath(directory, "pi"), "utf8"), { code: "ENOENT" }, "preflight precedes writes to unrelated harnesses");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("outer setup rejects incompatible aliased skill directories before any project mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-setup-atomicity-"));
  const setupPath = fileURLToPath(new URL("../setup.mjs", import.meta.url));
  const files = {
    "BAA.md": "sentinel BAA contract\n",
    "docs/AGENTS.md": "sentinel agent instructions\n",
    "docs/CLAUDE.md": "sentinel Claude instructions\n",
    ".baa-ton/config.json": '{"version":1,"sentinel":"config"}\n',
    ".claude/skills/baa-ton-setup/SKILL.md": "<!-- baa-ton:setup-skill:start -->\nlegacy sentinel\n<!-- baa-ton:setup-skill:end -->\n",
    ".claude/skills/baa-ton-end/SKILL.md": "unmanaged skill sentinel\n",
  };
  try {
    for (const [path, content] of Object.entries(files)) {
      const fullPath = join(directory, path);
      await mkdir(join(fullPath, ".."), { recursive: true });
      await writeFile(fullPath, content);
    }
    await mkdir(join(directory, ".agents"));
    await symlink("../.claude/skills", join(directory, ".agents", "skills"));
    const before = await snapshotProject(directory);
    const result = spawnSync(process.execPath, [
      setupPath,
      "--project-root", directory,
      "--non-interactive",
      "--harness", "claude",
      "--harness", "codex",
      "--harness", "pi",
      "--instructions-path", join(directory, "docs/AGENTS.md"),
      "--instructions-path", join(directory, "docs/CLAUDE.md"),
    ], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Cannot install skills for claude and codex in shared directory/);
    assert.match(result.stderr, /Codex's skill frontmatter validator rejects that field/);
    assert.match(result.stderr, /Split these skill directories/);
    assert.deepEqual(await snapshotProject(directory), before, "setup must preserve every existing file and create nothing");
    assert.throws(() => planProjectSkills({ projectRoot: directory, selected: ["claude", "codex"] }), /Split these skill directories/);
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
