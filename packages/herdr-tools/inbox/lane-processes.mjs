/**
 * A lane's whole process tree (docs/SELF-HEALING.md). Every process a lane
 * starts inherits its tab's BAA_STARTUP_INTENT, including dev stacks, test
 * runners and background shells that were reparented to pid 1 when their
 * parent exited, so retire finds them by that marker in one `ps` call, kills
 * them and checks that the lane's ports are free. The same table reports
 * orphaned shells.
 */
import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const LANE_MARKER = "BAA_STARTUP_INTENT";
export const ORPHAN_SHELL_AGE_MS = 24 * 60 * 60_000;

/** `[[dd-]hh:]mm:ss` as milliseconds. */
export function elapsedMs(etime) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(etime ?? "").trim());
  if (!match) return undefined;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

/** Rows of `ps -axEww -o pid=,ppid=,etime=,command=`: the command line with the environment after it. */
export function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), ageMs: elapsedMs(match[3]), line: match[4] });
  }
  return rows;
}

export async function readProcessTable(run = (args) => execFileAsync("/bin/ps", args, { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })) {
  const { stdout } = await run(["-axEww", "-o", "pid=,ppid=,etime=,command="]);
  return parseProcessTable(stdout);
}

/**
 * The lane's processes: every row carrying its exact marker (the variable
 * followed by whitespace or the end of the line), and their descendants.
 * Never this process or its ancestors.
 */
export function laneProcesses(rows, intentPath, { self = process.pid } = {}) {
  if (!intentPath) return [];
  const token = ` ${LANE_MARKER}=${intentPath}`;
  const marked = new Set(rows.filter((row) => {
    const at = row.line.indexOf(token);
    if (at < 0) return false;
    const next = row.line[at + token.length];
    return next === undefined || /\s/.test(next);
  }).map((row) => row.pid));
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const protectedPids = new Set();
  for (let pid = self; pid > 1 && !protectedPids.has(pid); pid = byPid.get(pid)?.ppid ?? 0) protectedPids.add(pid);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows)
      if (!marked.has(row.pid) && marked.has(row.ppid)) {
        marked.add(row.pid);
        grew = true;
      }
  }
  return rows.filter((row) => marked.has(row.pid) && !protectedPids.has(row.pid) && row.pid > 1);
}

function signal(kill, pid, name) {
  try {
    kill(pid, name);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * SIGTERM the lane's processes, then SIGKILL what is left after `graceMs`.
 * Returns the pids signalled and any that survived both.
 */
export async function killLaneProcesses({ intentPath, table = readProcessTable, kill = process.kill.bind(process), graceMs = 3_000, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const found = laneProcesses(await table(), intentPath);
  if (!found.length) return { signalled: [], survivors: [] };
  for (const row of found) signal(kill, row.pid, "SIGTERM");
  await delay(graceMs);
  // The same pids, still running (a child whose parent died has lost its tie).
  const left = new Set((await table()).map((row) => row.pid));
  const stubborn = found.filter((row) => left.has(row.pid));
  for (const row of stubborn) signal(kill, row.pid, "SIGKILL");
  if (stubborn.length) await delay(Math.min(graceMs, 1_000));
  const running = stubborn.length ? new Set((await table()).map((row) => row.pid)) : new Set();
  const after = new Set(stubborn.filter((row) => running.has(row.pid)).map((row) => row.pid));
  return {
    signalled: found.map((row) => ({ pid: row.pid, command: row.line.split(/\s+/)[0].split("/").pop() })),
    killed: stubborn.map((row) => row.pid),
    survivors: [...after],
  };
}

/** Whether something accepts connections on the port (IPv4 or IPv6 loopback). */
export function portListening(port, { timeoutMs = 1_000 } = {}) {
  const probe = (host) =>
    new Promise((resolve) => {
      const socket = net.connect({ port, host });
      const done = (open) => {
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  return Promise.all([probe("127.0.0.1"), probe("::1")]).then((open) => open.some(Boolean));
}

export async function busyPorts(ports, listening = portListening) {
  const busy = [];
  for (const port of ports ?? []) if (Number.isSafeInteger(port) && (await listening(port))) busy.push(port);
  return busy;
}

const SHELL = /^(?:-|\S*\/)?(?:zsh|bash|sh|fish|gitstatusd\S*)(?:\s|$)/;

/** Shells reparented to pid 1 (their terminal and parent gone) older than a day. */
export function orphanShells(rows, { minAgeMs = ORPHAN_SHELL_AGE_MS } = {}) {
  return rows
    .filter((row) => row.ppid === 1 && SHELL.test(row.line) && (row.ageMs ?? 0) >= minAgeMs)
    .map((row) => ({ pid: row.pid, ageMs: row.ageMs, command: row.line.split(/\s+/)[0] }));
}
