#!/usr/bin/env node
import { loadConfig } from './config.mjs';
import { Baton } from './core.mjs';
import { invoke, toolList } from './tools.mjs';
import { codexConfig } from './host-policy.mjs';

const usage = `Baa-ton: small native HERDR tools (Node 22+, no dependencies)

  node src/cli.mjs tools
  node src/cli.mjs host-config --config FILE
  node src/cli.mjs status --config FILE [--scope NAME] [--job ID] [--lines 60]
  node src/cli.mjs goal --config FILE --scope NAME --action set --objective TEXT
  node src/cli.mjs pause|resume --config FILE --scope NAME
  node src/cli.mjs dispatch --config FILE --scope NAME --profile NAME --task TEXT --requestId ID [--access write --branch BRANCH]
  node src/cli.mjs message --config FILE --scope NAME --job ID --text TEXT --requestId ID [--redirect]
  node src/cli.mjs tick --config FILE --scope NAME
  node src/cli.mjs call herdr_result --config FILE --scope NAME < arguments.json

All other tool names work without the herdr_ prefix. Complex values use 'call'
and a JSON object on stdin. Each command exits; schedule tick only if wanted.
No install, service restart, model default, or user config is changed.`;

try {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) process.stdout.write(usage + '\n');
  else if (command === 'tools') process.stdout.write(JSON.stringify(toolList(), null, 2) + '\n');
  else {
    let tool = command === 'call' ? argv.shift() : `herdr_${command}`;
    const options = {}, args = {};
    for (let index = 0; index < argv.length; index++) {
      const flag = argv[index];
      if (!flag.startsWith('--')) throw new Error(`Unexpected argument ${flag}; use --help.`);
      const key = flag.slice(2);
      let value = ['redirect'].includes(key) ? true : argv[++index];
      if (value === undefined) throw new Error(`Missing value for ${flag}.`);
      if (['lines', 'timeout', 'revision', 'intervalSeconds', 'maxNudges'].includes(key)) value = Number(value);
      if (['config', 'scope', 'worker'].includes(key)) options[key] = value;
      else args[key] = value;
    }
    if (command === 'call') {
      let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 1024 * 1024) throw new Error('Input too large.'); }
      Object.assign(args, JSON.parse(input));
    }
    if (command === 'pause' || command === 'resume') { tool = 'herdr_goal'; args.action = command; }
    const config = await loadConfig(options.config);
    if (command === 'host-config') process.stdout.write(codexConfig(config));
    else {
      const baton = new Baton(config, { scope: options.scope || process.env.BAA_SCOPE, worker: options.worker || process.env.BAA_JOB });
      const result = await invoke(baton, tool, args);
      process.stdout.write(JSON.stringify(result ?? null, null, 2) + '\n');
    }
  }
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
