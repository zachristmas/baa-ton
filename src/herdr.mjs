import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

function atom(value, label = 'identifier') {
  if (typeof value !== 'string' || !value || value.startsWith('-') || /[\x00-\x1f]/.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

// Fixed operations only. No shell, terminal keystrokes, arbitrary command runner,
// account switching, process killing, or implicit workspace focus.
export class Herdr {
  constructor(config, run = exec) { this.config = config; this.run = run; }
  async call(args, { timeout = 35000, text = false, signal, effect = false } = {}) {
    const prefix = [];
    if (this.config.machine) prefix.push('--machine', atom(this.config.machine));
    if (this.config.session) prefix.push('--session', atom(this.config.session));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HERDR_')));
    try {
      const { stdout } = await this.run(this.config.herdr || 'herdr', [...prefix, ...args], { timeout, signal, maxBuffer: 2 * 1024 * 1024, env, shell: false });
      if (text) return stdout;
      const result = JSON.parse(stdout);
      if (result.error) throw new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error));
      return result.result ?? result;
    } catch (error) {
      // CLI termination after submission cannot prove nondelivery. Never auto-retry.
      error.uncertain = effect && !['ENOENT', 'EACCES'].includes(error.code);
      throw error;
    }
  }
  list() { return this.call(['agent', 'list']); }
  workspaces() { return this.call(['workspace', 'list']); }
  workspace(workspace) { return this.call(['workspace', 'get', atom(workspace)]); }
  async get(pane) {
    const agent = (await this.call(['agent', 'get', atom(pane)])).agent;
    if (agent?.agent) {
      try {
        const data = await this.call(['pane', 'process-info', '--pane', atom(pane)]);
        const process = data.process_info ?? data;
        const pids = process.foreground_processes?.map(entry => entry.pid).sort((a, b) => a - b);
        if (pids?.length && process.foreground_process_group_id) agent.processIdentity = { group: process.foreground_process_group_id, pids };
      } catch (error) { if (!agent.agent_session) throw error; }
    }
    return agent;
  }
  read(pane, lines = 60) { return this.call(['agent', 'read', atom(pane), '--source', 'recent-unwrapped', '--lines', String(lines)], { text: true }); }
  wait(pane, timeout = 30000, signal) { return this.call(['agent', 'wait', atom(pane), '--timeout', String(timeout)], { timeout: timeout + 2000, signal }); }
  async create(scope, job, environment) {
    if (job.branch) {
      const created = await this.call(['worktree', 'create', '--cwd', scope.cwd, '--branch', atom(job.branch), '--base', atom(job.base || 'HEAD'), '--label', job.id, '--no-focus'], { effect: true });
      // Native worktree create has no --env. OpenCode's per-job overlay needs a
      // new tab with its environment; preserve the initial shell for the user.
      if (!environment.OPENCODE_CONFIG_CONTENT) return created;
      const tab = await this.create({ workspace: created.workspace.workspace_id, cwd: created.worktree.path }, { ...job, branch: undefined }, environment);
      return { ...created, ...tab };
    }
    const args = ['tab', 'create', '--workspace', atom(scope.workspace), '--cwd', scope.cwd, '--label', job.id, '--no-focus'];
    for (const [key, value] of Object.entries(environment)) args.push('--env', `${key}=${value}`);
    return this.call(args, { effect: true });
  }
  start(job, profile, argv) { if (!/^[a-z][a-z0-9_-]{0,31}$/.test(job.agentName || '')) throw new Error('Native agent name must be 1..32 lowercase safe characters.'); return this.call(['agent', 'start', job.agentName, '--kind', profile.harness, '--pane', atom(job.pane), '--timeout', '30000', '--', ...argv], { timeout: 35000, effect: true }); }
  prompt(pane, text, signal) { return this.call(['agent', 'prompt', atom(pane), text], { effect: true, signal }); }
}

export function identity(agent) {
  if (!agent?.pane_id || !agent.terminal_id || !agent.agent || !agent.interactive_ready) throw new Error('Expected a live interactive agent with a terminal identity.');
  if (!agent.agent_session && !agent.processIdentity) throw new Error('Native session or foreground process identity is required; no name-only identity fallback.');
  return { pane: agent.pane_id, terminal: agent.terminal_id, workspace: agent.workspace_id, harness: agent.agent, session: agent.agent_session ?? null, process: agent.processIdentity ?? null };
}
export function sameAgent(expected, agent) {
  try {
    const current = identity(agent);
    return expected.pane === current.pane && expected.terminal === current.terminal && expected.workspace === current.workspace && expected.harness === current.harness && (expected.session ? JSON.stringify(expected.session) === JSON.stringify(current.session) : JSON.stringify(expected.process) === JSON.stringify(current.process));
  } catch { return false; }
}
