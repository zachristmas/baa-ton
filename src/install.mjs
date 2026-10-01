#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename, rm, realpath, lstat } from 'node:fs/promises';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from './store.mjs';
import { setup, wizard } from './setup.mjs';

export const harnessPaths = { codex: '.agents/skills', claude: '.claude/skills', opencode: '.opencode/skills', pi: '.pi/skills' };
const skills = ['start', 'configure', 'update', 'end', 'uninstall', 'reset', 'sweep'].map(name => `baa-ton-${name}`);
const source = resolve(import.meta.dirname, '..');
const read = async path => { try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
export async function assertLocal(project, path) {
  for (let current = path; current !== project; current = dirname(current)) {
    if (!relative(project, current) || relative(project, current).startsWith('..') || isAbsolute(relative(project, current))) throw new Error('Installer target escaped the project.');
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Resolve this symlink explicitly before installation: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export async function atomic(path, body) { await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, body, { mode: 0o600 }); await rename(temp, path); }
export async function install({ projectRoot, harnesses = Object.keys(harnessPaths), apply = false, remove = false }) {
  const project = await realpath(projectRoot || process.cwd());
  if (!harnesses.length || new Set(harnesses).size !== harnesses.length || harnesses.some(name => !harnessPaths[name])) throw new Error('Choose unique harnesses: codex,claude,opencode,pi.');
  const manifestPath = join(project, '.baa-ton', 'skills-v2.json'); await assertLocal(project, manifestPath);
  const raw = await read(manifestPath), manifest = raw ? JSON.parse(raw) : { version: 2, files: {} };
  if (manifest.version !== 2 || !manifest.files) throw new Error('Unknown skill ownership manifest; no changes made.');
  const changes = [], conflicts = [];
  for (const harness of harnesses) for (const name of skills) {
    const path = join(project, harnessPaths[harness], name, 'SKILL.md'); await assertLocal(project, path);
    const key = relative(project, path), old = await read(path), owned = manifest.files[key];
    if (remove) {
      if (!owned || old === null) continue;
      if (digest(old) !== owned) { conflicts.push(path); continue; }
      changes.push({ path, key, action: 'remove' }); continue;
    }
    const template = await read(join(source, 'skills', name, 'SKILL.md'));
    const body = `${template}\nRuntime: ${source}\nProject: ${project}\nConfig: ${join(project, '.baa-ton', 'config.json')}\n`;
    if (old === body) { manifest.files[key] = digest(body); continue; }
    if (old !== null && (!owned || digest(old) !== owned)) { conflicts.push(path); continue; }
    changes.push({ path, key, body, action: old === null ? 'create' : 'update' });
  }
  if (conflicts.length) throw new Error(`Refusing to overwrite modified/unowned skills. No changes made:\n${conflicts.join('\n')}`);
  if (apply) {
    for (const change of changes) {
      if (change.action === 'remove') { await rm(change.path); delete manifest.files[change.key]; }
      else { await atomic(change.path, change.body); manifest.files[change.key] = digest(change.body); }
    }
    if (changes.length || !raw) await atomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  return { project, harnesses, applied: apply, changes: changes.map(({ body, key, ...change }) => change), note: 'Skills only. No host MCP/model/auth/config changes, Git update, legacy-state migration, HERDR plugin, process restart, or resource cleanup.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = {}, argv = process.argv.slice(2);
    if (!argv.length && process.stdin.isTTY && process.stdout.isTTY) { await wizard(); process.exit(0); }
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--apply') options.apply = true;
      else if (argv[i] === '--remove') options.remove = true;
      else if (argv[i] === '--settings' && argv[i + 1]) options.settings = argv[++i];
      else if (argv[i] === '--project-root' && argv[i + 1]) options.projectRoot = argv[++i];
      else if (argv[i] === '--harnesses' && argv[i + 1]) options.harnesses = argv[++i].split(',');
      else throw new Error('Usage: install [--settings SETUP.json | --project-root PATH --harnesses codex,claude,opencode,pi] [--apply] [--remove]. No arguments in a terminal opens the TUI.');
    }
    if (options.settings && (options.remove || options.projectRoot || options.harnesses)) throw new Error('--settings cannot combine with --remove, --project-root or --harnesses. Put project/harness choices in the setup JSON.');
    const result = options.settings ? await setup(JSON.parse(await readFile(options.settings, 'utf8')), { apply: options.apply }) : await install(options);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
