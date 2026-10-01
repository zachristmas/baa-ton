import { Store, digest, id, name } from './store.mjs';
import { Herdr, identity, sameAgent } from './herdr.mjs';
import { profile as resolveProfile } from './config.mjs';
import { launch } from './profiles.mjs';
import { remoteCall } from './remote.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { cleanupBlockers, cleanupTranscriptLimit, cleanupTranscriptLines, gitChanges, sameForegroundProcess } from './cleanup.mjs';

const finished = new Set(['reported', 'verified', 'cancelled']);
const scopeBinding = (config, scope) => ({ machine: config.machine || 'local', session: config.session || 'default', ...config.scopes[scope], ...(config.scopes[scope].remote ? { endpoint: config.remotes[config.scopes[scope].remote] } : {}) });
function text(value, label, max = 16000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${label} must be nonempty text, at most ${max} characters.`);
  return value;
}
function jobOf(state, key) { const job = state.jobs[key]; if (!job) throw new Error(`Unknown job ${key}.`); return job; }
function evidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Evidence requires a summary and checks or artifact paths.');
  text(value.summary, 'summary', 8000);
  if (!Array.isArray(value.checks) || !value.checks.length || value.checks.some(check => typeof check !== 'string' || !check.trim() || check.length > 4000)) throw new Error('Provide at least one concrete check and observed result.');
  return { summary: value.summary, checks: value.checks, artifacts: Array.isArray(value.artifacts) ? value.artifacts.map(path => text(path, 'artifact path', 2000)) : [] };
}

export class Baton {
  constructor(config, { herdr = new Herdr(config), store = new Store(config.stateDir), now = Date.now, remote = remoteCall, workspaceStatus = gitChanges, worker, scope } = {}) {
    Object.assign(this, { config, herdr, store, now, remote, workspaceStatus, worker, pinnedScope: scope });
  }
  scope(key) {
    key ||= this.pinnedScope;
    if (!key || !this.config.scopes[key]) throw new Error(`Choose scope explicitly: ${Object.keys(this.config.scopes).join(', ')}.`);
    if (this.worker && key !== this.pinnedScope) throw new Error('This worker connection is scoped to its assigned workspace.');
    return key;
  }
  async state(key) {
    const scope = this.scope(key), state = await this.store.read(scope);
    const binding = scopeBinding(this.config, scope);
    if (state.binding && digest(state.binding) !== digest(binding)) throw new Error('Scope configuration changed. Use a new scope name; existing jobs remain bound to their original endpoint/workspace.');
    return state;
  }
  async change(key, mutate) {
    const scope = this.scope(key), binding = scopeBinding(this.config, scope);
    return this.store.change(scope, state => {
      if (state.binding && digest(state.binding) !== digest(binding)) throw new Error('Scope binding changed; use a new scope name.');
      state.binding = binding;
      return mutate(state);
    });
  }
  async live(scope, job) {
    const live = await this.herdr.get(job.pane);
    // Process identity is only a startup bridge. Pin the first discovered native
    // session permanently so /new in the same process cannot inherit old work.
    if (job.identity && !job.identity.session && live.agent_session && sameAgent(job.identity, live)) {
      await this.change(scope, state => {
        const current = jobOf(state, job.id);
        if (current.revision === job.revision && digest(current.identity) === digest(job.identity)) current.identity = identity(live);
      });
    }
    if (job.identity) {
      const current = jobOf(await this.state(scope), job.id);
      if (current.revision !== job.revision || !sameAgent(current.identity, live)) throw new Error('Identity changed: native session changed or task was redirected during inspection.');
    }
    return live;
  }
  async status({ scope, job, pane, lines } = {}) {
    if (pane) {
      const live = await this.herdr.get(pane);
      if (this.worker) { const state = await this.state(this.scope(scope)); if (live.workspace_id !== this.config.scopes[this.scope(scope)].workspace && !Object.values(state.jobs).some(saved => saved.pane === pane)) throw new Error('This pane is outside the assigned scope.'); }
      return { live };
    }
    if (!scope && !this.pinnedScope) return { scopes: this.config.scopes, profiles: this.config.profiles, native: await this.herdr.workspaces(), agents: (await this.herdr.list()).agents?.map(agent => ({ name: agent.name, pane: agent.pane_id, workspace: agent.workspace_id, harness: agent.agent, state: agent.agent_status, cwd: agent.cwd, terminal: agent.terminal_id })), machine: this.config.machine || 'local' };
    scope = this.scope(scope);
    const state = await this.state(scope);
    if (!job) return { scope, goal: state.goal, revision: state.revision, binding: state.binding, profiles: this.config.profiles, counts: { jobs: Object.keys(state.jobs).length, pendingMessages: Object.values(state.messages).filter(message => ['pending', 'sending', 'uncertain'].includes(message.status)).length }, jobs: Object.values(state.jobs).slice(-50).map(job => ({ id: job.id, agentName: job.agentName, pane: job.pane, workspace: job.workspace, profile: job.profile.key, status: job.status, revision: job.revision })), approvals: Object.values(state.approvals).filter(request => ['pending', 'allow'].includes(request.status) && request.expiresAt > this.now()), note: 'Newest 50 jobs; drill down with job ID for identity, result and output.' };
    const saved = jobOf(state, job);
    if (!saved.pane) return saved;
    let live;
    try { live = await this.live(scope, saved); }
    catch (error) { let current; try { current = await this.herdr.get(saved.pane); } catch {} return { ...saved, live: current, identityMatches: false, reason: error.message }; }
    return { ...saved, live, identityMatches: sameAgent(saved.identity, live), ...(lines ? { output: await this.herdr.read(saved.pane, lines) } : {}) };
  }
  async goal({ scope, action, objective, intervalSeconds, maxNudges }) {
    scope = this.scope(scope);
    if (action === 'status') return (await this.state(scope)).goal;
    if (!['set', 'pause', 'resume', 'complete'].includes(action)) throw new Error('Goal action: set, pause, resume, complete.');
    if (action === 'set') text(objective, 'objective');
    if (intervalSeconds !== undefined && (!Number.isInteger(intervalSeconds) || intervalSeconds < 60 || intervalSeconds > 86400)) throw new Error('intervalSeconds must be 60..86400.');
    if (maxNudges !== undefined && (!Number.isInteger(maxNudges) || maxNudges < 0 || maxNudges > 5)) throw new Error('maxNudges must be 0..5.');
    return this.change(scope, state => {
      const goal = state.goal ||= { objective: '', status: 'active', intervalSeconds: 300, maxNudges: 2 };
      if (objective !== undefined) goal.objective = objective;
      if (intervalSeconds !== undefined) goal.intervalSeconds = intervalSeconds;
      if (maxNudges !== undefined) goal.maxNudges = maxNudges;
      goal.status = action === 'pause' ? 'paused' : action === 'complete' ? 'complete' : 'active';
      goal.updatedAt = this.now();
      // Never send Ctrl-C; in-flight work belongs to the visible native agent.
      return { ...goal, scope, semantics: 'Controls new dispatch and automated delivery. Does not interrupt running agents.' };
    });
  }
  async dispatch({ scope, profile, task, access = 'read', branch, base, requestId, reviewOf, previousStage }) {
    scope = this.scope(scope);
    text(task, 'task');
    if (!['read', 'write'].includes(access)) throw new Error('access must be read or write.');
    if (access === 'write' && !branch) throw new Error('Writers require a new worktree branch.');
    if (this.worker && jobOf(await this.state(scope), this.worker).access === 'read' && access !== 'read') throw new Error('This session was launched read-only. Choose a write profile from the controlling client to authorize edits.');
    if (this.config.machine) throw new Error('Remote dispatch needs this small runtime installed on that host. Use a host-local MCP/CLI there; read-only native remote status remains available.');
    const selected = resolveProfile(this.config, profile);
    const key = requestId ? name(requestId) : id('job');
    const agentName = `b-${digest({ scope, key }).slice(0, 28)}`;
    const signature = digest({ profile: selected, task, access, branch, base, reviewOf, previousStage });
    const reservation = await this.change(scope, state => {
      if (state.jobs[key]) {
        if (state.jobs[key].signature !== signature) throw new Error('requestId is already bound to another job.');
        if (state.jobs[key].status === 'ready-to-start' && (!state.goal || state.goal.status === 'active')) return { job: state.jobs[key] };
        return { existing: state.jobs[key] };
      }
      if (state.goal && state.goal.status !== 'active') throw new Error(`Scope ${scope} is ${state.goal.status}. Resume it explicitly.`);
      if (Object.values(state.jobs).filter(job => !finished.has(job.status)).length >= (this.config.maxActive || 4)) throw new Error('Scope active-job limit reached. Complete, verify, or explicitly cancel an existing job.');
      if (reviewOf && !jobOf(state, reviewOf).result) throw new Error('Review requires a reported result.');
      if (reviewOf && access !== 'read') throw new Error('Review jobs must be read-only.');
      if (branch && Object.values(state.jobs).some(job => job.branch === branch && job.status !== 'cancelled')) throw new Error('That branch is already reserved in this scope.');
      if (Object.values(state.jobs).some(job => job.agentName === agentName)) throw new Error('Native agent label collision; choose another requestId.');
      const job = { id: key, agentName, signature, task, profile: selected, access, cleanupOwned: true, ...(branch ? { branch, base: base || 'HEAD' } : {}), ...(reviewOf ? { reviewOf, reviewDigest: digest(state.jobs[reviewOf].result), reviewRevision: state.jobs[reviewOf].revision } : {}), status: 'preparing', createdAt: this.now(), lastActivity: this.now(), nudges: 0, revision: 0 };
      state.jobs[key] = job;
      return { job };
    });
    if (reservation.existing) return reservation.existing;
    const job = reservation.job;
    try {
      if ((await this.herdr.list()).agents?.some(agent => agent.name === job.agentName)) throw new Error('Native agent label already exists. Inspect it; do not overwrite or relaunch it.');
      const spec = this.config.scopes[scope];
      await this.herdr.workspace(spec.workspace);
      const prepared = await launch(this.config, scope, job, selected);
      let pane = job.pane;
      if (!pane) {
        await this.change(scope, state => { const current = jobOf(state, key); if (current.status === 'cancelled') throw new Error('Job cancelled before creating resources.'); if (state.goal && state.goal.status !== 'active') throw new Error('Scope paused before creating resources.'); current.status = 'creating'; });
        const created = await this.herdr.create(spec, job, prepared.env);
        pane = created.root_pane?.pane_id;
        if (!pane) throw new Error('Native create did not return root_pane.pane_id. Inspect status; do not repeat creation.');
        await this.change(scope, state => { const current = jobOf(state, key); Object.assign(current, { pane, workspace: created.root_pane.workspace_id, cwd: created.worktree?.path || spec.cwd }); if (current.status !== 'cancelled') current.status = 'ready-to-start'; });
      }
      const startClaim = await this.change(scope, state => {
        const current = jobOf(state, key);
        if (current.status !== 'ready-to-start' || (state.goal && state.goal.status !== 'active')) return false;
        current.status = 'starting'; return true;
      });
      if (!startClaim) return jobOf(await this.state(scope), key);
      let started;
      for (let attempt = 0; attempt < 20; attempt++) {
        const current = await this.state(scope);
        if (jobOf(current, key).status === 'cancelled' || (current.goal && current.goal.status !== 'active')) return this.change(scope, state => { const saved = jobOf(state, key); if (saved.status !== 'cancelled') saved.status = 'ready-to-start'; return saved; });
        try { started = await this.herdr.start({ ...job, pane }, selected, prepared.argv); break; }
        catch (error) {
          // Only this native rejection guarantees no command was submitted.
          if (error.nativeCode !== 'agent_pane_busy' || attempt === 19) throw error;
          await sleep(250);
        }
      }
      if (started.agent?.pane_id !== pane || started.agent?.agent !== selected.harness) throw new Error('Native start did not return the expected pane and harness.');
      const proof = identity(await this.herdr.get(pane));
      if (proof.pane !== pane || proof.harness !== selected.harness) throw new Error('Native start returned a different agent identity.');
      await this.change(scope, state => { const current = jobOf(state, key); current.identity = proof; if (current.status !== 'cancelled') current.status = 'ready'; });
      const before = await this.state(scope);
      if (jobOf(before, key).status === 'cancelled') return jobOf(before, key);
      let review = previousStage ? `\nPrevious stage is job ${previousStage}. Read its saved result with herdr_status before continuing.` : '';
      if (reviewOf) {
        const target = jobOf(before, reviewOf);
        review = `\nReview job ${reviewOf}, cwd ${target.cwd}. Inspect its changes and verify independently. Reported evidence: ${JSON.stringify(target.result)}. Use herdr_result action=verify with job=${reviewOf} and reviewer=${key} only after checking it.`;
      }
      const brief = `Baa-ton job ${key}; scope ${scope}; revision 0.\nTASK: ${task}${review}\nThe human may redirect you directly in this pane. Their current instruction takes precedence over this task; never reply that only a root may direct you. Preserve native permission prompts. No standing permission to push, merge, deploy, delete worktrees or affect other accounts.\nWhen finished call herdr_result action=submit, job=${key}, revision=0, with a concise summary, concrete checks and observed results, and artifact paths. Idle is not completion. If redirected, use herdr_message redirect=true to record the new task revision before submitting. Use herdr_status to recover state. Cross-harness messages use herdr_message.\nYour profile: ${JSON.stringify(selected)}. Do not substitute another model or authentication route.`;
      await this.message({ scope, job: key, text: brief, requestId: `assignment-${digest(key).slice(0, 32)}`, automatic: true, expectedRevision: job.revision });
      return jobOf(await this.state(scope), key);
    } catch (error) {
      await this.change(scope, state => { const saved = jobOf(state, key); if (saved.status !== 'cancelled' && saved.revision === job.revision) saved.status = error.nativeCode === 'agent_pane_busy' ? 'ready-to-start' : error.uncertain || ['creating', 'starting'].includes(saved.status) ? 'uncertain' : 'blocked'; saved.error = error.message; });
      throw error;
    }
  }
  async message({ scope, job, text: body, requestId, redirect = false, automatic = false, expectedRevision }) {
    scope = this.scope(scope); text(body, 'message', automatic ? 262144 : 16000);
    const key = requestId ? name(requestId) : id('msg');
    const saved = await this.change(scope, state => {
      const target = jobOf(state, job);
      if (target.cleanup?.status) throw new Error('This pane is being retired or needs inspection; reconnect to a freshly inspected pane before sending more work.');
      if (expectedRevision !== undefined && target.revision !== expectedRevision) throw new Error('Task changed while preparing assignment.');
      if (target.status === 'cancelled' && !redirect) throw new Error('Job is cancelled; explicitly redirect it before sending new work.');
      if (!target.identity) throw new Error('Job is not connected to a verified native agent.');
      const old = state.messages[key];
      if (old) { if (old.job !== job || old.text !== body || old.redirect !== redirect) throw new Error('requestId already used by a different message.'); return old; }
      if (redirect) {
        target.revision++; target.status = 'ready'; target.nudges = 0; target.lastActivity = this.now();
        target.previousResults ||= []; if (target.result) target.previousResults.push(target.result);
        delete target.result; delete target.verification; target.task = body;
        for (const pending of Object.values(state.messages)) if (pending.job === job && ['pending', 'uncertain'].includes(pending.status)) { pending.previousStatus = pending.status; pending.status = 'superseded'; }
        for (const approval of Object.values(state.approvals)) if (approval.job === job && ['pending', 'allow'].includes(approval.status)) approval.status = 'revoked';
      }
      // A worker recording the human's direct intervention already has that
      // message in its context. Do not prompt it with the same task again.
      const status = redirect && this.worker === job ? 'recorded' : 'pending';
      return state.messages[key] = { id: key, job, text: body, redirect, revision: target.revision, from: this.worker || 'operator', status, createdAt: this.now() };
    });
    await this.deliver(scope, key, !automatic);
    return (await this.state(scope)).messages[saved.id];
  }
  async deliver(scope, key, explicit = false) {
    const state = await this.state(scope), message = state.messages[key];
    if (!message || message.status !== 'pending') return;
    const job = jobOf(state, message.job);
    if (!explicit && state.goal && state.goal.status !== 'active') return;
    let live;
    try { live = await this.live(scope, job); }
    catch (error) { return this.change(scope, latest => { latest.messages[key].reason = error.message; }); }
    if (!sameAgent(job.identity, live)) return this.change(scope, latest => { latest.messages[key].reason = 'Identity changed; explicit reconnect required.'; });
    if (!['idle', 'done'].includes(live.agent_status)) return;
    const claimed = await this.change(scope, latest => {
      const current = latest.messages[key], target = jobOf(latest, job.id);
      if (target.status === 'cancelled') return false;
      if (current.status !== 'pending' || current.revision !== target.revision || (!explicit && latest.goal && latest.goal.status !== 'active')) return false;
      if (Object.values(latest.messages).some(other => other.job === job.id && ['sending', 'uncertain'].includes(other.status))) return false;
      current.status = 'sending'; current.startedAt = this.now(); return true;
    });
    if (!claimed) return;
    try {
      await this.herdr.prompt(job.pane, `[Baa-ton ${message.id}; job ${job.id}; revision ${message.revision}; from ${message.from}]\n${message.text}`);
      await this.change(scope, latest => { const current = latest.messages[key]; current.deliveryOutcome = 'delivered'; if (current.status !== 'sending') return; current.status = 'delivered'; const target = jobOf(latest, job.id); if (target.revision === message.revision && !finished.has(target.status)) { target.status = 'running'; target.lastActivity = this.now(); } });
    } catch (error) {
      await this.change(scope, latest => { const current = latest.messages[key]; current.deliveryOutcome = error.message; if (current.status !== 'sending') return; current.status = error.uncertain === false ? 'pending' : 'uncertain'; current.reason = error.message; });
    }
  }
  async wait({ scope, job, timeout = 30000 }, signal) {
    scope = this.scope(scope); const saved = jobOf(await this.state(scope), job);
    const live = await this.live(scope, saved);
    if (!sameAgent(saved.identity, live)) throw new Error('Identity changed; reconnect explicitly before waiting.');
    const native = await this.herdr.wait(saved.pane, Math.min(300000, Math.max(1, timeout)), signal);
    return { native, job: jobOf(await this.state(scope), job), note: 'Native idle/done is terminal attention state, not proof this job completed.' };
  }
  async result({ scope, action, job, revision, evidence: proof, reviewer }) {
    scope = this.scope(scope); proof = evidence(proof);
    if (!['submit', 'verify'].includes(action)) throw new Error('Result action: submit or verify.');
    const reporter = this.worker || (action === 'verify' && reviewer !== 'human' ? reviewer : undefined);
    let observed, reporterLive;
    if (reporter) {
      observed = jobOf(await this.state(scope), reporter);
      reporterLive = await this.live(scope, observed);
      const fresh = jobOf(await this.state(scope), reporter);
      if (fresh.status === 'cancelled' || fresh.revision !== observed.revision || !sameAgent(fresh.identity, reporterLive)) throw new Error('Reporter is cancelled or its native session changed. Reconnect explicitly.');
      observed = fresh;
    }
    let targetLive;
    try {
      const target = jobOf(await this.state(scope), job);
      const live = reporter === job ? reporterLive : await this.herdr.get(target.pane);
      if (target.identity && sameAgent(target.identity, live)) targetLive = live;
    } catch { /* Evidence remains recordable; cleanup will fail closed without a fresh native sequence. */ }
    return this.change(scope, state => {
      if (observed) { const current = jobOf(state, reporter); if (current.status === 'cancelled' || current.revision !== observed.revision || digest(current.identity) !== digest(observed.identity)) throw new Error('Reporter changed during result submission.'); }
      const target = jobOf(state, job);
      if (target.cleanup?.status === 'closing') throw new Error('Pane cleanup is in progress; wait for its recorded outcome before changing the result.');
      if (target.status === 'cancelled') throw new Error('Job is cancelled; a result cannot revive it.');
      if (target.revision !== revision) throw new Error('Stale task revision; inspect the current job.');
      if (action === 'submit') {
        if (this.worker && this.worker !== job) throw new Error('A worker reports its own result.');
        if (target.result) {
          if (digest(target.result.evidence) !== digest(proof)) throw new Error('A result already exists. Redirect before replacing it.');
          return target;
        }
        target.result = { evidence: proof, revision, at: this.now() }; target.status = 'reported';
      } else {
        if (!target.result) throw new Error('No reported result to verify.');
        if (reviewer === job || (this.worker && this.worker !== reviewer)) throw new Error('Independent reviewer required.');
        if (!reviewer) throw new Error('Provide a different review job or the literal human.');
        if (reviewer !== 'human') {
          const other = jobOf(state, reviewer);
          if (other.status === 'cancelled' || other.reviewOf !== job || other.access !== 'read') throw new Error('Reviewer must be an active separate read-only job assigned to this result.');
          if (other.reviewRevision !== target.revision || other.reviewDigest !== digest(target.result)) throw new Error('Reviewer was assigned to an earlier result; dispatch a fresh review.');
        } else if (this.worker) throw new Error('A worker cannot claim to be the human.');
        target.verification = { reviewer, evidence: proof, resultDigest: digest(target.result), at: this.now(), ...(Number.isSafeInteger(targetLive?.state_change_seq) ? { stateChangeSeq: targetLive.state_change_seq } : {}) }; target.status = 'verified';
      }
      return target;
    });
  }
  async reconnect({ scope, job, pane, expectedTerminal }) {
    if (this.worker) throw new Error('Reconnect must come from the controlling client, after the user identifies the replacement session.');
    scope = this.scope(scope); const live = await this.herdr.get(pane), proof = identity(live);
    if (proof.terminal !== expectedTerminal) throw new Error('Terminal changed since inspection.');
    return this.change(scope, state => {
      const target = jobOf(state, job);
      if (target.cleanup?.status === 'closing') throw new Error('Pane cleanup is in progress; inspect it before reconnecting.');
      if (proof.harness !== target.profile.harness || proof.workspace !== target.workspace) throw new Error('Replacement must match the recorded harness and workspace.');
      target.previousIdentities ||= []; target.previousIdentities.push(target.identity);
      target.identity = proof; target.pane = pane; target.revision++; target.status = 'ready'; target.nudges = 0; target.lastActivity = this.now();
      if (target.cleanup) { target.previousCleanup ||= []; target.previousCleanup.push(target.cleanup); delete target.cleanup; }
      target.cleanupOwned = false;
      target.previousResults ||= []; if (target.result) target.previousResults.push(target.result);
      delete target.result; delete target.verification;
      for (const pending of Object.values(state.messages)) if (pending.job === job && ['pending', 'sending', 'uncertain'].includes(pending.status)) { pending.previousStatus = pending.status; pending.status = 'superseded'; }
      for (const approval of Object.values(state.approvals)) if (approval.job === job && ['pending', 'allow'].includes(approval.status)) approval.status = 'revoked';
      return target;
    });
  }
  async connect({ scope, job, pane, expectedTerminal, profile, task }) {
    if (this.worker) throw new Error('Attach existing sessions from the controlling client.');
    scope = this.scope(scope); name(job); text(task, 'task');
    const selected = resolveProfile(this.config, profile), live = await this.herdr.get(pane), proof = identity(live);
    if (proof.terminal !== expectedTerminal || proof.workspace !== this.config.scopes[scope].workspace || proof.harness !== selected.harness) throw new Error('Fresh terminal, scope workspace, and selected harness must match.');
    return this.change(scope, state => {
      if (state.jobs[job]) throw new Error('Job already exists; inspect or reconnect it.');
      return state.jobs[job] = { id: job, pane, workspace: proof.workspace, cwd: live.cwd, profile: selected, task, identity: proof, access: 'existing', cleanupOwned: false, status: 'ready', revision: 0, nudges: 0, createdAt: this.now(), lastActivity: this.now(), adopted: true, note: 'Profile is caller-declared. Existing session model/effort are not changed or attested.' };
    });
  }
  async cleanup({ scope }, state = undefined) {
    scope = this.scope(scope);
    const policy = this.config.cleanup;
    if (!policy || policy.mode === 'disabled') return undefined;
    const idleGraceSeconds = policy.idleGraceSeconds ?? 86400;
    const report = { mode: policy.mode, idleGraceSeconds, candidates: [], closed: [], blocked: [] };
    state ||= await this.state(scope);
    for (const listed of Object.values(state.jobs)) {
      if (listed.status !== 'verified') continue;
      let latestState = await this.state(scope);
      let job = latestState.jobs[listed.id];
      if (!job) continue;
      if (job.cleanup?.status) {
        if (job.cleanup.status !== 'closed') report.blocked.push({ job: job.id, reason: `prior cleanup state is ${job.cleanup.status}; inspect before retrying` });
        continue;
      }
      let live;
      try { live = await this.herdr.get(job.pane); }
      catch { report.blocked.push({ job: job.id, reason: 'native pane is missing or unavailable' }); continue; }
      let blockers = cleanupBlockers(latestState, job, live, this.now(), idleGraceSeconds);
      if (blockers.length) { report.blocked.push({ job: job.id, reason: blockers.join('; ') }); continue; }
      let changes;
      try { changes = await this.workspaceStatus(job.cwd); }
      catch { report.blocked.push({ job: job.id, reason: 'Git cleanliness could not be confirmed' }); continue; }
      if (typeof changes !== 'string' || changes.length) { report.blocked.push({ job: job.id, reason: 'worktree has unrecorded changes' }); continue; }

      const candidate = { job: job.id, pane: job.pane, workspace: job.workspace, terminal: job.identity.terminal, verifiedAt: job.verification.at, idleSeconds: Math.floor((this.now() - Math.max(job.lastActivity || 0, job.verification.at)) / 1000) };
      let transcript;
      try { transcript = await this.herdr.read(job.pane, cleanupTranscriptLines); }
      catch { report.blocked.push({ job: job.id, reason: 'terminal transcript could not be captured' }); continue; }
      if (typeof transcript !== 'string') { report.blocked.push({ job: job.id, reason: 'terminal transcript could not be captured' }); continue; }
      const transcriptBytes = Buffer.byteLength(transcript, 'utf8');
      if (!transcriptBytes || transcriptBytes > cleanupTranscriptLimit) {
        report.blocked.push({ job: job.id, reason: 'terminal transcript is empty or exceeds the archive limit' }); continue;
      }
      if (policy.mode === 'preview') { report.candidates.push(candidate); continue; }

      // Snapshot again after reading output so identity or task changes during
      // inspection cannot retire a replacement session.
      latestState = await this.state(scope);
      job = latestState.jobs[listed.id];
      if (!job) { report.blocked.push({ job: listed.id, reason: 'job record changed during cleanup inspection' }); continue; }
      try { live = await this.herdr.get(job.pane); }
      catch { report.blocked.push({ job: listed.id, reason: 'native pane changed during cleanup inspection' }); continue; }
      blockers = cleanupBlockers(latestState, job, live, this.now(), idleGraceSeconds);
      if (blockers.length) { report.blocked.push({ job: job.id, reason: blockers.join('; ') }); continue; }
      try { changes = await this.workspaceStatus(job.cwd); }
      catch { report.blocked.push({ job: job.id, reason: 'Git cleanliness could not be confirmed before close' }); continue; }
      if (typeof changes !== 'string' || changes.length) { report.blocked.push({ job: job.id, reason: 'worktree changed during cleanup inspection' }); continue; }

      const claim = id('close');
      const archivedTranscript = { source: 'recent-unwrapped', lines: cleanupTranscriptLines, capturedAt: this.now(), bytes: transcriptBytes, text: transcript };
      const claimed = await this.change(scope, current => {
        const saved = current.jobs[job.id];
        if (!saved || saved.cleanup || saved.revision !== job.revision || digest(saved.identity) !== digest(job.identity) || digest(saved.result) !== digest(job.result) || digest(saved.verification) !== digest(job.verification)) return false;
        if (cleanupBlockers(current, saved, live, this.now(), idleGraceSeconds).length) return false;
        saved.cleanup = { status: 'closing', claim, identityDigest: digest(saved.identity), transcript: archivedTranscript, claimedAt: this.now() };
        return true;
      });
      if (!claimed) { report.blocked.push({ job: job.id, reason: 'job changed during cleanup claim' }); continue; }
      try { live = await this.herdr.get(job.pane); }
      catch {
        await this.change(scope, current => {
          const saved = current.jobs[job.id];
          if (saved?.cleanup?.claim === claim) { saved.cleanup.status = 'aborted'; saved.cleanup.outcome = 'Native identity could not be rechecked before close; inspect the exact pane.'; }
        });
        report.blocked.push({ job: job.id, reason: 'native identity could not be rechecked before close' }); continue;
      }
      const finalActivityMatches = ['idle', 'done'].includes(live.agent_status)
        && Number.isSafeInteger(job.verification.stateChangeSeq)
        && live.state_change_seq === job.verification.stateChangeSeq
        && sameForegroundProcess(job.identity, live);
      if (!sameAgent(job.identity, live) || live.workspace_id !== job.workspace || live.pane_id !== job.pane || !finalActivityMatches) {
        await this.change(scope, current => {
          const saved = current.jobs[job.id];
          if (saved?.cleanup?.claim === claim) { saved.cleanup.status = 'aborted'; saved.cleanup.outcome = 'Native identity or activity changed after cleanup claim; inspect the exact pane.'; }
        });
        report.blocked.push({ job: job.id, reason: 'native identity or activity changed after cleanup claim' }); continue;
      }
      try {
        await this.herdr.close(job.pane);
        await this.change(scope, current => {
          const saved = current.jobs[job.id];
          if (saved?.cleanup?.claim === claim) { saved.cleanup.status = 'closed'; saved.cleanup.closedAt = this.now(); }
        });
        report.closed.push(candidate);
      } catch {
        await this.change(scope, current => {
          const saved = current.jobs[job.id];
          if (saved?.cleanup?.claim === claim) { saved.cleanup.status = 'uncertain'; saved.cleanup.outcome = 'Native close response was not confirmed; inspect the exact pane before retrying.'; }
        });
        report.blocked.push({ job: job.id, reason: 'native close outcome is uncertain; inspect the exact pane before retrying' });
      }
    }
    return report;
  }
  async tick({ scope }) {
    scope = this.scope(scope);
    let state = await this.state(scope);
    if (state.goal?.status === 'paused') return { scope, quiet: 'paused', cleanup: await this.cleanup({ scope }, state) };
    const changes = [], sentJobs = new Set();
    if (!state.goal || state.goal.status === 'active') {
      for (const message of Object.values(state.messages)) {
        if (message.status !== 'pending' || sentJobs.has(message.job)) continue;
        await this.deliver(scope, message.id); sentJobs.add(message.job);
      }
    }
    state = await this.state(scope);
    if (state.goal?.status === 'active') {
      for (const job of Object.values(state.jobs)) {
        if (!['ready', 'running'].includes(job.status) || !job.identity || sentJobs.has(job.id)) continue;
        if (Object.values(state.messages).some(message => message.job === job.id && ['pending', 'sending', 'uncertain'].includes(message.status))) continue;
        if (Object.values(state.approvals).some(request => request.job === job.id && ['pending', 'allow'].includes(request.status) && request.expiresAt > this.now())) continue;
        let live;
        try { live = await this.live(scope, job); } catch (error) { changes.push({ job: job.id, blocked: error.message }); continue; }
        if (!sameAgent(job.identity, live)) { changes.push({ job: job.id, blocked: 'identity changed' }); continue; }
        if (live.agent_status === 'working' || (job.lastSequence !== undefined && live.state_change_seq !== job.lastSequence)) {
          await this.change(scope, latest => Object.assign(jobOf(latest, job.id), { lastActivity: this.now(), lastSequence: live.state_change_seq })); continue;
        }
        if (!['idle', 'done'].includes(live.agent_status) || this.now() - job.lastActivity < state.goal.intervalSeconds * 1000) continue;
        const nudge = await this.change(scope, latest => {
          const current = jobOf(latest, job.id);
          if (latest.goal.status !== 'active' || !['ready', 'running'].includes(current.status) || current.revision !== job.revision || this.now() - current.lastActivity < latest.goal.intervalSeconds * 1000) return null;
          if (current.nudges >= latest.goal.maxNudges) { current.status = 'stalled'; return null; }
          current.nudges++; current.lastActivity = this.now();
          const key = `${current.id}.nudge.${current.revision}.${current.nudges}`;
          latest.messages[key] = { id: key, job: current.id, revision: current.revision, from: 'watchdog', text: 'No result was recorded. If work is complete, submit concrete evidence; otherwise continue your current user-directed task or report the blocker. Do not repeat an uncertain operation.', status: 'pending', createdAt: this.now() };
          return key;
        });
        if (nudge) { await this.deliver(scope, nudge); changes.push({ job: job.id, nudge }); }
      }
    }
    const cleanup = await this.cleanup({ scope }, state);
    if (state.goal?.status === 'complete') return { scope, quiet: 'complete', cleanup };
    if (!state.goal) return { scope, deliveredJobs: [...sentJobs], quiet: 'No goal: messages drain, nudges disabled.', cleanup };
    return { scope, changes, cleanup };
  }
  async chain({ scope, action, chain, stages }) {
    scope = this.scope(scope);
    if (action === 'create') {
      name(chain);
      if (!Array.isArray(stages) || !stages.length || stages.length > 20) throw new Error('Provide 1..20 stages.');
      for (const stage of stages) { resolveProfile(this.config, stage.profile); text(stage.task, 'stage task'); if (!['reported', 'verified'].includes(stage.after || 'verified')) throw new Error('Stage after is reported or verified.'); }
      return this.change(scope, state => {
        if (state.chains[chain]) throw new Error('Chain already exists.');
        return state.chains[chain] = { id: chain, stages, jobs: [], createdAt: this.now() };
      });
    }
    const state = await this.state(scope), saved = state.chains[chain];
    if (!saved) throw new Error('Unknown chain.');
    if (action === 'status') return saved;
    if (action !== 'advance') throw new Error('Chain action: create, status, advance.');
    const index = saved.jobs.length;
    if (index >= saved.stages.length) return { ...saved, exhausted: true };
    const stage = saved.stages[index];
    if (index) {
      const previous = jobOf(state, saved.jobs[index - 1]);
      if (stage.after === 'reported' ? !previous.result : !previous.verification) throw new Error(`Previous stage requires ${stage.after || 'verified'} evidence.`);
    }
    const reviewOf = stage.reviewPrevious && index ? saved.jobs[index - 1] : undefined;
    const job = await this.dispatch({ ...stage, scope, previousStage: index ? saved.jobs[index - 1] : undefined, reviewOf, requestId: name(`${chain.slice(0, 40)}.${index + 1}.${digest(chain).slice(0, 8)}`) });
    await this.change(scope, latest => { const list = latest.chains[chain].jobs; if (!list.includes(job.id)) list.push(job.id); });
    return job;
  }
  async cancel({ scope, job, reason }) {
    scope = this.scope(scope); text(reason, 'reason', 2000);
    if (this.worker && this.worker !== job) throw new Error('Cancel your own assigned job, or ask its controlling client.');
    return this.change(scope, state => {
      const target = jobOf(state, job);
      if (target.cleanup?.status === 'closing') throw new Error('Pane cleanup is in progress; inspect its recorded outcome before cancelling.');
      if (target.status !== 'cancelled') target.revision++; target.status = 'cancelled'; target.cancelledAt = this.now(); target.cancelReason = reason;
      for (const message of Object.values(state.messages)) if (message.job === job && ['pending', 'sending', 'uncertain'].includes(message.status)) { message.previousStatus = message.status; message.status = 'cancelled'; }
      for (const approval of Object.values(state.approvals)) if (approval.job === job && ['pending', 'allow'].includes(approval.status)) approval.status = 'revoked';
      return { ...target, note: 'Orchestration cancelled. Native agent/pane/worktree remains untouched; inspect it before reusing resources.' };
    });
  }
}
