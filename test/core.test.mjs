import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Baton } from '../src/core.mjs';
import { Store } from '../src/store.mjs';
import { Herdr, identity, sameAgent } from '../src/herdr.mjs';
import { launch } from '../src/profiles.mjs';
import { requestApproval, decideApproval, consumeApproval } from '../src/approvals.mjs';
import { invoke, toolList } from '../src/tools.mjs';
import { validateConfig } from '../src/config.mjs';
import { gitChanges } from '../src/cleanup.mjs';

class FakeHerdr {
  constructor() { this.agents = new Map(); this.calls = []; this.serial = 0; }
  async workspace(workspace) { this.calls.push(['workspace', workspace]); return { workspace: { workspace_id: workspace } }; }
  async workspaces() { return { workspaces: [] }; }
  async list() { return { agents: [...this.agents.values()] }; }
  async create(scope, job) {
    this.calls.push(['create', scope, job.id]);
    const pane = `w${++this.serial}:p1`, workspace = job.branch ? `w${this.serial}` : scope.workspace;
    this.agents.set(pane, { pane_id: pane, workspace_id: workspace, terminal_id: `t${this.serial}`, agent_status: 'idle', interactive_ready: true, state_change_seq: 1, processIdentity: { group: this.serial, pids: [100 + this.serial] } });
    return { root_pane: { pane_id: pane, workspace_id: workspace }, ...(job.branch ? { worktree: { path: `/tmp/${job.id}` } } : {}) };
  }
  async start(job, profile, argv) {
    this.calls.push(['start', job.id, profile, argv]);
    const agent = this.agents.get(job.pane); Object.assign(agent, { agent: profile.harness, name: job.agentName, agent_session: { kind: 'id', value: `session-${job.id}`, source: 'native', agent: profile.harness } });
    return { agent: structuredClone(agent) };
  }
  async get(pane) { if (!this.agents.has(pane)) throw new Error('missing pane'); return structuredClone(this.agents.get(pane)); }
  async prompt(pane, text) { this.calls.push(['prompt', pane, text]); if (this.error) throw this.error; return { agent: await this.get(pane) }; }
  async wait(pane) { this.calls.push(['wait', pane]); return { agent: await this.get(pane) }; }
  async read(pane, lines) { this.calls.push(['read', pane, lines]); return 'observed output'; }
  async close(pane) { this.calls.push(['close', pane]); this.agents.delete(pane); return { type: 'pane_closed', pane_id: pane }; }
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'baa-native-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { version: 2, file: join(directory, 'config.json'), stateDir: join(directory, 'state'), source: resolve(import.meta.dirname, '..'), scopes: { a: { cwd: directory, workspace: 'wa' }, b: { cwd: directory, workspace: 'wb' } }, profiles: { fast: { harness: 'codex', model: 'model-exact', effort: 'high' }, review: { harness: 'claude', model: 'claude-exact', effort: 'low', permissions: 'broker' } } };
  await writeFile(config.file, JSON.stringify(config));
  const herdr = new FakeHerdr(); let clock = 1000000;
  const baton = new Baton(config, { herdr, now: () => clock });
  const dispatch = (scope = 'a', extra = {}) => baton.dispatch({ scope, profile: 'fast', task: 'Inspect and return evidence.', requestId: 'job1', ...extra });
  return { baton, herdr, config, dispatch, advance: seconds => { clock += seconds * 1000; } };
}
const proof = { summary: 'Done', checks: ['Ran named test; exit 0.'], artifacts: ['report.txt'] };

async function verifyJob(baton, job, scope = 'a') {
  await baton.result({ scope, action: 'submit', job: job.id, revision: job.revision, evidence: proof });
  return baton.result({ scope, action: 'verify', job: job.id, revision: job.revision, reviewer: 'human', evidence: proof });
}

function enableCleanup(baton, mode = 'close') {
  baton.config.cleanup = { mode, idleGraceSeconds: 60 };
  baton.workspaceStatus = async () => '';
}

test('multiple scopes: pause is local, direct user messages still work, resume keeps state', async t => {
  const { baton, dispatch, herdr, advance } = await fixture(t);
  for (const scope of ['a', 'b']) { await baton.goal({ scope, action: 'set', objective: 'Work', intervalSeconds: 60 }); await dispatch(scope); }
  await baton.goal({ scope: 'a', action: 'pause' }); advance(61);
  const before = herdr.calls.filter(call => call[0] === 'prompt').length;
  assert.equal((await baton.tick({ scope: 'a' })).quiet, 'paused');
  assert.equal((await baton.tick({ scope: 'b' })).changes.length, 1);
  assert.equal(herdr.calls.filter(call => call[0] === 'prompt').length, before + 1);
  await assert.rejects(dispatch('a', { requestId: 'job2' }), /paused/);
  await baton.message({ scope: 'a', job: 'job1', text: 'Human correction', requestId: 'redirect1', redirect: true });
  assert.equal((await baton.state('a')).jobs.job1.revision, 1);
  await baton.goal({ scope: 'a', action: 'resume' });
  assert.equal((await baton.state('b')).goal.status, 'active');
});

test('concurrent identical dispatch creates and prompts only once; changed arguments refuse', async t => {
  const { baton, dispatch, herdr } = await fixture(t);
  await Promise.all([dispatch(), dispatch(), dispatch()]);
  assert.equal(herdr.calls.filter(call => call[0] === 'create').length, 1);
  assert.equal(herdr.calls.filter(call => call[0] === 'prompt').length, 1);
  await assert.rejects(dispatch('a', { task: 'different' }), /already bound/);
  assert.equal((await baton.state('a')).jobs.job1.status, 'running');
});

test('lost prompt reply and crashed sending claim never replay on retry or watchdog', async t => {
  const { baton, dispatch, herdr, advance } = await fixture(t);
  await baton.goal({ scope: 'a', action: 'set', objective: 'Work', intervalSeconds: 60 });
  await dispatch(); herdr.error = Object.assign(new Error('timeout after write'), { uncertain: true });
  const message = await baton.message({ scope: 'a', job: 'job1', text: 'Continue', requestId: 'lost' });
  assert.equal(message.status, 'uncertain');
  const count = herdr.calls.filter(call => call[0] === 'prompt').length;
  delete herdr.error;
  await baton.message({ scope: 'a', job: 'job1', text: 'Continue', requestId: 'lost' }); advance(100);
  await baton.tick({ scope: 'a' });
  assert.equal(herdr.calls.filter(call => call[0] === 'prompt').length, count);
  await baton.change('a', state => { state.messages.lost.status = 'sending'; });
  await baton.tick({ scope: 'a' });
  assert.equal(herdr.calls.filter(call => call[0] === 'prompt').length, count);
});

test('watchdog bounded, blocked/working skipped, native done not treated as completion', async t => {
  const { baton, dispatch, herdr, advance } = await fixture(t);
  await baton.goal({ scope: 'a', action: 'set', objective: 'Work', intervalSeconds: 60, maxNudges: 2 });
  const job = await dispatch();
  herdr.agents.get(job.pane).agent_status = 'working'; advance(65); await baton.tick({ scope: 'a' });
  assert.equal((await baton.state('a')).jobs.job1.nudges, 0);
  herdr.agents.get(job.pane).agent_status = 'blocked'; advance(65); await baton.tick({ scope: 'a' });
  assert.equal((await baton.state('a')).jobs.job1.nudges, 0);
  herdr.agents.get(job.pane).agent_status = 'done';
  for (let i = 0; i < 5; i++) { advance(65); await baton.tick({ scope: 'a' }); }
  const current = (await baton.state('a')).jobs.job1;
  assert.equal(current.nudges, 2); assert.equal(current.status, 'stalled'); assert.equal(current.result, undefined);
});

test('human redirection in a worker is permitted and fences stale result/approvals', async t => {
  const { baton, config, herdr, dispatch } = await fixture(t);
  await dispatch(); await baton.result({ scope: 'a', action: 'submit', job: 'job1', revision: 0, evidence: proof });
  const worker = new Baton(config, { herdr, scope: 'a', worker: 'job1' });
  await worker.message({ job: 'job1', text: 'New human request', requestId: 'changed', redirect: true });
  await assert.rejects(worker.result({ action: 'submit', job: 'job1', revision: 0, evidence: proof }), /Stale/);
  await worker.result({ action: 'submit', job: 'job1', revision: 1, evidence: proof });
  await assert.rejects(worker.result({ action: 'verify', job: 'job1', revision: 1, evidence: proof, reviewer: 'job1' }), /Independent/);
  await assert.rejects(worker.goal({ scope: 'b', action: 'pause' }), /scoped/);
  assert.ok(!toolList('job1').some(tool => tool.name === 'herdr_approve'));
});

test('reconnect requires inspected terminal and invalidates old results without resending', async t => {
  const { baton, dispatch, herdr } = await fixture(t);
  const job = await dispatch();
  await baton.result({ scope: 'a', action: 'submit', job: 'job1', revision: 0, evidence: proof });
  herdr.agents.get(job.pane).agent_session.value = 'replacement-session';
  const count = herdr.calls.length;
  const held = await baton.message({ scope: 'a', job: 'job1', text: 'Old session work', requestId: 'held' });
  assert.equal(held.status, 'pending'); assert.match(held.reason, /Identity changed/);
  await assert.rejects(baton.reconnect({ scope: 'a', job: 'job1', pane: job.pane, expectedTerminal: 'wrong' }), /Terminal changed/);
  const next = await baton.reconnect({ scope: 'a', job: 'job1', pane: job.pane, expectedTerminal: job.identity.terminal });
  assert.equal(next.revision, 1); assert.equal(next.result, undefined);
  assert.equal((await baton.state('a')).messages.held.status, 'superseded');
  assert.equal(herdr.calls.length, count);
});

test('cross-harness sequence gates on evidence and uses each exact profile', async t => {
  const { baton, herdr } = await fixture(t);
  await baton.chain({ scope: 'a', action: 'create', chain: 'change', stages: [ { profile: 'fast', task: 'Build', access: 'write', branch: 'task/build' }, { profile: 'review', task: 'Review', access: 'read', after: 'reported', reviewPrevious: true } ] });
  const writer = await baton.chain({ scope: 'a', action: 'advance', chain: 'change' });
  await assert.rejects(baton.chain({ scope: 'a', action: 'advance', chain: 'change' }), /requires reported/);
  await baton.result({ scope: 'a', action: 'submit', job: writer.id, revision: 0, evidence: proof });
  const reviewer = await baton.chain({ scope: 'a', action: 'advance', chain: 'change' });
  await baton.result({ scope: 'a', action: 'verify', job: writer.id, revision: 0, reviewer: reviewer.id, evidence: proof });
  const launches = herdr.calls.filter(call => call[0] === 'start');
  assert.deepEqual(launches.map(call => [call[2].harness, call[2].model, call[2].effort]), [['codex', 'model-exact', 'high'], ['claude', 'claude-exact', 'low']]);
  assert.equal((await baton.state('a')).jobs[writer.id].status, 'verified');
});

test('Claude approval binds exact input/session/revision, is single-use, denies stale/self grants', async t => {
  const { baton, herdr, config, dispatch, advance } = await fixture(t);
  const job = await dispatch('a', { profile: 'review' });
  const binding = { session: `session-${job.id}`, tool: 'Bash', input: { command: 'npm test', description: 'local tests' } };
  const request = await requestApproval(baton, { scope: 'a', job: job.id, ...binding });
  const worker = new Baton(config, { herdr, worker: job.id, scope: 'a' });
  await assert.rejects(decideApproval(worker, { approval: request.id, expectedDigest: request.digest, decision: 'allow' }), /cannot approve/);
  await assert.rejects(decideApproval(baton, { scope: 'a', approval: request.id, expectedDigest: 'wrong', decision: 'allow' }), /digest/);
  await decideApproval(baton, { scope: 'a', approval: request.id, expectedDigest: request.digest, decision: 'allow' });
  assert.equal(await consumeApproval(baton, 'a', request.id, { ...binding, input: { command: 'git push' } }), undefined);
  assert.deepEqual(await consumeApproval(baton, 'a', request.id, binding), { behavior: 'allow' });
  assert.equal(await consumeApproval(baton, 'a', request.id, binding), undefined);
  const stale = await requestApproval(baton, { scope: 'a', job: job.id, ...binding });
  await baton.message({ scope: 'a', job: job.id, text: 'Change plan', requestId: 'revision', redirect: true });
  await assert.rejects(decideApproval(baton, { scope: 'a', approval: stale.id, expectedDigest: stale.digest, decision: 'allow' }), /stale/);
  const expired = await requestApproval(baton, { scope: 'a', job: job.id, ...binding }); advance(301);
  await assert.rejects(decideApproval(baton, { scope: 'a', approval: expired.id, expectedDigest: expired.digest, decision: 'allow' }), /expired/);
});

test('atomic scoped store preserves concurrent writers and refuses corrupt state', async t => {
  const { config } = await fixture(t), store = new Store(config.stateDir);
  await Promise.all(Array.from({ length: 25 }, () => store.change('a', state => { state.count = (state.count || 0) + 1; })));
  assert.equal((await store.read('a')).count, 25);
  assert.equal((await store.read('b')).count, undefined);
  await writeFile(store.path('a'), '{bad'); await assert.rejects(store.change('a', () => {}));
  assert.equal(await readFile(store.path('a'), 'utf8'), '{bad');
});

test('native wrapper never invokes a shell and pins endpoint independently of caller environment', async () => {
  const calls = [];
  const herdr = new Herdr({ herdr: '/verified/herdr', machine: 'personal' }, async (...args) => { calls.push(args); return { stdout: '{"result":{"type":"agent_prompted"}}' }; });
  await herdr.prompt('w1:p1', 'literal $(touch nope); text');
  assert.deepEqual(calls[0][1], ['--machine', 'personal', 'agent', 'prompt', 'w1:p1', 'literal $(touch nope); text']);
  assert.equal(calls[0][2].shell, false);
  assert.ok(!Object.keys(calls[0][2].env).some(key => key.startsWith('HERDR_')));
  const native = { pane_id: 'w1:p1', terminal_id: 't1', workspace_id: 'w1', agent: 'codex', interactive_ready: true, processIdentity: { group: 1, pids: [5] } };
  const saved = identity(native); assert.ok(sameAgent(saved, native));
  assert.ok(!sameAgent(saved, { ...native, processIdentity: { group: 1, pids: [6] } }));
});

test('native pane close uses only the exact pane ID and never invokes a shell', async () => {
  const calls = [];
  const herdr = new Herdr({ herdr: '/verified/herdr' }, async (...args) => { calls.push(args); return { stdout: '{"result":{"type":"pane_closed","pane_id":"w1:p1"}}' }; });
  await herdr.close('w1:p1');
  assert.deepEqual(calls[0][1], ['pane', 'close', 'w1:p1']);
  assert.equal(calls[0][2].shell, false);
});

test('cleanup previews verified owned panes, applies after grace, archives output, and is idempotent', async t => {
  const { baton, herdr, dispatch, advance } = await fixture(t);
  enableCleanup(baton, 'preview');
  const job = await dispatch(); await verifyJob(baton, job); advance(61);
  await baton.change('a', state => { delete state.jobs[job.id].cleanupOwned; }); // Existing v2 jobs use the Baa-ton-generated native label.
  const preview = await baton.tick({ scope: 'a' });
  assert.deepEqual(preview.cleanup.candidates.map(candidate => candidate.pane), [job.pane]);
  assert.equal(herdr.calls.some(call => call[0] === 'close'), false);

  baton.config.cleanup.mode = 'close';
  const applied = await baton.tick({ scope: 'a' });
  assert.deepEqual(applied.cleanup.closed.map(candidate => candidate.pane), [job.pane]);
  assert.equal(herdr.calls.filter(call => call[0] === 'close').length, 1);
  const saved = (await baton.state('a')).jobs[job.id];
  assert.equal(saved.cleanup.status, 'closed');
  assert.equal(saved.cleanup.transcript.text, 'observed output');
  assert.equal(saved.result.evidence.summary, proof.summary);
  assert.equal(saved.cwd, job.cwd);

  await baton.tick({ scope: 'a' });
  assert.equal(herdr.calls.filter(call => call[0] === 'close').length, 1);
});

test('native idle alone, blocked attention, and stalled work are never cleanup candidates', async t => {
  const { baton, herdr, dispatch, advance } = await fixture(t);
  enableCleanup(baton);
  const idle = await dispatch(); herdr.agents.get(idle.pane).agent_status = 'idle'; advance(61);
  assert.deepEqual((await baton.tick({ scope: 'a' })).cleanup.closed, []);
  assert.equal(herdr.calls.some(call => call[0] === 'close'), false);

  await verifyJob(baton, idle);
  herdr.agents.get(idle.pane).agent_status = 'blocked'; advance(61);
  const waiting = await baton.tick({ scope: 'a' });
  assert.ok(waiting.cleanup.blocked.some(item => item.reason.includes('user attention')));
  assert.equal(herdr.calls.some(call => call[0] === 'close'), false);

  const stalled = await dispatch('a', { requestId: 'stalled' });
  await baton.change('a', state => { state.jobs[stalled.id].status = 'stalled'; });
  await baton.tick({ scope: 'a' });
  assert.equal(herdr.calls.some(call => call[0] === 'close'), false);
});

test('cleanup never closes adopted or reconnected user panes', async t => {
  const { baton, herdr, dispatch, advance } = await fixture(t);
  enableCleanup(baton);
  const job = await dispatch(); await verifyJob(baton, job); advance(61);
  await baton.change('a', state => { state.jobs[job.id].cleanupOwned = false; state.jobs[job.id].adopted = true; });
  const result = await baton.tick({ scope: 'a' });
  assert.ok(result.cleanup.blocked.some(item => item.reason.includes('not Baa-ton-created')));
  assert.equal(herdr.calls.some(call => call[0] === 'close'), false);
});

test('legacy reconnected jobs without ownership metadata are never cleanup candidates', async t => {
  const { baton, herdr, dispatch, advance } = await fixture(t);
  enableCleanup(baton);
  const job = await dispatch();
  const replacement = { ...herdr.agents.get(job.pane), pane_id: 'wa:p-replacement', terminal_id: 't-replacement' };
  herdr.agents.set(replacement.pane_id, replacement);
  const reconnected = await baton.reconnect({ scope: 'a', job: job.id, pane: replacement.pane_id, expectedTerminal: replacement.terminal_id });
  await baton.change('a', state => { delete state.jobs[job.id].cleanupOwned; }); // Simulate state written before cleanup ownership was tracked.
  await baton.result({ scope: 'a', action: 'submit', job: job.id, revision: reconnected.revision, evidence: proof });
  await baton.result({ scope: 'a', action: 'verify', job: job.id, revision: reconnected.revision, reviewer: 'human', evidence: proof });
  advance(61);
  const result = await baton.tick({ scope: 'a' });
  assert.ok(result.cleanup.blocked.some(item => item.reason.includes('not Baa-ton-created')));
  assert.equal(herdr.calls.some(call => call[0] === 'close'), false);
});

test('cleanup preview requires transcript archival to be possible', async t => {
  const { baton, herdr, dispatch, advance } = await fixture(t);
  enableCleanup(baton, 'preview');
  const job = await dispatch(); await verifyJob(baton, job); advance(61);
  herdr.read = async () => '';
  const result = await baton.tick({ scope: 'a' });
  assert.deepEqual(result.cleanup.candidates, []);
  assert.ok(result.cleanup.blocked.some(item => item.reason.includes('transcript is empty')));
  assert.equal(herdr.calls.some(call => call[0] === 'close'), false);
});

test('approval creation that races a cleanup claim is rejected transactionally', async t => {
  const { baton, dispatch } = await fixture(t);
  const job = await dispatch('a', { profile: 'review' });
  const originalChange = baton.change.bind(baton); let seeded = false;
  baton.change = async (scope, mutate) => {
    if (!seeded) {
      seeded = true;
      await originalChange(scope, state => { state.jobs[job.id].cleanup = { status: 'closing', claim: 'close-test' }; });
    }
    return originalChange(scope, mutate);
  };
  await assert.rejects(requestApproval(baton, { scope: 'a', job: job.id, session: `session-${job.id}`, tool: 'Read', input: { file_path: '/tmp/file' } }), /cleanup is in progress/);
  const state = await baton.state('a');
  assert.equal(Object.values(state.approvals).filter(request => request.job === job.id).length, 0);
});

test('cancel is refused after a cleanup claim', async t => {
  const { baton, herdr, dispatch, advance } = await fixture(t);
  enableCleanup(baton);
  const job = await dispatch(); await verifyJob(baton, job); advance(61);
  await baton.change('a', state => { state.jobs[job.id].cleanup = { status: 'closing', claim: 'close-test' }; });
  const before = herdr.calls.filter(call => call[0] === 'close').length;
  await assert.rejects(baton.cancel({ scope: 'a', job: job.id, reason: 'Stop cleanup.' }), /cleanup is in progress/);
  assert.equal(herdr.calls.filter(call => call[0] === 'close').length, before);
});

test('cleanup refuses pending approvals, active descendants, and dirty worktrees', async t => {
  const { baton, herdr, dispatch, advance } = await fixture(t);
  enableCleanup(baton);
  const job = await dispatch(); await verifyJob(baton, job); advance(61);
  await baton.change('a', state => { state.approvals.waiting = { id: 'waiting', job: job.id, status: 'pending' }; });
  const approval = await baton.tick({ scope: 'a' });
  assert.ok(approval.cleanup.blocked.some(item => item.reason.includes('pending approval')));
  assert.equal(herdr.calls.some(call => call[0] === 'close'), false);

  const { baton: descendantBaton, herdr: descendantHerdr, dispatch: dispatchParent, advance: advanceDescendant } = await fixture(t);
  enableCleanup(descendantBaton);
  const parent = await dispatchParent();
  await descendantBaton.result({ scope: 'a', action: 'submit', job: parent.id, revision: 0, evidence: proof });
  await descendantBaton.dispatch({ scope: 'a', profile: 'review', task: 'Review the result.', access: 'read', reviewOf: parent.id, requestId: 'reviewer' });
  await descendantBaton.result({ scope: 'a', action: 'verify', job: parent.id, revision: 0, reviewer: 'human', evidence: proof });
  advanceDescendant(61);
  const descendants = await descendantBaton.tick({ scope: 'a' });
  assert.ok(descendants.cleanup.blocked.some(item => item.reason.includes('active descendant reviewer')));
  assert.equal(descendantHerdr.calls.some(call => call[0] === 'close'), false);

  const { baton: dirtyBaton, herdr: dirtyHerdr, dispatch: dispatchDirty, advance: advanceDirty } = await fixture(t);
  enableCleanup(dirtyBaton);
  const dirty = await dispatchDirty(); await verifyJob(dirtyBaton, dirty); advanceDirty(61);
  dirtyBaton.workspaceStatus = async () => ' M changed.txt\n';
  const dirtyResult = await dirtyBaton.tick({ scope: 'a' });
  assert.ok(dirtyResult.cleanup.blocked.some(item => item.reason.includes('unrecorded changes')));
  assert.equal(dirtyHerdr.calls.some(call => call[0] === 'close'), false);
});

test('cleanup fails closed on stale session/process identity and scopes across workspaces', async t => {
  const { baton, herdr, dispatch, advance } = await fixture(t);
  enableCleanup(baton);
  const stale = await dispatch(); await verifyJob(baton, stale); advance(61);
  herdr.agents.get(stale.pane).agent_session.value = 'replacement-session';
  const blocked = await baton.tick({ scope: 'a' });
  assert.ok(blocked.cleanup.blocked.some(item => item.reason.includes('identity is stale')));
  assert.equal(herdr.calls.some(call => call[0] === 'close'), false);

  for (const mutate of [
    live => { live.agent_status = 'working'; },
    live => { live.state_change_seq++; },
    live => { live.processIdentity.pids = [999]; },
  ]) {
    const { baton: swappedBaton, herdr: swappedHerdr, dispatch: dispatchSwapped, advance: advanceSwapped } = await fixture(t);
    enableCleanup(swappedBaton);
    const swapped = await dispatchSwapped(); await verifyJob(swappedBaton, swapped); advanceSwapped(61);
    const get = swappedHerdr.get.bind(swappedHerdr); let reads = 0;
    swappedHerdr.get = async pane => {
      reads++;
      if (reads === 3) mutate(swappedHerdr.agents.get(pane));
      return get(pane);
    };
    const changedAfterClaim = await swappedBaton.tick({ scope: 'a' });
    assert.ok(changedAfterClaim.cleanup.blocked.some(item => item.reason.includes('changed after cleanup claim')));
    assert.equal((await swappedBaton.state('a')).jobs[swapped.id].cleanup.status, 'aborted');
    assert.equal(swappedHerdr.calls.some(call => call[0] === 'close'), false);
  }

  const { baton: processBaton, herdr: processHerdr, dispatch: dispatchProcess, advance: advanceProcess } = await fixture(t);
  enableCleanup(processBaton);
  const processJob = await dispatchProcess(); await verifyJob(processBaton, processJob); advanceProcess(61);
  processHerdr.agents.get(processJob.pane).processIdentity.pids = [999];
  const changedProcess = await processBaton.tick({ scope: 'a' });
  assert.ok(changedProcess.cleanup.blocked.some(item => item.reason.includes('foreground process identity changed')));
  assert.equal(processHerdr.calls.some(call => call[0] === 'close'), false);

  const { baton: multi, herdr: multiHerdr, dispatch: multiDispatch, advance: advanceMulti } = await fixture(t);
  enableCleanup(multi);
  const a = await multiDispatch('a'); const b = await multiDispatch('b');
  await verifyJob(multi, a, 'a'); await verifyJob(multi, b, 'b'); advanceMulti(61);
  const before = multiHerdr.calls.length;
  await multi.tick({ scope: 'a' });
  const aCloses = multiHerdr.calls.filter((call, index) => index >= before && call[0] === 'close').map(call => call[1]);
  assert.deepEqual(aCloses, [a.pane]);
  assert.equal(multiHerdr.calls.slice(before).some(call => call[0] === 'list'), false);
  const afterA = multiHerdr.calls.length;
  await multi.tick({ scope: 'b' });
  const bCloses = multiHerdr.calls.filter((call, index) => index >= afterA && call[0] === 'close').map(call => call[1]);
  assert.deepEqual(bCloses, [b.pane]);
});

test('cleanup policy config is explicit and rejects unsafe or unbounded options', async t => {
  const { config } = await fixture(t);
  config.cleanup = { mode: 'preview', idleGraceSeconds: 3600 };
  assert.doesNotThrow(() => validateConfig(config));
  config.cleanup.mode = 'close-all';
  assert.throws(() => validateConfig(config), /mode must be/);
  config.cleanup = { mode: 'close', idleGraceSeconds: 1 };
  assert.throws(() => validateConfig(config), /idleGraceSeconds/);
  config.cleanup = { mode: 'close', allWorkspaces: true };
  assert.throws(() => validateConfig(config), /only mode and idleGraceSeconds/);
});

test('read-only Git guard detects untracked worktree changes', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'baa-cleanup-git-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  execFileSync('git', ['-C', repo, 'init', '--quiet'], { shell: false });
  assert.equal(await gitChanges(repo), '');
  await writeFile(join(repo, 'unrecorded.txt'), 'keep me');
  assert.match(await gitChanges(repo), /unrecorded\.txt/);
});

test('schema validation rejects unknown actions/properties before mutation', async t => {
  const { baton } = await fixture(t);
  await assert.rejects(invoke(baton, 'herdr_goal', { scope: 'a', action: 'delete' }), /one of/);
  await assert.rejects(invoke(baton, 'herdr_tick', { scope: 'a', all: true }), /not supported/);
  await assert.rejects(invoke(baton, 'shell', { command: 'anything' }), /not available/);
  assert.equal((await baton.state('a')).revision, 0);
});

test('launch mappings keep native permissions and do not overwrite project configuration', async t => {
  const { config } = await fixture(t);
  const sentinel = join(config.scopes.a.cwd, 'opencode.json'); await writeFile(sentinel, 'preserve');
  for (const harness of ['codex', 'claude', 'pi', 'opencode']) {
    const prepared = await launch(config, 'a', { id: harness, access: 'write' }, { harness, model: 'exact-model', effort: 'low', provider: 'openai' });
    assert.ok(prepared.argv.includes('exact-model') || prepared.argv.includes('openai/exact-model'));
    assert.ok(!prepared.argv.join(' ').includes('bypass'));
    if (harness === 'opencode') assert.equal(JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT).provider.openai.models['exact-model'].options.reasoningEffort, 'low');
  }
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve');
});

test('uncertain send fences every later message until explicit user redirection', async t => {
  const { baton, herdr, dispatch } = await fixture(t);
  await dispatch(); herdr.error = Object.assign(new Error('reply lost'), { uncertain: true });
  await baton.message({ scope: 'a', job: 'job1', text: 'ambiguous', requestId: 'lost' }); delete herdr.error;
  const before = herdr.calls.filter(call => call[0] === 'prompt').length;
  await baton.message({ scope: 'a', job: 'job1', text: 'queued next', requestId: 'next' });
  await baton.tick({ scope: 'a' });
  assert.equal(herdr.calls.filter(call => call[0] === 'prompt').length, before);
  await baton.message({ scope: 'a', job: 'job1', text: 'Human inspected; new task', requestId: 'new', redirect: true });
  assert.equal(herdr.calls.filter(call => call[0] === 'prompt').length, before + 1);
  assert.equal((await baton.state('a')).messages.lost.previousStatus, 'uncertain');
});

test('worker records direct human intervention without sending the completed task again', async t => {
  const { baton, config, herdr, dispatch } = await fixture(t);
  const job = await dispatch(); herdr.agents.get(job.pane).agent_status = 'working';
  const worker = new Baton(config, { herdr, scope: 'a', worker: job.id });
  const message = await worker.message({ job: job.id, text: 'New user task already in context', requestId: 'direct', redirect: true });
  assert.equal(message.status, 'recorded');
  await worker.result({ action: 'submit', job: job.id, revision: 1, evidence: proof });
  const before = herdr.calls.length; herdr.agents.get(job.pane).agent_status = 'idle';
  await baton.tick({ scope: 'a' }); assert.equal(herdr.calls.length, before);
});

test('messages drain without a goal; no watchdog is created implicitly', async t => {
  const { baton, herdr, dispatch } = await fixture(t);
  const job = await dispatch(); herdr.agents.get(job.pane).agent_status = 'working';
  await baton.message({ scope: 'a', job: job.id, text: 'queued', requestId: 'later' });
  assert.equal((await baton.state('a')).messages.later.status, 'pending');
  herdr.agents.get(job.pane).agent_status = 'idle'; await baton.tick({ scope: 'a' });
  assert.equal((await baton.state('a')).messages.later.status, 'delivered');
  assert.equal((await baton.state('a')).goal, null);
});

test('pause during native start holds assignment; resume drains without launching again', async t => {
  const { baton, herdr, dispatch } = await fixture(t);
  await baton.goal({ scope: 'a', action: 'set', objective: 'Work' });
  const start = herdr.start.bind(herdr);
  herdr.start = async (...args) => { const result = await start(...args); await baton.goal({ scope: 'a', action: 'pause' }); return result; };
  await dispatch();
  assert.equal(herdr.calls.filter(call => call[0] === 'prompt').length, 0);
  await baton.goal({ scope: 'a', action: 'resume' }); await baton.tick({ scope: 'a' });
  assert.equal(herdr.calls.filter(call => call[0] === 'start').length, 1);
  assert.equal(herdr.calls.filter(call => call[0] === 'prompt').length, 1);
});

test('pause during resource creation holds start; same-ID retry resumes without duplicate resource', async t => {
  const { baton, herdr, dispatch } = await fixture(t);
  await baton.goal({ scope: 'a', action: 'set', objective: 'Work' });
  const create = herdr.create.bind(herdr);
  herdr.create = async (...args) => { const result = await create(...args); await baton.goal({ scope: 'a', action: 'pause' }); return result; };
  const held = await dispatch(); assert.equal(held.status, 'ready-to-start');
  assert.equal(herdr.calls.filter(call => call[0] === 'start').length, 0);
  await baton.goal({ scope: 'a', action: 'resume' }); await Promise.all([dispatch(), dispatch()]);
  assert.equal(herdr.calls.filter(call => call[0] === 'create').length, 1);
  assert.equal(herdr.calls.filter(call => call[0] === 'start').length, 1);
});

test('old reviewer cannot approve a redirected result and read-only worker cannot spawn writer', async t => {
  const { baton, config, herdr, dispatch } = await fixture(t);
  const writer = await dispatch(); await baton.result({ scope: 'a', action: 'submit', job: writer.id, revision: 0, evidence: proof });
  const reviewer = await dispatch('a', { requestId: 'reviewer', profile: 'review', reviewOf: writer.id });
  await baton.message({ scope: 'a', job: writer.id, text: 'Changed', requestId: 'changed', redirect: true });
  await baton.result({ scope: 'a', action: 'submit', job: writer.id, revision: 1, evidence: proof });
  await assert.rejects(baton.result({ scope: 'a', action: 'verify', job: writer.id, revision: 1, reviewer: reviewer.id, evidence: proof }), /earlier result/);
  const worker = new Baton(config, { herdr, worker: reviewer.id, scope: 'a' });
  await assert.rejects(worker.dispatch({ profile: 'fast', task: 'Write', access: 'write', branch: 'unauthorized', requestId: 'writer2' }), /read-only/);
});

test('long dispatch IDs work and explicit cancel recovers capacity without native interruption', async t => {
  const { baton, config, herdr, dispatch } = await fixture(t); config.maxActive = 1;
  const job = await dispatch('a', { requestId: 'x'.repeat(80) });
  assert.equal(job.status, 'running');
  await assert.rejects(dispatch(), /limit reached/);
  const before = herdr.calls.length;
  const cancelled = await baton.cancel({ scope: 'a', job: job.id, reason: 'Human cancelled this orchestration.' });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(herdr.calls.length, before);
  await dispatch();
});

test('process fallback survives normal native session discovery; changed process still refuses', async () => {
  const native = { pane_id: 'w1:p1', terminal_id: 't', workspace_id: 'w1', agent: 'codex', interactive_ready: true, processIdentity: { group: 1, pids: [22] } };
  const saved = identity(native);
  assert.ok(sameAgent(saved, { ...native, agent_session: { kind: 'id', value: 'newly-discovered' } }));
  assert.ok(!sameAgent(saved, { ...native, agent_session: { kind: 'id', value: 'replacement' }, processIdentity: { group: 1, pids: [23] } }));
});

test('cancel during create or start never revives work or accepts a late result', async t => {
  for (const phase of ['create', 'start']) {
    const { baton, herdr, dispatch } = await fixture(t);
    const original = herdr[phase].bind(herdr);
    herdr[phase] = async (...args) => { const value = await original(...args); await baton.cancel({ scope: 'a', job: 'job1', reason: 'Human cancelled during launch.' }); return value; };
    const job = await dispatch();
    assert.equal(job.status, 'cancelled');
    assert.equal(herdr.calls.filter(call => call[0] === 'prompt').length, 0);
    await assert.rejects(baton.result({ scope: 'a', action: 'submit', job: 'job1', revision: job.revision, evidence: proof }), /cancelled/);
  }
});

test('first native session is pinned after process discovery; a later same-process session is fenced', async t => {
  const { baton, herdr, dispatch } = await fixture(t);
  const job = await dispatch(), live = herdr.agents.get(job.pane);
  live.processIdentity = { group: 123, pids: [123] };
  const fallback = identity({ ...live, agent_session: undefined });
  await baton.change('a', state => { state.jobs.job1.identity = fallback; });
  await baton.status({ scope: 'a', job: 'job1' });
  assert.equal((await baton.state('a')).jobs.job1.identity.session.value, 'session-job1');
  live.agent_session.value = 'new-session-same-process';
  assert.equal((await baton.status({ scope: 'a', job: 'job1' })).identityMatches, false);
  const before = herdr.calls.filter(call => call[0] === 'prompt').length;
  await baton.message({ scope: 'a', job: 'job1', requestId: 'stale', text: 'Must not reach another session.' });
  assert.equal(herdr.calls.filter(call => call[0] === 'prompt').length, before);
});

test('late failed delivery cannot restore uncertainty after reconnect', async t => {
  const { baton, herdr, dispatch } = await fixture(t);
  const job = await dispatch(); let rejectSend, sending;
  const began = new Promise(resolve => { sending = resolve; });
  herdr.prompt = async () => { sending(); await new Promise((_, reject) => { rejectSend = reject; }); };
  const pending = baton.message({ scope: 'a', job: 'job1', text: 'Old task', requestId: 'old' });
  await began;
  const replacement = { ...herdr.agents.get(job.pane), pane_id: 'replacement', terminal_id: 't-new', agent_session: { kind: 'id', value: 'new', source: 'native', agent: 'codex' } };
  herdr.agents.set('replacement', replacement);
  await baton.reconnect({ scope: 'a', job: 'job1', pane: 'replacement', expectedTerminal: 't-new' });
  rejectSend(Object.assign(new Error('timeout after reconnect'), { uncertain: true })); await pending;
  assert.equal((await baton.state('a')).messages.old.status, 'superseded');
  herdr.prompt = FakeHerdr.prototype.prompt.bind(herdr);
  assert.equal((await baton.message({ scope: 'a', job: 'job1', text: 'New task', requestId: 'new' })).status, 'delivered');
});

test('missing pane does not starve another queued job and maximum task length launches', async t => {
  const { baton, herdr, dispatch } = await fixture(t);
  const first = await dispatch('a', { task: 'x'.repeat(16000) });
  const second = await dispatch('a', { requestId: 'second' });
  for (const job of [first, second]) { herdr.agents.get(job.pane).agent_status = 'working'; await baton.message({ scope: 'a', job: job.id, text: 'queued', requestId: job.id + '-queued' }); }
  herdr.agents.delete(first.pane); herdr.agents.get(second.pane).agent_status = 'idle';
  await baton.tick({ scope: 'a' });
  const state = await baton.state('a');
  assert.equal(state.messages['job1-queued'].status, 'pending'); assert.match(state.messages['job1-queued'].reason, /missing/);
  assert.equal(state.messages['second-queued'].status, 'delivered');
});

test('native permission broker refuses process-only and switched same-process sessions', async t => {
  const { baton, herdr, dispatch } = await fixture(t);
  const job = await dispatch('a', { profile: 'review' }), native = herdr.agents.get(job.pane);
  const binding = { scope: 'a', job: 'job1', session: 'session-job1', tool: 'Read', input: { file_path: '/tmp/file' } };
  const request = await requestApproval(baton, binding);
  native.processIdentity = { group: 1, pids: [1] };
  delete native.agent_session;
  await assert.rejects(requestApproval(baton, binding), /identity changed|native session/);
  native.agent_session = { kind: 'id', source: 'native', agent: 'claude', value: 'new-same-process-session' };
  await assert.rejects(decideApproval(baton, { scope: 'a', approval: request.id, expectedDigest: request.digest, decision: 'allow' }), /target changed|Identity changed/);
  await baton.change('a', state => { state.approvals[request.id].status = 'allow'; });
  assert.equal(await consumeApproval(baton, 'a', request.id, { session: binding.session, tool: binding.tool, input: binding.input }), undefined);
});

test('stale worker session cannot report and cancelled reviewer cannot verify', async t => {
  const { baton, config, herdr, dispatch } = await fixture(t);
  const job = await dispatch(), worker = new Baton(config, { herdr, scope: 'a', worker: 'job1' });
  const native = herdr.agents.get(job.pane), original = native.agent_session.value;
  native.agent_session.value = 'another-session';
  await assert.rejects(worker.result({ action: 'submit', job: 'job1', revision: 0, evidence: proof }), /session changed/);
  native.agent_session.value = original;
  await worker.result({ action: 'submit', job: 'job1', revision: 0, evidence: proof });
  await dispatch('a', { requestId: 'reviewer', reviewOf: 'job1' });
  await baton.cancel({ scope: 'a', job: 'reviewer', reason: 'Human stopped this review.' });
  await assert.rejects(baton.result({ scope: 'a', action: 'verify', job: 'job1', revision: 0, reviewer: 'reviewer', evidence: proof }), /cancelled/);
});

test('all worker launch adapters exclude the canonical controlling connection', async t => {
  const { config } = await fixture(t);
  for (const harness of ['codex', 'claude', 'pi', 'opencode']) {
    const result = await launch(config, 'a', { id: 'worker-' + harness, access: 'read' }, { harness, model: 'exact', effort: 'low', provider: 'openai' });
    if (harness === 'codex') assert.ok(result.argv.includes('mcp_servers.baa-ton-native={command="node",args=[],enabled=false}'));
    if (harness === 'claude') assert.ok(result.argv.includes('--strict-mcp-config'));
    if (harness === 'pi') { assert.ok(result.argv.includes('--no-extensions')); assert.ok(result.argv.includes('--extension')); }
    if (harness === 'opencode') assert.equal(JSON.parse(result.env.OPENCODE_CONFIG_CONTENT).mcp['baa-ton-native'].enabled, false);
  }
});

test('long durable IDs receive distinct native labels under32 characters and collision refuses before create', async t => {
  const { baton, herdr, dispatch } = await fixture(t);
  const key = 'a'.repeat(80), a = await dispatch('a', { requestId: key }), b = await dispatch('b', { requestId: key });
  assert.equal(a.id, key); assert.match(a.agentName, /^[A-Za-z0-9_-]{1,32}$/); assert.notEqual(a.agentName, b.agentName);
  const { digest } = await import('../src/store.mjs');
  const collided = `b-${digest({ scope: 'a', key: 'collision' }).slice(0, 28)}`;
  herdr.agents.set('occupied', { name: collided });
  const before = herdr.calls.filter(call => call[0] === 'create').length;
  await assert.rejects(dispatch('a', { requestId: 'collision' }), /label already exists/);
  assert.equal(herdr.calls.filter(call => call[0] === 'create').length, before);
});

test('native shell initialization busy rejection retries once; ambiguous start never retries', async t => {
  const { baton, herdr, dispatch } = await fixture(t), start = herdr.start.bind(herdr); let attempts = 0;
  herdr.start = async (...args) => { if (++attempts === 1) throw Object.assign(new Error('shell starting'), { nativeCode: 'agent_pane_busy', uncertain: false }); return start(...args); };
  assert.equal((await dispatch()).status, 'running'); assert.equal(attempts, 2);
  attempts = 0; herdr.start = async () => { attempts++; throw Object.assign(new Error('reply lost'), { uncertain: true }); };
  await assert.rejects(dispatch('a', { requestId: 'uncertain-start' }), /reply lost/); assert.equal(attempts, 1);
});
