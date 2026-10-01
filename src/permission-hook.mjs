#!/usr/bin/env node
import { Baton } from './core.mjs';
import { loadConfig } from './config.mjs';
import { flags } from './mcp.mjs';
import { requestApproval, consumeApproval } from './approvals.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

// Returning no decision preserves Claude's native prompt. No terminal key presses.
try {
  const options = flags(process.argv.slice(2));
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 100000) throw new Error('Hook input too large.'); }
  const input = JSON.parse(raw);
  if (input.hook_event_name !== 'PermissionRequest') throw new Error('Unexpected hook.');
  // Arbitrary shell cannot be safely classified by string matching. Bash always
  // retains its native permission UI; no generic root grant can approve it.
  if (input.tool_name === 'Bash') throw new Error('Bash requires the native human permission prompt.');
  const baton = new Baton(await loadConfig(options.config), { scope: options.scope, worker: options.worker });
  const binding = { session: input.session_id, tool: input.tool_name, input: input.tool_input };
  const request = await requestApproval(baton, { scope: options.scope, job: options.worker, ...binding });
  while (Date.now() < request.expiresAt) {
    const decision = await consumeApproval(baton, options.scope, request.id, binding);
    if (decision) { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }) + '\n'); break; }
    const current = (await baton.state(options.scope)).approvals[request.id];
    if (!['pending', 'allow', 'deny'].includes(current?.status)) break;
    await sleep(1000);
  }
} catch (error) { process.stderr.write(`Baa-ton approval unavailable; native permission prompt retained: ${error.message}\n`); }
