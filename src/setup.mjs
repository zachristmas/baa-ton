import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { install, harnessPaths, assertLocal, atomic } from './install.mjs';
import { digest } from './store.mjs';
import { loadConfig, validateConfig } from './config.mjs';
import { askList, codexConfig, policyDigest } from './host-policy.mjs';
import { definitions } from './tools.mjs';
import { Herdr } from './herdr.mjs';

const source = resolve(import.meta.dirname, '..');
const begin = '# BEGIN BAA-TON NATIVE', end = '# END BAA-TON NATIVE';
const read = async path => { try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const json = value => JSON.stringify(value, null, 2) + '\n';

export async function setup(settings, { apply = false } = {}) {
  if (settings.version !== 2 || Object.keys(settings).some(key => !['version', 'projectRoot', 'harnesses', 'config', 'connect'].includes(key))) throw new Error('Setup JSON requires version:2, projectRoot, harnesses, config and optional connect.');
  const project = await realpath(settings.projectRoot), harnesses = settings.harnesses;
  if (!settings.config || settings.config.version !== 2 || (settings.connect !== undefined && typeof settings.connect !== 'boolean')) throw new Error('config.version must be 2 and connect must be a boolean.');
  if (!Array.isArray(harnesses) || !harnesses.length || harnesses.some(value => !harnessPaths[value])) throw new Error('Select supported harnesses.');
  const skills = await install({ projectRoot: project, harnesses });
  const configPath = join(project, '.baa-ton/config.json'), stateDir = join(project, '.baa-ton/state');
  const config = { ...settings.config, version: 2, stateDir: settings.config?.stateDir || stateDir, file: configPath, source };
  if (!config.scopes || !config.profiles) throw new Error('Provide scopes and profiles explicitly, even when empty.');
  validateConfig(config);
  const existingConfig = await read(configPath);
  if (existingConfig && JSON.parse(existingConfig).version !== 2) throw new Error('Legacy config preserved. Review its migration and move it aside explicitly before v2 setup.');
  const recordPath = join(project, '.baa-ton/setup-v2.json'); await assertLocal(project, recordPath);
  const record = JSON.parse(await read(recordPath) || '{"version":2,"files":{}}');
  if (record.version !== 2 || !record.files) throw new Error('Unknown setup ownership manifest.');
  const files = [];
  const stage = async (relative, body, { merge = false } = {}) => {
    const path = join(project, relative); await assertLocal(project, path); const old = await read(path);
    if (old === body) return;
    if (old !== null && record.files[relative] && digest(old) !== record.files[relative]) throw new Error(`Preserving edited setup file: ${path}. Review and reconcile before applying.`);
    if (old !== null && !record.files[relative] && !merge) throw new Error(`Preserving unowned setup file: ${path}.`);
    files.push({ path, relative, body, before: old, action: old === null ? 'create' : 'update' });
  };
  const { file, source: ignored, ...saved } = config;
  await stage('.baa-ton/config.json', json(saved), { merge: existingConfig !== null });
  const args = [join(source, 'src/mcp.mjs'), '--config', configPath, '--policy', policyDigest(config)];
  const proposal = codexConfig(config);
  await stage('.baa-ton/codex-mcp.proposed.toml', proposal, { merge: false });
  if (settings.connect) {
    if (harnesses.includes('codex')) {
      const old = await read(join(project, '.codex/config.toml')) || '';
      const start = old.indexOf(begin), finish = old.indexOf(end);
      if ((start < 0) !== (finish < 0) || (start >= 0 && (finish < start || old.indexOf(begin, start + begin.length) >= 0 || old.indexOf(end, finish + end.length) >= 0))) throw new Error('Malformed managed Codex block; preserve and inspect it.');
      const outside = start < 0 ? old : old.slice(0, start) + old.slice(finish + end.length).replace(/^\n/, '');
      if (/mcp_servers[.\s]*["']?baa-ton-native/.test(outside)) throw new Error('Existing baa-ton-native Codex entry is unowned; reconcile it explicitly.');
      await stage('.codex/config.toml', `${outside.trimEnd()}\n\n${begin}\n${proposal}${end}\n`, { merge: true });
    }
    for (const [harness, path, field, entry] of [
      ['claude', '.mcp.json', 'mcpServers', { command: process.execPath, args }],
      ['opencode', 'opencode.json', 'mcp', { type: 'local', command: [process.execPath, ...args], enabled: true }],
    ]) {
      if (!harnesses.includes(harness)) continue;
      if (harness === 'opencode' && await read(join(project, 'opencode.jsonc')) !== null) throw new Error('Existing opencode.jsonc preserved; merge the generated MCP configuration manually or select another path after review.');
      const old = await read(join(project, path)), parsed = JSON.parse(old || '{}');
      if (parsed[field]?.['baa-ton-native'] && !record.files[path]) throw new Error(`Unowned baa-ton-native entry in ${path}; no changes made.`);
      parsed[field] = { ...parsed[field], 'baa-ton-native': entry };
      await stage(path, json(parsed), { merge: true });
    }
    if (harnesses.includes('pi')) {
      const scope = Object.keys(config.scopes)[0];
      if (!scope) throw new Error('Select at least one scope before connecting Pi.');
      await stage('.pi/extensions/baa-ton-native.mjs', `import attach from ${JSON.stringify(join(source, 'src/pi.mjs'))};\nexport default pi => attach(pi, ${JSON.stringify({ file: configPath, scope })});\n`);
    }
  }
  const summary = { project, harnesses, applied: apply, connect: Boolean(settings.connect), skills: skills.changes, files: files.map(({ before, body, ...entry }) => ({ ...entry, before, after: body })), ask: askList(config), notice: 'Project connections only; native/provider permissions remain. No global model/auth change, Git update, daemon, agent restart, resource deletion or legacy-state migration.' };
  if (apply) {
    // Preflight all conflicts before writing; multi-file apply is recoverable but
    // not a filesystem-wide transaction. Preserve manifest evidence on failure.
    await install({ projectRoot: project, harnesses, apply: true });
    for (const entry of files) { await atomic(entry.path, entry.body); record.files[entry.relative] = digest(entry.body); await atomic(recordPath, json(record)); }
    await loadConfig(configPath);
  }
  return summary;
}
export async function wizard({ input = process.stdin, output = process.stdout, ask: suppliedAsk } = {}) {
  const ui = suppliedAsk ? null : createInterface({ input, output });
  const ask = suppliedAsk || (question => ui.question(question));
  try {
    output.write('\nBaa-ton setup · native HERDR · Node 22+\nSelect the project, harnesses, profiles and approval ask-list. Review before applying.\n\n');
    const projectRoot = resolve((await ask(`Project path [${process.cwd()}]: `)).trim() || process.cwd());
    const harnesses = ((await ask('Harnesses (comma separated: codex,claude,opencode,pi) [codex]: ')).trim() || 'codex').split(',').map(value => value.trim());
    const existing = await read(join(projectRoot, '.baa-ton/config.json'));
    if (existing && JSON.parse(existing).version !== 2) throw new Error('Legacy config requires an explicit migration review; it was not overwritten.');
    const config = existing ? JSON.parse(existing) : { version: 2, stateDir: join(projectRoot, '.baa-ton/state'), scopes: {}, profiles: {} };
    const scope = (await ask('Scope name [local]: ')).trim() || 'local';
    try { const native = await new Herdr(config).workspaces(); output.write('Native workspaces:\n' + json(native.workspaces || native)); } catch (error) { output.write(`Native discovery unavailable: ${error.message}\nEnter an inspected workspace ID, or leave empty for skills/config only.\n`); }
    const workspace = (await ask(`HERDR workspace ID [${config.scopes[scope]?.workspace || 'skip'}]: `)).trim() || config.scopes[scope]?.workspace;
    if (workspace) config.scopes[scope] = { cwd: projectRoot, workspace };
    for (const harness of harnesses) {
      const model = (await ask(`${harness}: exact model ID (empty keeps existing profiles): `)).trim();
      if (!model) continue;
      const key = (await ask(`Profile name [${harness}]: `)).trim() || harness;
      const effort = (await ask('Effort/thinking [medium]: ')).trim() || 'medium';
      const provider = ['pi', 'opencode'].includes(harness) ? (await ask('Provider ID [openai]: ')).trim() || 'openai' : undefined;
      config.profiles[key] = { harness, model, effort, auth: 'existing', ...(provider ? { provider } : {}) };
      if (harness === 'claude' && (await ask('Enable exact non-Bash native permission broker? [y/N]: ')).trim().toLowerCase() === 'y') config.profiles[key].permissions = 'broker';
    }
    output.write('Available ask-list tools: ' + definitions.map(entry => entry[0]).join(', ') + '\n');
    const initialAsk = askList(config), response = (await ask(`Ask-list [${initialAsk.join(',')}]; enter none for no extra MCP prompts: `)).trim();
    config.approvals = { ask: response === 'none' ? [] : response ? response.split(',').map(value => value.trim()) : initialAsk };
    const connect = (await ask('Also prepare project-local MCP/extension connections? [y/N]: ')).trim().toLowerCase() === 'y';
    const settings = { version: 2, projectRoot, harnesses, config, connect };
    const preview = await setup(settings); output.write('\nProposed changes (including exact config):\n' + json(preview));
    const approved = (await ask('Apply these exact project changes? [y/N]: ')).trim().toLowerCase() === 'y';
    if (!approved) { output.write('Preview complete; nothing installed.\n'); return preview; }
    const result = await setup(settings, { apply: true }); output.write('Applied. Reconnect selected clients to discover skills/tools; no session was restarted.\n'); return result;
  } finally { ui?.close(); }
}
