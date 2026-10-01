import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import { digest } from './store.mjs';
import { sameAgent } from './herdr.mjs';

const exec = promisify(execFile);
const settled = new Set(['verified', 'cancelled']);

export const cleanupTranscriptLines = 2000;
export const cleanupTranscriptLimit = 512 * 1024;

export function sameForegroundProcess(saved, live) {
  return Boolean(saved?.process && live?.processIdentity && digest(saved.process) === digest(live.processIdentity));
}

export function activeDescendant(state, jobId) {
  const checked = new Set();
  const queue = [jobId];
  while (queue.length) {
    const parent = queue.shift();
    if (checked.has(parent)) continue;
    checked.add(parent);
    const reviewers = Object.values(state.jobs).filter(job => job.reviewOf === parent);
    for (const child of reviewers) {
      if (!settled.has(child.status)) return child.id;
      queue.push(child.id);
    }
    for (const chain of Object.values(state.chains || {})) {
      const index = chain.jobs?.indexOf(parent) ?? -1;
      if (index < 0) continue;
      for (const childId of chain.jobs.slice(index + 1)) {
        const child = state.jobs[childId];
        if (!child) continue;
        if (!settled.has(child.status)) return child.id;
        queue.push(childId);
      }
    }
  }
  return undefined;
}

export function cleanupBlockers(state, job, live, now, idleGraceSeconds) {
  const blockers = [];
  const legacyOwned = job.cleanupOwned === undefined && !job.adopted && job.access !== 'existing' && !job.previousIdentities?.length && /^b-[a-f0-9]{28}$/.test(job.agentName || '');
  if (!(job.cleanupOwned === true || legacyOwned) || job.adopted || job.access === 'existing') blockers.push('pane is not Baa-ton-created');
  if (job.status !== 'verified' || !job.result || !job.verification) blockers.push('verified result is missing');
  else if (job.verification.resultDigest !== digest(job.result)) blockers.push('verified result digest changed');
  if (job.cleanup?.status) blockers.push(`prior cleanup state is ${job.cleanup.status}`);
  if (!job.identity || !live || !sameAgent(job.identity, live)) blockers.push('native identity is stale or unavailable');
  else {
    if (live.workspace_id !== job.workspace || live.pane_id !== job.pane) blockers.push('pane is outside the recorded job workspace');
    if (!['idle', 'done'].includes(live.agent_status)) blockers.push(live.agent_status === 'blocked' ? 'agent is waiting for user attention' : 'agent is not idle');
    if (!sameForegroundProcess(job.identity, live)) blockers.push('foreground process identity changed or is unavailable');
    if (!Number.isSafeInteger(job.verification.stateChangeSeq) || live.state_change_seq !== job.verification.stateChangeSeq) blockers.push('native activity changed after verification');
  }
  const descendant = activeDescendant(state, job.id);
  if (descendant) blockers.push(`active descendant ${descendant}`);
  if (Object.values(state.messages).some(message => message.job === job.id && ['pending', 'sending', 'uncertain'].includes(message.status))) blockers.push('pending or uncertain message');
  if (Object.values(state.approvals).some(request => request.job === job.id && ['pending', 'allow'].includes(request.status))) blockers.push('pending approval');
  const quietSince = Math.max(job.verification?.at || 0, job.lastActivity || 0);
  if (!Number.isFinite(quietSince) || now - quietSince < idleGraceSeconds * 1000) blockers.push('idle grace has not elapsed');
  return blockers;
}

export async function gitChanges(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('Workspace path is unavailable.');
  const { stdout } = await exec('git', ['-C', cwd, 'status', '--porcelain=v1', '--untracked-files=all'], {
    timeout: 10000,
    maxBuffer: 256 * 1024,
    shell: false,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}
