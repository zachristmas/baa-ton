import { digest, id } from './store.mjs';
import { sameAgent } from './herdr.mjs';

// Approval is one decision for one live hook invocation. Never install allow rules,
// rewrite input, or replay an allow into another session/task revision.
export async function requestApproval(baton, { scope, job, session, tool, input }) {
  scope = baton.scope(scope);
  if (!session || !tool || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Incomplete native permission request.');
  if (JSON.stringify(input).length > 64000) throw new Error('Permission input exceeds 64 KiB. Use the native prompt.');
  const state = await baton.state(scope), target = state.jobs[job];
  if (!target || target.status === 'cancelled' || target.cleanup?.status || target.profile.harness !== 'claude' || target.profile.permissions !== 'broker') throw new Error('Job has no active native Claude approval broker.');
  const live = await baton.live(scope, target);
  if (!sameAgent(target.identity, live)) throw new Error('Permission request agent identity changed.');
  if (live.agent_session?.kind !== 'id' || live.agent_session.value !== session) throw new Error('A verified native session ID matching the hook session is required; use the native prompt until it is available.');
  return baton.change(scope, latest => {
    const current = latest.jobs[job];
    if (current.cleanup?.status) throw new Error('Pane cleanup is in progress or needs inspection; approval cannot be added.');
    if (current.revision !== target.revision || !sameAgent(current.identity, live)) throw new Error('Task changed during permission request.');
    const request = { id: id('approval'), job, session, tool, input, identity: current.identity, revision: current.revision, createdAt: baton.now(), expiresAt: baton.now() + 300000, status: 'pending' };
    request.digest = digest({ id: request.id, job, session, tool, input, identity: request.identity, revision: request.revision, expiresAt: request.expiresAt });
    latest.approvals[request.id] = request;
    return request;
  });
}

export async function decideApproval(baton, { scope, approval, expectedDigest, decision }) {
  if (baton.worker) throw new Error('Workers cannot approve their own requests. Use the controlling client or the native permission prompt.');
  if (!['allow', 'deny'].includes(decision)) throw new Error('Decision must be allow or deny.');
  scope = baton.scope(scope);
  const state = await baton.state(scope), request = state.approvals[approval];
  if (!request) throw new Error('Unknown approval.');
  const live = await baton.live(scope, state.jobs[request.job]);
  if (!sameAgent(request.identity, live) || !sameAgent(state.jobs[request.job].identity, live) || live.agent_session?.kind !== 'id' || live.agent_session.value !== request.session) throw new Error('Approval target changed.');
  return baton.change(scope, latest => {
    const current = latest.approvals[approval], job = latest.jobs[current.job];
    if (current.status !== 'pending' || current.expiresAt <= baton.now() || current.digest !== expectedDigest || current.revision !== job.revision || !sameAgent(job.identity, live)) throw new Error('Approval is stale, already decided, expired, or has a different digest.');
    if (latest.goal?.status === 'paused' && decision === 'allow') throw new Error('Scope is paused. Resume or use the native prompt.');
    current.status = decision; current.decidedAt = baton.now();
    return current;
  });
}

export async function consumeApproval(baton, scope, approval, binding) {
  const state = await baton.state(scope), request = state.approvals[approval];
  if (!request || !['allow', 'deny'].includes(request.status)) return;
  let live;
  try { live = await baton.live(scope, state.jobs[request.job]); } catch { return; }
  if (!sameAgent(request.identity, live) || !sameAgent(state.jobs[request.job].identity, live) || live.agent_session?.kind !== 'id' || live.agent_session.value !== request.session) return;
  return baton.change(scope, latest => {
    const current = latest.approvals[approval], job = latest.jobs[current.job];
    if (!['allow', 'deny'].includes(current.status) || current.expiresAt <= baton.now() || job.revision !== current.revision || !sameAgent(job.identity, live) || digest(binding) !== digest({ session: current.session, tool: current.tool, input: current.input }) || (latest.goal?.status === 'paused' && current.status === 'allow')) return;
    const decision = current.status;
    current.status = 'consumed'; current.consumedAt = baton.now();
    return decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: `Permission denied for request ${approval}. Ask the human before changing the action.` };
  });
}
