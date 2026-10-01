import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const id = prefix => `${prefix}-${randomUUID()}`;
export function name(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value)) throw new Error('Use a short name containing letters, digits, dot, dash or underscore.');
  return value;
}

// One atomic document per user-named scope. Short transactions never run Herdr.
// An orphaned lock is left for explicit recovery: guessing by age risks two writers.
export class Store {
  constructor(directory) { this.directory = directory; }
  path(scope) { return join(this.directory, `${name(scope)}.json`); }
  async read(scope) {
    try {
      const data = JSON.parse(await readFile(this.path(scope), 'utf8'));
      if (data.version !== 2 || data.scope !== scope) throw new Error('Unsupported or mismatched scope store.');
      return data;
    } catch (error) { if (error.code === 'ENOENT') return { version: 2, scope, revision: 0, goal: null, jobs: {}, messages: {}, approvals: {}, chains: {} }; throw error; }
  }
  async change(scope, mutate) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(scope), lock = `${path}.lock`;
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error(`Scope locked: ${lock}. If its owner has exited, inspect and remove only this lock directory.`);
        await sleep(20);
      }
    }
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
      const state = await this.read(scope);
      const result = mutate(state);
      if (result?.then) throw new Error('Transactions must be synchronous.');
      state.revision++;
      await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
      await rename(temp, path);
      return result;
    } finally {
      await rm(temp, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
}
