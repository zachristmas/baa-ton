import { definitions, toolList } from './tools.mjs';
import { digest } from './store.mjs';
import { join } from 'node:path';

// This is a compiler for the host's native approval UI, not an approval broker.
// No regex, wildcard, user-name inference, or reusable blanket consent token.
export function askList(config) {
  const ask = config.approvals?.ask ?? ['herdr_connect', 'herdr_reconnect', 'herdr_approve'];
  if (!Array.isArray(ask) || ask.some(name => !definitions.some(item => item[0] === name)) || new Set(ask).size !== ask.length) throw new Error('approvals.ask must contain unique exact tool names from `baa-ton tools`; no wildcards or unknown names.');
  if (config.approvals && Object.keys(config.approvals).some(key => key !== 'ask')) throw new Error('Only approvals.ask is supported. Native/provider permission rules cannot be disabled here.');
  return ask;
}
export const policyDigest = config => digest({ tools: definitions.map(item => item[0]), ask: [...askList(config)].sort() });
export function codexPolicy(config, server = 'baa-ton-native', worker) {
  const tools = toolList(worker).map(tool => tool.name), ask = askList(config);
  const prefix = `mcp_servers.${server}`;
  return [
    [`${prefix}.enabled_tools`, tools],
    // Any newly added tool prompts until the user regenerates this snapshot.
    [`${prefix}.default_tools_approval_mode`, 'prompt'],
    ...tools.map(tool => [`${prefix}.tools.${tool}.approval_mode`, ask.includes(tool) ? 'prompt' : 'approve']),
  ];
}

export function codexWorkerTable(config, command, loader, worker) {
  const names = toolList(worker).map(tool => tool.name), ask = askList(config);
  // A snapshot allowlist and loader policy digest fence new tools/config changes.
  // Compact native TOML avoids multi-kilobyte commands through a terminal line.
  const modes = names.map(name => `${name}={approval_mode=${JSON.stringify(ask.includes(name) ? 'prompt' : 'approve')}}`).join(',');
  return `{command=${JSON.stringify(command)},args=${JSON.stringify([loader])},enabled=true,enabled_tools=${JSON.stringify(names)},default_tools_approval_mode="prompt",tools={${modes}}}`;
}
export function codexConfig(config) {
  const server = 'baa-ton-native';
  const entries = [
    [`mcp_servers.${server}.command`, process.execPath],
    [`mcp_servers.${server}.args`, [join(config.source, 'src/mcp.mjs'), '--config', config.file, '--policy', policyDigest(config)]],
    [`mcp_servers.${server}.cwd`, config.source],
    [`mcp_servers.${server}.startup_timeout_sec`, 10],
    [`mcp_servers.${server}.tool_timeout_sec`, 330],
    [`mcp_servers.${server}.enabled`, true],
    ...codexPolicy(config),
  ];
  const prefix = `mcp_servers.${server}.`;
  return '# Generated Baa-ton MCP settings.\n' + `[mcp_servers.${server}]\n` + entries.filter(([key]) => !key.includes('.tools.')).map(([key, value]) => `${key.slice(prefix.length)} = ${JSON.stringify(value)}`).join('\n') + '\n' + entries.filter(([key]) => key.includes('.tools.')).map(([key, value]) => `\n[${key.slice(0, key.lastIndexOf('.'))}]\napproval_mode = ${JSON.stringify(value)}\n`).join('');
}
