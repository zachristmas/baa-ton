import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remoteCall, remoteCommand, validateRemote } from '../src/remote.mjs';
import { Baton } from '../src/core.mjs';
import { invoke } from '../src/tools.mjs';
import { setup } from '../src/setup.mjs';

const posix = { ssh: 'personal-mac', platform: 'posix', node: '/opt/node', runtime: "/Users/test/baa'ton", config: '/Users/test/baa.json' };
const windows = { ssh: 'personal-windows', platform: 'windows', node: 'C:\\Program Files\\nodejs\\node.exe', runtime: 'C:\\Users\\Test\\baa-ton', config: 'C:\\Users\\Test\\baa.json' };
const configuration = { version: 2, stateDir: '/unused', scopes: { mac: { remote: 'mac', scope: 'personal' }, windows: { remote: 'windows', scope: 'work-project' } }, remotes: { mac: posix, windows }, profiles: {} };

test('POSIX and Windows SSH route the same validated tools; task data stays on stdin', async () => {
  for (const scope of ['mac', 'windows']) {
    const payload = { scope, profile: 'fast', task: 'echo $(touch /tmp/NEVER); "quoted" 日本語', requestId: 'stable-job' };
    let calls = 0;
    const result = await remoteCall(configuration, scope, 'herdr_dispatch', payload, { run: async (binary, argv, options) => {
      calls++; assert.equal(binary, 'ssh'); assert.ok(argv.includes('BatchMode=yes')); assert.equal(argv.at(-2), configuration.remotes[scope].ssh);
      assert.ok(!argv.join(' ').includes(payload.task)); assert.equal(JSON.parse(options.input).task, payload.task); assert.equal(JSON.parse(options.input).scope, configuration.scopes[scope].scope);
      if (scope === 'windows') { const command = Buffer.from(argv.at(-1).split(' ').at(-1), 'base64').toString('utf16le'); assert.ok(command.includes(windows.node)); assert.ok(command.includes('herdr_dispatch')); assert.ok(command.includes('UTF8Encoding')); }
      return JSON.stringify({ id: 'stable-job', status: 'running' });
    } });
    assert.equal(result.id, 'stable-job'); assert.equal(calls, 1);
  }
});

test('remote timeout never retries; unsafe endpoints/path shapes and unknown tools reject', async () => {
  let calls = 0;
  await assert.rejects(remoteCall(configuration, 'mac', 'herdr_message', { job: 'a', text: 'x', requestId: 'msg' }, { run: async () => { calls++; throw new Error('SSH reply lost'); } }), /outcome is uncertain/);
  assert.equal(calls, 1);
  for (const change of [{ ssh: '-oProxyCommand=bad' }, { ssh: 'host;echo bad' }, { runtime: 'relative' }, { platform: 'guess' }, { config: '/bad\npath' }]) assert.throws(() => validateRemote({ ...posix, ...change }));
  const baton = new Baton(configuration, { remote: async () => { throw new Error('should not invoke'); } });
  await assert.rejects(invoke(baton, 'herdr_shell', { scope: 'mac' }), /not available/);
  assert.ok(remoteCommand(posix, 'personal', 'herdr_status').includes("'\\''"));
});

test('coordinator routes remote scope and preserves worker restrictions and scope identity', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'baa-remote-route-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const config = { ...configuration, stateDir };
  const calls = [], remote = async (config, scope, name, args, options) => { calls.push({ scope, name, args, options }); return { accepted: true }; };
  const baton = new Baton(config, { remote });
  assert.deepEqual(await invoke(baton, 'herdr_dispatch', { scope: 'windows', profile: 'remote-fast', task: 'Inspect', requestId: 'remote-task' }), { accepted: true });
  assert.equal(calls[0].scope, 'windows'); assert.equal(calls[0].name, 'herdr_dispatch');
  const changed = new Baton({ ...config, remotes: { ...config.remotes, windows: { ...windows, ssh: 'different-account-host' } } }, { remote });
  await assert.rejects(invoke(changed, 'herdr_status', { scope: 'windows' }), /binding changed/);
  const worker = new Baton(config, { remote, scope: 'mac', worker: 'worker1' });
  await assert.rejects(invoke(worker, 'herdr_message', { scope: 'windows', job: 'other', text: 'x', requestId: 'm' }), /scoped/);
  await assert.rejects(invoke(worker, 'herdr_approve', { scope: 'mac', approval: 'x', expectedDigest: 'x', decision: 'allow' }), /not available/);
});

test('agent installer can prepare explicit remote routing without contacting or changing remote hosts', async t => {
  const project = await mkdtemp(join(tmpdir(), 'baa-remote-setup-')); t.after(() => rm(project, { recursive: true, force: true }));
  const settings = { version: 2, projectRoot: project, harnesses: ['codex'], connect: true, config: { ...configuration, stateDir: join(project, 'state') } };
  const preview = await setup(settings); assert.ok(preview.files.some(file => file.path.endsWith('config.json')));
  await setup(settings, { apply: true });
  const installed = JSON.parse(await readFile(join(project, '.baa-ton/config.json')));
  assert.deepEqual(installed.remotes.windows, windows); assert.deepEqual(installed.scopes.windows, { remote: 'windows', scope: 'work-project' });
});
