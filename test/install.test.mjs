import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { install, harnessPaths } from '../src/install.mjs';
import { setup, wizard } from '../src/setup.mjs';
const exec = promisify(execFile);
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'baa-install-home-')); t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, 'project'); await mkdir(project);
  const settings = { version: 2, projectRoot: project, harnesses: Object.keys(harnessPaths), config: { version: 2, herdr: '/usr/bin/false', scopes: { local: { cwd: project, workspace: 'chosen-workspace' } }, profiles: { fast: { harness: 'codex', model: 'user-exact-model', effort: 'low' } }, approvals: { ask: ['herdr_approve'] } }, connect: true };
  return { home, project, settings };
}
async function snapshot(path, prefix = '') {
  const files = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const key = join(prefix, entry.name), full = join(path, entry.name);
    if (entry.isDirectory()) Object.assign(files, await snapshot(full, key)); else files[key] = await readFile(full, 'utf8');
  }
  return files;
}

test('one setup selects all four harnesses, preserves unrelated settings and is idempotent', async t => {
  const { home, project, settings } = await fixture(t);
  await mkdir(join(project, '.codex'));
  await writeFile(join(project, '.codex/config.toml'), 'model = "keep-global-choice"\n[mcp_servers.other]\ncommand = "preserve"\n');
  await writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { existing: { command: 'keep' } }, unrelated: true }));
  await writeFile(join(project, 'opencode.json'), JSON.stringify({ theme: 'keep', mcp: { existing: { enabled: false } } }));
  await writeFile(join(project, 'AGENTS.md'), 'Human instructions remain.');
  const before = await snapshot(home), preview = await setup(settings);
  assert.equal(preview.skills.length, 28); assert.ok(preview.files.some(file => file.path.endsWith('.codex/config.toml')));
  assert.deepEqual(await snapshot(home), before);
  await setup(settings, { apply: true });
  for (const path of Object.values(harnessPaths)) assert.match(await readFile(join(project, path, 'baa-ton-start/SKILL.md'), 'utf8'), /name: baa-ton-start/);
  assert.equal(JSON.parse(await readFile(join(project, '.mcp.json'))).mcpServers.existing.command, 'keep');
  assert.equal(JSON.parse(await readFile(join(project, 'opencode.json'))).theme, 'keep');
  assert.match(await readFile(join(project, '.codex/config.toml'), 'utf8'), /model = "keep-global-choice"/);
  assert.equal(await readFile(join(project, 'AGENTS.md'), 'utf8'), 'Human instructions remain.');
  const applied = await snapshot(home), again = await setup(settings, { apply: true });
  assert.equal(again.files.length, 0); assert.equal(again.skills.length, 0); assert.deepEqual(await snapshot(home), applied);
});

test('partial harness selection and owned-only removal preserve other skills and config', async t => {
  const { project, settings } = await fixture(t); settings.harnesses = ['codex'];
  await setup(settings, { apply: true });
  await assert.rejects(readFile(join(project, '.mcp.json')), /ENOENT/);
  await mkdir(join(project, '.agents/skills/unrelated')); await writeFile(join(project, '.agents/skills/unrelated/SKILL.md'), 'keep');
  await install({ projectRoot: project, harnesses: ['codex'], remove: true, apply: true });
  assert.equal(await readFile(join(project, '.agents/skills/unrelated/SKILL.md'), 'utf8'), 'keep');
  assert.equal(JSON.parse(await readFile(join(project, '.baa-ton/config.json'))).profiles.fast.model, 'user-exact-model');
});

test('conflicts, symlinks and invalid settings fail before project mutation', async t => {
  const { home, project, settings } = await fixture(t);
  await mkdir(join(project, '.claude/skills/baa-ton-start'), { recursive: true }); await writeFile(join(project, '.claude/skills/baa-ton-start/SKILL.md'), 'user owned');
  const before = await snapshot(home);
  await assert.rejects(setup(settings, { apply: true }), /unowned skills/); assert.deepEqual(await snapshot(home), before);
  settings.harnesses = ['codex']; settings.config.maxActive = 0;
  await assert.rejects(setup(settings, { apply: true }), /maxActive/); assert.deepEqual(await snapshot(home), before);
  delete settings.config.maxActive;
  await symlink(join(project, '.claude'), join(project, '.agents'));
  await assert.rejects(setup(settings, { apply: true }), /symlink/);
});

test('TUI cancellation preserves every file after harness/profile/ask-list selection', async t => {
  const { home, project } = await fixture(t);
  const answers = [project, 'codex,pi', 'local', '', 'chosen-codex', 'fast', 'low', 'chosen-pi', 'secondary', 'medium', 'openai', 'herdr_approve,herdr_dispatch', 'n', 'n'];
  const before = await snapshot(home); let displayed = '';
  const result = await wizard({ ask: async () => answers.shift(), output: { write: text => { displayed += text; } } });
  assert.equal(answers.length, 0); assert.equal(result.applied, false); assert.deepEqual(result.ask, ['herdr_approve', 'herdr_dispatch']);
  assert.match(displayed, /nothing installed/); assert.deepEqual(await snapshot(home), before);
});

test('agent setup JSON and POSIX installer share preview/apply behavior', async t => {
  const { home, project, settings } = await fixture(t); settings.harnesses = ['codex'];
  const path = join(home, 'agent-setup.json'); await writeFile(path, JSON.stringify(settings));
  const before = await snapshot(project);
  const preview = await exec('sh', ['install.sh', '--settings', path]); assert.equal(JSON.parse(preview.stdout).applied, false); assert.deepEqual(await snapshot(project), before);
  const applied = await exec(process.execPath, ['src/install.mjs', '--settings', path, '--apply']); assert.equal(JSON.parse(applied.stdout).applied, true);
  const final = await snapshot(project); await exec(process.execPath, ['src/install.mjs', '--settings', path, '--apply']); assert.deepEqual(await snapshot(project), final);
});

test('agent setup rejects removal and ignored target overrides before writes', async t => {
  const { home, project, settings } = await fixture(t), path = join(home, 'setup.json'); await writeFile(path, JSON.stringify(settings));
  for (const flags of [['--remove'], ['--project-root', project], ['--harnesses', 'pi']]) await assert.rejects(exec(process.execPath, ['src/install.mjs', '--settings', path, '--apply', ...flags]), error => /cannot combine/.test(error.stderr));
  assert.deepEqual(await readdir(project), []);
});
