import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exec = promisify(execFile), root = resolve(import.meta.dirname, '..');

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'baa-native-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'herdr'), log = join(dir, 'native.json');
  const fake = `#!${process.execPath}
import fs from 'node:fs';
const file = ${JSON.stringify(log)};
const args = process.argv.slice(2);
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { agents: {}, calls: [] };
state.calls.push(args);
const flag = name => args[args.indexOf(name) + 1];
let result;
if (args[0] === 'agent' && args[1] === 'list') result = { type: 'agent_list', agents: Object.values(state.agents) };
else if (args[0] === 'workspace' && args[1] === 'list') result = { type: 'workspace_list', workspaces: [{ workspace_id: 'wa', label: 'test' }] };
else if (args[0] === 'workspace' && args[1] === 'get') result = { type: 'workspace_info', workspace: { workspace_id: args[2] } };
else if (args[0] === 'tab' && args[1] === 'create') {
  const pane = 'wa:p' + (Object.keys(state.agents).length + 1);
  const info = { pane_id: pane, terminal_id: 'terminal-' + pane, workspace_id: 'wa', tab_id: 'tab-' + pane, agent_status: 'idle', interactive_ready: true, state_change_seq: 1 };
  state.agents[pane] = info; result = { type: 'tab_created', tab: {}, root_pane: info };
} else if (args[0] === 'agent' && args[1] === 'start') {
  const agent = state.agents[flag('--pane')];
  Object.assign(agent, { agent: flag('--kind'), name: args[2], agent_session: { kind: 'id', source: 'test', agent: flag('--kind'), value: 'session-' + args[2] } });
  result = { type: 'agent_started', agent, argv: args.slice(args.indexOf('--') + 1) };
} else if (args[0] === 'agent' && ['get', 'prompt', 'wait'].includes(args[1])) result = { type: 'agent_info', agent: state.agents[args[2]] };
else { process.stderr.write('Unsupported fake command ' + args.join(' ')); process.exit(1); }
fs.writeFileSync(file, JSON.stringify(state));
process.stdout.write(JSON.stringify({ result }) + '\\n');
`;
  await writeFile(binary, fake); await chmod(binary, 0o700);
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ version: 2, herdr: binary, stateDir: join(dir, 'state'), scopes: { a: { cwd: dir, workspace: 'wa' } }, profiles: { fast: { harness: 'codex', model: 'exact-test-model', effort: 'low' }, review: { harness: 'claude', model: 'exact-claude', effort: 'low', permissions: 'broker' } } }));
  return { dir, config, log };
}

function client(t, args, entry = join(root, 'src/mcp.mjs')) {
  const process = spawn(globalThis.process.execPath, [entry, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let next = 1, buffer = '', errors = ''; const pending = new Map();
  process.stderr.on('data', data => { errors += data; });
  process.stdout.on('data', data => {
    buffer += data;
    for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      const waiter = pending.get(message.id); if (waiter) { clearTimeout(waiter.timer); pending.delete(message.id); waiter.resolve(message); }
    }
  });
  process.on('exit', code => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`MCP exited ${code}: ${errors}`)); } pending.clear(); });
  t.after(() => { process.stdin.end(); process.kill(); });
  return {
    request(method, params) {
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`No MCP response: ${errors}`)); }, 5000);
        pending.set(id, { resolve, reject, timer });
        process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
  };
}

test('real stdio MCP process serves tools and drives native argv through a fake executable', async t => {
  const { config, log, dir } = await fixture(t), mcp = client(t, ['--config', config]);
  const initialized = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.result.serverInfo.name, 'baa-ton-native');
  assert.match(initialized.result.instructions, /human can redirect any pane/);
  const tools = await mcp.request('tools/list', {});
  assert.equal(tools.result.tools.length, 12);
  const call = async (name, args) => mcp.request('tools/call', { name, arguments: args });
  const bad = await call('herdr_goal', { scope: 'a', action: 'delete' }); assert.equal(bad.result.isError, true);
  const status = await call('herdr_status', {}); assert.equal(status.result.structuredContent.result.native.workspaces[0].workspace_id, 'wa');
  const created = await call('herdr_dispatch', { scope: 'a', profile: 'fast', task: 'Read this task only.', requestId: 'dispatch-one' });
  assert.ok(!created.result.isError, JSON.stringify(created));
  assert.equal(created.result.structuredContent.result.status, 'running');
  const worker = client(t, [], join(dir, 'state/launch/a/dispatch-one/mcp.mjs'));
  await worker.request('initialize', { protocolVersion: '2025-06-18' });
  assert.equal((await worker.request('tools/list', {})).result.tools.length, 9);
  const own = await worker.request('tools/call', { name: 'herdr_status', arguments: { job: 'dispatch-one' } });
  assert.equal(own.result.structuredContent.result.id, 'dispatch-one');
  const data = JSON.parse(await readFile(log, 'utf8'));
  const start = data.calls.find(args => args[0] === 'agent' && args[1] === 'start');
  assert.ok(start.includes('exact-test-model')); assert.ok(start.includes('model_reasoning_effort="low"'));
  const wait = await call('herdr_wait', { scope: 'a', job: 'dispatch-one', timeout: 10 }); assert.match(wait.result.structuredContent.result.note, /not proof/);
  const paused = await call('herdr_goal', { scope: 'a', action: 'pause' }); assert.equal(paused.result.structuredContent.result.status, 'paused');
});

test('worker stdio connection removes approval and reconnect powers', async t => {
  const { config } = await fixture(t), mcp = client(t, ['--config', config, '--scope', 'a', '--worker', 'assigned']);
  await mcp.request('initialize', { protocolVersion: '2024-11-05' });
  const tools = (await mcp.request('tools/list', {})).result.tools;
  assert.equal(tools.length, 9); assert.ok(!tools.some(tool => tool.name === 'herdr_approve'));
  const denied = await mcp.request('tools/call', { name: 'herdr_approve', arguments: { approval: 'a', expectedDigest: 'd', decision: 'allow' } });
  assert.equal(denied.result.isError, true); assert.match(denied.result.content[0].text, /not available/);
});

test('CLI pause/resume and JSON invocation persist only the named scope', async t => {
  const { config, dir } = await fixture(t);
  const cli = ['src/cli.mjs'];
  await exec(process.execPath, [...cli, 'pause', '--config', config, '--scope', 'a'], { cwd: root });
  assert.equal(JSON.parse(await readFile(join(dir, 'state/a.json'))).goal.status, 'paused');
  const { stdout } = await exec(process.execPath, [...cli, 'resume', '--config', config, '--scope', 'a'], { cwd: root });
  assert.equal(JSON.parse(stdout).status, 'active');
});

test('actual Claude hook process returns one exact native decision after MCP approval', async t => {
  const { config, dir } = await fixture(t), mcp = client(t, ['--config', config]);
  await mcp.request('initialize', { protocolVersion: '2025-06-18' });
  const call = (name, args) => mcp.request('tools/call', { name, arguments: args });
  const created = await call('herdr_dispatch', { scope: 'a', profile: 'review', task: 'Read files', requestId: 'review-job' });
  assert.ok(!created.result.isError, JSON.stringify(created));
  const child = spawn(process.execPath, [join(root, 'src/permission-hook.mjs'), '--config', config, '--scope', 'a', '--worker', 'review-job']);
  t.after(() => child.kill());
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: created.result.structuredContent.result.identity.session.value, tool_name: 'Read', tool_input: { file_path: '/tmp/exact-file' } }));
  let request;
  for (let i = 0; i < 100 && !request; i++) {
    const state = JSON.parse(await readFile(join(dir, 'state/a.json')));
    request = Object.values(state.approvals).find(value => value.status === 'pending');
    if (!request) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(request, stderr); assert.deepEqual(request.input, { file_path: '/tmp/exact-file' });
  const allowed = await call('herdr_approve', { scope: 'a', approval: request.id, expectedDigest: request.digest, decision: 'allow' });
  assert.ok(!allowed.result.isError, JSON.stringify(allowed));
  await exited;
  assert.deepEqual(JSON.parse(stdout), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.equal(JSON.parse(await readFile(join(dir, 'state/a.json'))).approvals[request.id].status, 'consumed');
  const replay = await call('herdr_approve', { scope: 'a', approval: request.id, expectedDigest: request.digest, decision: 'allow' });
  assert.equal(replay.result.isError, true);
});

test('Claude Bash permission always stays native, including Git global flags', async t => {
  const { config } = await fixture(t);
  for (const command of ['git -C /tmp/repo push origin main', 'echo hello']) {
    const child = spawn(process.execPath, [join(root, 'src/permission-hook.mjs'), '--config', config, '--scope', 'a', '--worker', 'unused']);
    let output = '', errors = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
    const done = new Promise(resolve => child.once('exit', resolve));
    child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'session', tool_name: 'Bash', tool_input: { command } }));
    await done; assert.equal(output, ''); assert.match(errors, /native human permission prompt/);
  }
});
