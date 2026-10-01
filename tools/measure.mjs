#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
const ref = process.argv[2];
const paths = (ref ? execFileSync('git', ['ls-tree', '-r', '--name-only', ref], { encoding: 'utf8' }) : execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })).trim().split('\n');
const groups = {}, files = [];
for (const file of [...new Set(paths)]) {
  if (!ref && !existsSync(file)) continue;
  const bytes = ref ? execFileSync('git', ['show', `${ref}:${file}`], { maxBuffer: 32 * 1024 * 1024 }) : readFileSync(file);
  if (bytes.includes(0)) { files.push({ file, group: 'binary', bytes: bytes.length }); continue; }
  const text = bytes.toString(), rows = text.split('\n'); if (rows.at(-1) === '') rows.pop();
  const group = /(^|\/)test\//.test(file) || /\.test\.[cm]?[jt]s$/.test(file) || /smoke/.test(file) ? 'tests' : /\.d\.(mts|ts)$/.test(file) ? 'declarations' : extname(file) === '.md' ? 'docs' : /\.(mjs|cjs|js|ts|sh|ps1|cmd)$/.test(file) ? 'runtime' : 'config';
  const value = groups[group] ||= { files: 0, lines: 0, nonblank: 0, bytes: 0 }; value.files++; value.lines += rows.length; value.nonblank += rows.filter(row => row.trim()).length; value.bytes += bytes.length;
  files.push({ file, group, lines: rows.length, nonblank: rows.filter(row => row.trim()).length });
}
process.stdout.write(JSON.stringify({ ref: ref || 'working tree (tracked plus nonignored new files)', totalFiles: files.length, groups, files }, null, 2) + '\n');
