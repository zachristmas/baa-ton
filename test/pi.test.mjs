import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import attach from '../src/pi.mjs';

test('production Pi extension attaches external guard and configurable native confirmation in any worker pane', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'baa-pi-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  await writeFile(file, JSON.stringify({ version: 2, stateDir: join(dir, 'state'), scopes: { a: { cwd: dir, workspace: 'wa' } }, profiles: {}, approvals: { ask: ['herdr_goal'] } }));
  const tools = new Map(), events = new Map();
  await attach({ registerTool: tool => tools.set(tool.name, tool), on: (event, handler) => events.set(event, handler) }, { file, scope: 'a', worker: 'any-worker' });
  assert.equal(tools.size, 9); assert.ok(events.has('tool_call')); assert.ok(events.has('before_agent_start'));
  const goal = tools.get('herdr_goal');
  await assert.rejects(goal.execute('1', { action: 'pause' }, undefined, undefined, { hasUI: false }), /requires the human/);
  const paused = await goal.execute('2', { action: 'pause' }, undefined, undefined, { hasUI: true, ui: { confirm: async () => true } });
  assert.equal(paused.details.status, 'paused');
  const guard = await events.get('tool_call')({ toolName: 'bash', input: { command: 'git -C /tmp/repo push origin main' } }, { cwd: dir, hasUI: true, ui: { confirm: async () => true }, sessionManager: { getSessionFile: () => '/session' } });
  assert.equal(guard.block, true);
});
