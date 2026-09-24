import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { rootRecoveryPlan, commitRootRecovery, assertNoPendingRecovery } from '../root-recovery.mjs';
const require = createRequire(import.meta.url);
const { default: extension } = await require('jiti')(import.meta.url).import('../index.ts');
const root = (pane, workspace) => ({ target: pane, target_kind: 'pane_id', pane_id: pane, workspace_id: workspace, agent_kind: 'pi' });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'baa-root-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'project'), configDir = join(dir, 'config');
  const manifestPath = join(cwd, '.baa-ton/herdr-orchestrator/manifest.json'), configPath = join(configDir, 'config.json');
  await mkdir(join(cwd, '.baa-ton/herdr-orchestrator'), { recursive: true });
  await mkdir(configDir, { mode: 0o700 });
  const old = root('w-old:p1', 'w-old'), current = root('w-new:p1', 'w-new');
  const route = { workflow_id: 'herdr-done', manifest_path: manifestPath, lanes: [{ lane_id: 'lane-1', target: 'w-old:p2', target_kind: 'pane_id', pane_id: 'w-old:p2', workspace_id: 'w-old' }] };
  const config = { version: 2, owner: 'herdr-orchestrator', orchestrators: [
    { id: 'old-root', root: old, program: { id: cwd, workspace_id: 'w-old', parent_manifest_path: manifestPath }, workflows: [route] },
    { id: 'other-root', root: root('w-other:p1', 'w-other'), program: { id: join(dir, 'other'), workspace_id: 'w-other' }, workflows: [] },
  ] };
  const session = { kind: 'root', paneId: current.pane_id, workspaceId: current.workspace_id, sessionRef: { kind: 'file', path: join(dir, 'current.jsonl') }, startedAt: new Date().toISOString(), status: 'idle' };
  const binding = { rootPaneId: old.pane_id, workspaceId: old.workspace_id, rootSessionPath: join(dir, 'old.jsonl') };
  const manifest = { version: 2, workflows: [
    { id: 'herdr-done', status: 'completed', taskBinding: binding, lanes: [{ id: 'lane-1', status: 'completed', completionReceipt: { id: 'receipt-1', summary: 'independently retained', delivery: 'delivered' } }], eventControllerRegistration: { root: old, workflow: route } },
    { id: 'herdr-unused', status: 'planned', taskBinding: binding, ownership: { paneIds: [], tabIds: [] }, lanes: [{ id: 'lane-1', status: 'planned' }] },
  ], sessionLog: { ...session, paneId: old.pane_id, workspaceId: old.workspace_id },
    parentGoals: { 'old-root': { rootId: 'old-root', root: old, objective: 'old goal' }, 'other-root': { rootId: 'other-root', objective: 'other goal' } },
    goalHistoryByRoot: { 'old-root': [{ objective: 'history' }] },
    rootQueues: { version: 1, roots: [{ version: 1, rootId: 'old-root', root: old, itemIds: ['queue-1'] }] },
    unknownField: 'preserve forward-compatible metadata',
  };
  const before = { config: JSON.stringify(config), manifest: JSON.stringify(manifest) };
  await writeFile(configPath, before.config, { mode: 0o600 });
  await writeFile(manifestPath, before.manifest, { mode: 0o600 });
  return { cwd, configDir, configPath, manifestPath, before, config, manifest, oldRootId: 'old-root', root: current, session, liveWorkspaceIds: ['w-new', 'w-other'], auditDir: join(cwd, '.baa-ton/herdr-orchestrator/root-recovery') };
}

test('migration preserves other roots, workflow provenance, receipts, queues and unknown metadata', async t => {
  const f = await fixture(t), original = structuredClone(f.manifest);
  const plan = rootRecoveryPlan(f);
  assert.deepEqual(f.manifest, original);
  assert.deepEqual(plan.config.orchestrators[1], f.config.orchestrators[1]);
  assert.deepEqual(plan.config.orchestrators[0].workflows, f.config.orchestrators[0].workflows);
  assert.deepEqual(plan.manifest.workflows.map(flow => flow.taskBinding), f.manifest.workflows.map(flow => flow.taskBinding));
  assert.deepEqual(plan.manifest.workflows.map(flow => flow.lanes), f.manifest.workflows.map(flow => flow.lanes));
  assert.equal(plan.manifest.unknownField, f.manifest.unknownField);
  assert.deepEqual(plan.manifest.parentGoals['other-root'], f.manifest.parentGoals['other-root']);
  assert.deepEqual(plan.manifest.goalHistoryByRoot[plan.newRootId], f.manifest.goalHistoryByRoot['old-root']);
  assert.deepEqual(plan.manifest.rootQueues.roots[0].itemIds, ['queue-1']);
  const result = await commitRootRecovery({ ...f, plan, evidence: 'Authorized isolated fixture migration' });
  assert.deepEqual(JSON.parse(await readFile(result.auditPath, 'utf8')).before, f.before);
  assert.deepEqual(JSON.parse(await readFile(f.manifestPath, 'utf8')), plan.manifest);
  await assertNoPendingRecovery(f.auditDir);
});

test('migration rejects live roots, child panes, foreign manifests, active and unreceipted work', async t => {
  const f = await fixture(t);
  assert.throws(() => rootRecoveryPlan({ ...f, liveWorkspaceIds: ['w-old', 'w-new'] }), /Old workspace/);
  assert.throws(() => rootRecoveryPlan({ ...f, cwd: '/wrong' }), /exact project/);
  assert.throws(() => rootRecoveryPlan({ ...f, root: root('w-old:p2', 'w-new') }), /child role/);
  for (const change of [flow => { flow.status = 'running'; }, flow => { delete flow.lanes[0].completionReceipt; }, flow => { flow.lanes[0].completionReceipt.summary = ' '; }]) {
    const manifest = structuredClone(f.manifest); change(manifest.workflows[0]);
    assert.throws(() => rootRecoveryPlan({ ...f, manifest }), /not quiescent/);
  }
  const manifest = structuredClone(f.manifest); manifest.workflows[1].lanes[0].startupIntentPath = '/startup';
  assert.throws(() => rootRecoveryPlan({ ...f, manifest }), /not quiescent/);
});

test('write failure rolls back and audits; changed inputs and pending crash journals refuse execution', async t => {
  const f = await fixture(t), plan = rootRecoveryPlan(f);
  await assert.rejects(commitRootRecovery({ ...f, plan, evidence: 'test', write: async (filename, bytes) => {
    if (filename === f.configPath) throw new Error('injected write failure');
    await writeFile(filename, bytes);
  } }), /injected/);
  assert.equal(await readFile(f.manifestPath, 'utf8'), f.before.manifest);
  assert.equal(await readFile(f.configPath, 'utf8'), f.before.config);
  await assertNoPendingRecovery(f.auditDir);
  await writeFile(f.configPath, f.before.config + '\n');
  await assert.rejects(commitRootRecovery({ ...f, plan, evidence: 'test' }), /inputs changed/);
  await writeFile(join(f.auditDir, 'crash.intent.json'), '{}');
  await assert.rejects(assertNoPendingRecovery(f.auditDir), /Unfinished recovery journal/);
  await writeFile(join(f.auditDir, 'crash.result.json'), '{}');
  await assert.rejects(assertNoPendingRecovery(f.auditDir), /Unfinished recovery journal/);
});

test('native tool verifies live identity, previews without writes, rejects stale fingerprints, then migrates', async t => {
  const f = await fixture(t), tools = new Map(), calls = [];
  const saved = Object.fromEntries(['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_PLUGIN_CONFIG_DIR'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: f.root.pane_id, HERDR_WORKSPACE_ID: f.root.workspace_id, HERDR_PLUGIN_CONFIG_DIR: f.configDir });
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  let oldAlive = false, probeError = 'agent_not_found';
  extension({ on() {}, registerCommand() {}, registerTool: tool => tools.set(tool.name, tool), async exec(command, args) {
    assert.equal(command, 'herdr'); calls.push(args);
    const ok = result => ({ stdout: JSON.stringify({ result }), stderr: '', code: 0 });
    if (args[0] === 'plugin' && args[1] === 'config-dir') return ok({ config_dir: f.configDir });
    if (args[0] === 'workspace' && args[1] === 'list') return ok({ workspaces: f.liveWorkspaceIds.map(workspace_id => ({ workspace_id })) });
    if (args[0] === 'agent' && args[1] === 'get') {
      if (args[2] === 'w-old:p1') return oldAlive ? ok({ type: 'agent_info', agent: {} }) : { stdout: JSON.stringify({ error: { code: probeError } }), stderr: '', code: 1 };
      return ok({ type: 'agent_info', agent: { agent: 'pi', pane_id: f.root.pane_id, workspace_id: f.root.workspace_id, agent_session: { kind: 'path', value: f.session.sessionRef.path } } });
    }
    throw new Error(`Unexpected mutating call ${args.join(' ')}`);
  } });
  const ctx = { cwd: f.cwd, sessionManager: { getSessionFile: () => f.session.sessionRef.path } };
  const run = params => tools.get('herdr_recover_root').execute('recovery', { oldRootId: f.oldRootId, ...params }, undefined, undefined, ctx);
  const preview = (await run({})).details;
  assert.equal(preview.mode, 'preview');
  assert.equal(await readFile(f.manifestPath, 'utf8'), f.before.manifest);
  assert.equal(await readFile(f.configPath, 'utf8'), f.before.config);
  await assert.rejects(run({ execute: true, expectedFingerprint: 'bad', evidence: 'authorized' }), /stale/);
  oldAlive = true; await assert.rejects(run({}), /still live/); oldAlive = false;
  probeError = 'internal_error'; await assert.rejects(run({}), /internal_error/); probeError = 'agent_not_found';
  await assert.rejects(run({ execute: true, expectedFingerprint: preview.fingerprint }), /authorization/);
  const result = (await run({ execute: true, expectedFingerprint: preview.fingerprint, evidence: 'User authorized this migration' })).details;
  assert.equal(result.mode, 'applied');
  assert.equal(JSON.parse(await readFile(f.configPath, 'utf8')).orchestrators[0].root.pane_id, f.root.pane_id);
  assert.equal((await readdir(f.auditDir)).length, 2);
  const status = await tools.get('herdr_goal').execute('status', { action: 'status' }, undefined, undefined, ctx);
  assert.equal(status.details.goal.objective, 'old goal', 'new root owns the retained goal');
  assert.ok(calls.every(args => ['agent', 'plugin', 'workspace'].includes(args[0])));
  await assert.rejects(run({}), /does not exist/);
});
