import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, dirname } from 'node:path';
import { name } from './store.mjs';
import { askList } from './host-policy.mjs';

export async function loadConfig(path = process.env.BAA_CONFIG) {
  if (!path) throw new Error('Pass --config /absolute/path/config.json or set BAA_CONFIG. No global config is guessed.');
  const file = await realpath(path);
  const config = JSON.parse(await readFile(file, 'utf8'));
  validateConfig(config);
  return { ...config, file, source: resolve(dirname(import.meta.filename), '..') };
}

export function validateConfig(config) {
  if (config.version !== 2) throw new Error('Expected version: 2. Legacy configuration is never modified or auto-migrated.');
  if (!isAbsolute(config.stateDir || '')) throw new Error('stateDir must be absolute.');
  if (!config.scopes || !config.profiles) throw new Error('Configure scopes and profiles. Empty profiles is valid for inspection.');
  askList(config);
  if (config.maxActive !== undefined && (!Number.isInteger(config.maxActive) || config.maxActive < 1 || config.maxActive > 20)) throw new Error('maxActive must be 1..20.');
  for (const [key, scope] of Object.entries(config.scopes)) {
    name(key);
    if (!isAbsolute(scope.cwd || '') || typeof scope.workspace !== 'string' || !scope.workspace) throw new Error(`Scope ${key} requires an absolute cwd and explicit workspace.`);
  }
  for (const key of Object.keys(config.profiles)) { name(key); profile(config, key); }
  return config;
}

export function profile(config, key) {
  const value = config.profiles[key];
  if (!value) throw new Error(`Unknown profile ${key}. Configured: ${Object.keys(config.profiles).join(', ') || 'none'}.`);
  if (!['codex', 'claude', 'pi', 'opencode'].includes(value.harness)) throw new Error('Unsupported harness.');
  for (const field of ['model', 'effort']) if (typeof value[field] !== 'string' || !/^[\w./:+-]+$/.test(value[field]) || value[field].startsWith('-')) throw new Error(`Profile ${key} needs an exact ${field}.`);
  if (['pi', 'opencode'].includes(value.harness) && !/^[\w.-]+$/.test(value.provider || '')) throw new Error(`Profile ${key} needs a provider.`);
  if (value.harness === 'opencode' && value.provider !== 'openai') throw new Error('OpenCode effort mapping is currently qualified only for its openai provider. Other providers need a documented mapping.');
  if (value.auth && value.auth !== 'existing') throw new Error('Only existing harness authentication is supported; no billing-route changes.');
  if (value.permissions && !['native', 'broker'].includes(value.permissions)) throw new Error('Permissions are native or broker.');
  if (value.permissions === 'broker' && value.harness !== 'claude') throw new Error('Only Claude PermissionRequest supports the broker here. Other harnesses retain native permissions.');
  return { ...value, key };
}
