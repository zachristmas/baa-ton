import { Baton } from './core.mjs';
import { loadConfig } from './config.mjs';
import { invoke, instructions, toolList } from './tools.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerExternalApprovalBeforeToolCall } from '../packages/herdr-tools/external-approval-hook.mjs';
import { createExternalApprovalResolver } from '../packages/herdr-tools/external-approval-resolver.mjs';
import { askList } from './host-policy.mjs';

export default async function attach(pi, { file, scope, worker }) {
  const baton = new Baton(await loadConfig(file), { scope, worker });
  // Preserve PR181's exact immutable external-operation approval guard. The
  // compatibility token says "root" internally; authority here comes from the
  // human's native confirmation in this pane, never a root-pane registration.
  registerExternalApprovalBeforeToolCall(pi, async (_event, ctx) => {
    const job = (await baton.state(scope)).jobs[worker];
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    return { enabled: true, caller: 'root', sessionFile, hasUI: ctx.hasUI, confirmAvailable: typeof ctx.ui?.confirm === 'function',
      resolveBinding: createExternalApprovalResolver({ cwd: ctx.cwd, execFile: promisify(execFile), sessionFile, paneId: job?.pane || process.env.HERDR_PANE_ID }),
      confirm: (operation, binding) => ctx.ui.confirm('Approve this exact external operation?', JSON.stringify({ operation, binding }, null, 2)) };
  });
  for (const tool of toolList(worker)) pi.registerTool({ name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema, async execute(_id, args, signal, _update, ctx) {
    if (askList(baton.config).includes(tool.name) && (!ctx?.hasUI || typeof ctx.ui?.confirm !== 'function' || !await ctx.ui.confirm(`Approve ${tool.name}?`, JSON.stringify(args, null, 2)))) throw new Error('This action is on approvals.ask and requires the human in this pane.');
    const result = await invoke(baton, tool.name, args, signal);
    return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }], details: result };
  } });
  pi.on('before_agent_start', async () => ({ message: { customType: 'baa-ton', content: instructions, display: false } }));
}
