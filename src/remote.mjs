import { execFile } from 'node:child_process';
import { posix, win32 } from 'node:path';

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const powershellQuote = value => `'${value.replaceAll("'", "''")}'`;
export function validateRemote(remote) {
  if (!remote || !['posix', 'windows'].includes(remote.platform) || typeof remote.ssh !== 'string' || !/^[A-Za-z0-9_.@:-]+$/.test(remote.ssh) || remote.ssh.startsWith('-')) throw new Error('Remote requires platform posix/windows and an explicit existing SSH host alias or user@host.');
  const paths = remote.platform === 'windows' ? win32 : posix;
  for (const key of ['node', 'runtime', 'config']) if (typeof remote[key] !== 'string' || !paths.isAbsolute(remote[key]) || /[\x00-\x1f]/.test(remote[key])) throw new Error(`Remote ${key} must be an absolute ${remote.platform} path without control characters.`);
  if (Object.keys(remote).some(key => !['ssh', 'platform', 'node', 'runtime', 'config'].includes(key))) throw new Error('Remote accepts only ssh, platform, node, runtime and config. SSH settings belong in the existing SSH configuration.');
}
export function remoteCommand(remote, scope, tool, worker) {
  validateRemote(remote);
  const paths = remote.platform === 'windows' ? win32 : posix;
  const args = [remote.node, paths.join(remote.runtime, 'src', 'cli.mjs'), 'call', tool, '--config', remote.config, '--scope', scope, ...(worker ? ['--worker', worker] : [])];
  if (remote.platform === 'posix') return `exec ${args.map(shellQuote).join(' ')}`;
  const script = `$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; & ${args.map(powershellQuote).join(' ')}; exit $LASTEXITCODE`;
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}
const execute = (command, args, options) => new Promise((resolve, reject) => {
  const child = execFile(command, args, { timeout: options.timeout, signal: options.signal, maxBuffer: 2 * 1024 * 1024, shell: false }, (error, stdout) => error ? reject(error) : resolve(stdout));
  child.stdin.on('error', () => {}); child.stdin.end(options.input);
});

// One SSH process invokes the same host-local CLI. No relay daemon, remote shell
// tool, account provisioning, installer invocation or retry loop is exposed.
export async function remoteCall(config, scope, tool, args, { signal, worker, run = execute } = {}) {
  const route = config.scopes[scope], remote = config.remotes[route.remote];
  const command = remoteCommand(remote, route.scope, tool, worker);
  const input = JSON.stringify({ ...args, scope: route.scope }) + '\n';
  try {
    const stdout = await run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', remote.ssh, command], { timeout: Math.min(330000, (args.timeout || 300000) + 10000), signal, input });
    return JSON.parse(stdout);
  } catch (error) { throw new Error(`Remote ${route.remote} call failed or its outcome is uncertain: ${error.message}. Inspect remote status and reuse stable request IDs; never assume nondelivery. Runtime/config must already be installed on that host.`); }
}
