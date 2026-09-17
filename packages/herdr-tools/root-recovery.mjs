import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, readdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const recoveryHash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const receipt = lane => typeof lane?.completionReceipt?.id === 'string' && lane.completionReceipt.id.trim() &&
  typeof lane.completionReceipt.summary === 'string' && lane.completionReceipt.summary.trim();

// Input is the raw validated document, so unrelated and forward-compatible
// fields survive migration. Workflow taskBindings and receipts remain historical.
export function rootRecoveryPlan({ config, manifest, cwd, oldRootId, root, session, liveWorkspaceIds }) {
  if (config.version !== 2 || !Array.isArray(config.orchestrators) || manifest.version !== 2 || !Array.isArray(manifest.workflows))
    throw new Error('Recovery requires valid version-2 controller and manifest documents');
  const matches = config.orchestrators.filter(item => item.id === oldRootId);
  if (matches.length !== 1) throw new Error('Select exactly one existing root by its recorded ID');
  const old = matches[0];
  if (manifest.parentGoals?.version || Array.isArray(manifest.parentGoals?.roots)) throw new Error('Legacy scoped goal schema requires separate normalization before recovery');
  if (resolve(old.program.id) !== resolve(cwd) || resolve(old.program.parent_manifest_path ?? '') !== join(resolve(cwd), '.pi/herdr-orchestrator/manifest.json'))
    throw new Error('Selected root does not own this exact project manifest');
  if (!Array.isArray(liveWorkspaceIds) || !liveWorkspaceIds.includes(root.workspace_id) || liveWorkspaceIds.includes(old.root.workspace_id))
    throw new Error('Old workspace must be absent and current workspace must be live');
  if (config.orchestrators.some(item => item.root.pane_id === root.pane_id || item.root.workspace_id === root.workspace_id || item.workflows.some(flow => flow.lanes.some(lane => lane.pane_id === root.pane_id))))
    throw new Error('Current pane/workspace already has a controller owner or child role');
  const newId = `orchestrator:${root.workspace_id}:${root.pane_id}:${resolve(cwd)}`;
  if (config.orchestrators.some(item => item.id === newId)) throw new Error('New root ID already exists');
  if (!session?.sessionRef || session.paneId !== root.pane_id || session.workspaceId !== root.workspace_id)
    throw new Error('Current native session identity is required');
  const routed = new Set(old.workflows.map(flow => flow.workflow_id));
  for (const route of old.workflows) {
    if (resolve(route.manifest_path) !== join(resolve(cwd), '.pi/herdr-orchestrator/manifest.json')) throw new Error('Cross-manifest routes require separate recovery');
    if (manifest.workflows.filter(flow => flow.id === route.workflow_id).length !== 1) throw new Error('Routed workflow is missing or ambiguous');
  }
  const owned = manifest.workflows.filter(flow => routed.has(flow.id) ||
    (flow.taskBinding?.rootPaneId === old.root.pane_id && flow.taskBinding?.workspaceId === old.root.workspace_id));
  for (const flow of owned) {
    if (flow.taskBinding && (flow.taskBinding.rootPaneId !== old.root.pane_id || flow.taskBinding.workspaceId !== old.root.workspace_id))
      throw new Error(`Workflow ${flow.id} has a different historical owner`);
    const untouchedPlan = flow.status === 'planned' && !routed.has(flow.id) &&
      !(flow.ownership?.paneIds?.length || flow.ownership?.tabIds?.length || flow.ownership?.workspaceId || flow.taskBinding?.tabId || flow.eventControllerRegistration) &&
      Array.isArray(flow.lanes) && flow.lanes.length && flow.lanes.every(lane => lane.status === 'planned' && !lane.paneId && !lane.startupIntentPath && !lane.completionReceipt);
    if (!untouchedPlan && !(flow.status === 'completed' && flow.lanes?.length && flow.lanes.every(receipt)))
      throw new Error(`Workflow ${flow.id} is not quiescent with durable completion receipts or an untouched plan`);
    if (flow.eventControllerRegistration?.root && !same(flow.eventControllerRegistration.root, old.root))
      throw new Error(`Workflow ${flow.id} has a different registered root`);
  }
  const nextConfig = structuredClone(config), nextManifest = structuredClone(manifest);
  const next = nextConfig.orchestrators.find(item => item.id === oldRootId);
  next.id = newId;
  next.root = structuredClone(root);
  next.program.workspace_id = root.workspace_id;
  for (const field of ['parentGoals', 'goalHistoryByRoot']) {
    const store = nextManifest[field];
    if (store && Object.hasOwn(store, newId)) throw new Error(`Destination ${field} already exists`);
    if (store && Object.hasOwn(store, oldRootId)) {
      store[newId] = store[oldRootId];
      delete store[oldRootId];
      if (field === 'parentGoals') Object.assign(store[newId], { rootId: newId, root: structuredClone(root) });
    }
  }
  for (const entry of nextManifest.rootQueues?.roots ?? []) {
    if (entry.rootId === newId) throw new Error('Destination root queue already exists');
    if (entry.rootId === oldRootId) Object.assign(entry, { rootId: newId, root: structuredClone(root) });
  }
  const sessions = nextManifest.rootSessionLogs ??= [];
  if (sessions.some(entry => entry.rootId === newId)) throw new Error('Destination root session already exists');
  const oldIndex = sessions.findIndex(entry => entry.rootId === oldRootId);
  const newSession = { ...session, rootId: newId, root: structuredClone(root) };
  if (oldIndex === -1) sessions.push(newSession); else sessions[oldIndex] = newSession;
  if (nextManifest.sessionLog?.paneId === old.root.pane_id && nextManifest.sessionLog?.workspaceId === old.root.workspace_id)
    nextManifest.sessionLog = structuredClone(session);
  for (const flow of nextManifest.workflows) {
    if (owned.some(item => item.id === flow.id) && flow.eventControllerRegistration?.root)
      flow.eventControllerRegistration.root = structuredClone(root);
  }
  return { oldRootId, newRootId: newId, oldRoot: old.root, root, workflowIds: owned.map(flow => flow.id), config: nextConfig, manifest: nextManifest };
}

export async function readRecoveryFiles(configPath, manifestPath) {
  for (const filename of [configPath, manifestPath]) {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Recovery inputs must be regular files, not symlinks');
  }
  const config = await readFile(configPath, 'utf8'), manifest = await readFile(manifestPath, 'utf8');
  return { config, manifest };
}

export async function assertNoPendingRecovery(directory) {
  let entries;
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Recovery audit directory must be a real directory');
    entries = await readdir(directory);
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries.filter(name => name.endsWith('.intent.json'))) {
    try {
      const result = JSON.parse(await readFile(join(directory, entry.replace('.intent.json', '.result.json')), 'utf8'));
      if (!['applied', 'rolled-back'].includes(result.status)) throw new Error('Invalid recovery result');
    }
    catch (error) {
      throw new Error(`Unfinished recovery journal requires inspection: ${join(directory, entry)} (${error.message})`);
    }
  }
}

async function atomicWrite(filename, bytes) {
  const temporary = `${filename}.${randomUUID()}.recovery.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  await rename(temporary, filename);
}

// Caller holds both manifest and controller locks. The intent contains exact
// preimages before either document changes. A crash leaves an explicit pending
// journal; an ordinary write error rolls back only a still-matching first write.
export async function commitRootRecovery({ configPath, manifestPath, auditDir, before, plan, evidence, write = atomicWrite }) {
  await assertNoPendingRecovery(auditDir);
  const latest = await readRecoveryFiles(configPath, manifestPath);
  if (!same(latest, before)) throw new Error('Recovery inputs changed; preview again');
  await mkdir(auditDir, { recursive: true, mode: 0o700 });
  const id = randomUUID(), auditPath = join(auditDir, `${id}.intent.json`);
  const after = { config: `${JSON.stringify(plan.config, null, 2)}\n`, manifest: `${JSON.stringify(plan.manifest, null, 2)}\n` };
  await writeFile(auditPath, JSON.stringify({ version: 1, at: new Date().toISOString(), evidence, oldRootId: plan.oldRootId, newRootId: plan.newRootId, before, after }), { flag: 'wx', mode: 0o600 });
  let manifestWritten = false;
  try {
    await write(manifestPath, after.manifest);
    manifestWritten = true;
    await write(configPath, after.config);
  } catch (error) {
    const current = await readRecoveryFiles(configPath, manifestPath);
    if (current.config !== before.config || (manifestWritten && current.manifest !== after.manifest) || (!manifestWritten && current.manifest !== before.manifest))
      throw new Error(`Recovery interrupted with uncertain state; inspect ${auditPath}: ${error.message}`);
    if (manifestWritten) await atomicWrite(manifestPath, before.manifest);
    await writeFile(join(auditDir, `${id}.result.json`), JSON.stringify({ status: 'rolled-back', error: error.message }), { flag: 'wx', mode: 0o600 });
    throw error;
  }
  await writeFile(join(auditDir, `${id}.result.json`), JSON.stringify({ status: 'applied', at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  return { auditPath, oldRootId: plan.oldRootId, newRootId: plan.newRootId, root: plan.root, workflowIds: plan.workflowIds };
}
