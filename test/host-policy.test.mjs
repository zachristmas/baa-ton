import test from 'node:test';
import assert from 'node:assert/strict';
import { askList, codexPolicy, codexConfig, policyDigest } from '../src/host-policy.mjs';
import { loadConfig } from '../src/config.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
test('exact ask-list produces native per-tool prompts and explicit routine approvals', () => {
  const config = { approvals: { ask: ['herdr_dispatch', 'herdr_approve'] } };
  const pairs = Object.fromEntries(codexPolicy(config));
  assert.equal(pairs['mcp_servers.baa-ton-native.tools.herdr_dispatch.approval_mode'], 'prompt');
  assert.equal(pairs['mcp_servers.baa-ton-native.tools.herdr_goal.approval_mode'], 'approve');
  assert.equal(pairs['mcp_servers.baa-ton-native.default_tools_approval_mode'], 'prompt');
  assert.equal(pairs['mcp_servers.baa-ton-native.enabled_tools'].length, 12);
  assert.ok(!Object.keys(Object.fromEntries(codexPolicy(config, 'baa-ton', 'worker'))).some(key => key.includes('herdr_approve')));
  for (const ask of [['herdr_*'], ['herdr_goal.pause'], ['herdr_unknown'], ['herdr_goal', 'herdr_goal'], 'all']) assert.throws(() => askList({ approvals: { ask } }), /exact tool names/);
  assert.throws(() => askList({ approvals: { ask: [], bypass: true } }), /cannot be disabled/);
  assert.notEqual(policyDigest(config), policyDigest({ approvals: { ask: [] } }));
});

test('generated host snapshot refuses to start after its ask-list changes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'baa-policy-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  const raw = { version: 2, stateDir: join(dir, 'state'), scopes: {}, profiles: {}, approvals: { ask: ['herdr_dispatch'] } };
  await writeFile(file, JSON.stringify(raw)); const config = await loadConfig(file);
  const original = policyDigest(config), output = codexConfig(config);
  assert.match(output, /default_tools_approval_mode = "prompt"/); assert.ok(output.includes(original));
  raw.approvals.ask = []; await writeFile(file, JSON.stringify(raw));
  await assert.rejects(exec(process.execPath, [join(config.source, 'src/mcp.mjs'), '--config', file, '--policy', original]), error => error.code === 1 && /ask-list or tool surface changed/.test(error.stderr));
});
