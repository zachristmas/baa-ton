#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { Baton } from './core.mjs';
import { loadConfig } from './config.mjs';
import { invoke, instructions, toolList } from './tools.mjs';
import { policyDigest } from './host-policy.mjs';

export function flags(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--config', '--scope', '--worker', '--policy'].includes(argv[i]) || !argv[i + 1]) throw new Error('Options: --config FILE --scope NAME --worker JOB --policy DIGEST.');
    values[argv[i].slice(2)] = argv[i + 1];
  }
  return values;
}

export async function server(baton, input = process.stdin, output = process.stdout) {
  const active = new Map(); let buffer = '', initialized = false;
  const send = message => output.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const handle = async message => {
    const { id, method, params = {} } = message;
    if (method === 'notifications/cancelled') { active.get(params.requestId)?.abort(); return; }
    if (id === undefined) return;
    try {
      if (message.jsonrpc !== '2.0' || !['string', 'number'].includes(typeof id)) throw new Error('Invalid JSON-RPC request.');
      if (method === 'initialize') {
        initialized = true;
        return send({ id, result: { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(params.protocolVersion) ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'baa-ton-native', version: '2.0.0' }, instructions } });
      }
      if (!initialized) throw new Error('Initialize first.');
      if (method === 'ping') return send({ id, result: {} });
      if (method === 'tools/list') return send({ id, result: { tools: toolList(baton.worker) } });
      if (method !== 'tools/call') return send({ id, error: { code: -32601, message: 'Method not found.' } });
      if (active.has(id)) throw new Error('Request ID already active.');
      const controller = new AbortController(); active.set(id, controller);
      try {
        const result = await invoke(baton, params.name, params.arguments ?? {}, controller.signal);
        send({ id, result: { content: [{ type: 'text', text: JSON.stringify(result ?? null) }], structuredContent: { result: result ?? null } } });
      } catch (error) { send({ id, result: { isError: true, content: [{ type: 'text', text: error.message }] } }); }
      finally { active.delete(id); }
    } catch (error) { send({ id, error: { code: -32600, message: error.message } }); }
  };
  input.setEncoding('utf8');
  for await (const chunk of input) {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) throw new Error('MCP input exceeds 1 MiB.');
    for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { void handle(JSON.parse(line)); }
      catch { send({ id: null, error: { code: -32700, message: 'Invalid JSON.' } }); }
    }
  }
  for (const controller of active.values()) controller.abort();
}

export async function run(options) {
  try {
    const config = await loadConfig(options.config);
    if (options.policy && options.policy !== policyDigest(config)) throw new Error('Approval ask-list or tool surface changed. Regenerate the host config and reconnect before executing tools.');
    await server(new Baton(config, { scope: options.scope, worker: options.worker }));
  }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run(flags(process.argv.slice(2)));
