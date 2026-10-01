import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { codexWorkerTable, policyDigest } from './host-policy.mjs';

const quote = text => `'${String(text).replaceAll("'", "'\\''")}'`;
export async function launch(config, scope, job, profile) {
  const server = join(config.source, 'src', 'mcp.mjs');
  const env = { BAA_CONFIG: config.file, BAA_SCOPE: scope, BAA_JOB: job.id };
  const command = process.execPath;
  const args = [server, '--config', config.file, '--scope', scope, '--worker', job.id, '--policy', policyDigest(config)];
  const dir = join(config.stateDir, 'launch', scope, job.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const write = async (file, data) => { const path = join(dir, file); await writeFile(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); return path; };
  if (profile.harness === 'codex') {
    const loader = join(dir, 'mcp.mjs');
    await writeFile(loader, `import { run } from ${JSON.stringify(pathToFileURL(server).href)};\nawait run(${JSON.stringify({ config: config.file, scope, worker: job.id, policy: policyDigest(config) })});\n`, { mode: 0o600 });
    // A disabled entry still needs a valid transport when absent from user config.
    return { env, argv: ['--model', profile.model, '--sandbox', job.access === 'read' ? 'read-only' : 'workspace-write', '-c', `model_reasoning_effort=${JSON.stringify(profile.effort)}`, ...(profile.serviceTier ? ['-c', `service_tier=${JSON.stringify(profile.serviceTier)}`] : []), '-c', `mcp_servers.baa-ton=${codexWorkerTable(config, command, loader, job.id)}`, '-c', 'mcp_servers.baa-ton-native={command="node",args=[],enabled=false}'] };
  }
  if (profile.harness === 'claude') {
    const mcp = await write('mcp.json', { mcpServers: { 'baa-ton': { command, args, env } } });
    const argv = ['--model', profile.model, '--effort', profile.effort, '--mcp-config', mcp, '--strict-mcp-config', '--permission-mode', job.access === 'read' ? 'plan' : 'manual'];
    if (profile.permissions === 'broker') {
      const hook = [command, join(config.source, 'src', 'permission-hook.mjs'), '--config', config.file, '--scope', scope, '--worker', job.id].map(quote).join(' ');
      const settings = await write('settings.json', { hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: hook, timeout: 310 }] }] } });
      argv.push('--settings', settings);
    }
    return { env, argv };
  }
  if (profile.harness === 'pi') {
    // Pi loads a tiny extension using its public registerTool API; no SDK dependency.
    const extension = join(dir, 'pi.mjs');
    await writeFile(extension, `import attach from ${JSON.stringify(join(config.source, 'src', 'pi.mjs'))};\nexport default pi => attach(pi, ${JSON.stringify({ file: config.file, scope, worker: job.id })});\n`, { mode: 0o600 });
    const argv = ['--provider', profile.provider, '--model', profile.model, '--thinking', profile.effort, '--no-extensions', '--extension', extension];
    // Pi does not offer an OS sandbox. Never describe this as one.
    if (job.access === 'read') argv.push('--exclude-tools', 'bash,edit,write');
    return { env, argv };
  }
  const mcp = { type: 'local', command: [command, ...args], environment: env, enabled: true };
  const options = { reasoningEffort: profile.effort };
  const overlay = { model: `${profile.provider}/${profile.model}`, mcp: { 'baa-ton': mcp, 'baa-ton-native': { enabled: false } }, provider: { [profile.provider]: { models: { [profile.model]: { options } } } }, permission: job.access === 'read' ? { edit: 'deny', bash: 'ask' } : { edit: 'ask', bash: 'ask' } };
  // Environment overlay avoids editing the project's existing opencode.json.
  return { env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(overlay) }, argv: ['--model', `${profile.provider}/${profile.model}`] };
}
