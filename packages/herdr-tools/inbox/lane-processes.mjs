/**
 * A lane's whole process tree (docs/SELF-HEALING.md). Every process a lane
 * starts inherits its tab's BAA_STARTUP_INTENT, including dev stacks, test
 * runners and background shells that were reparented to pid 1 when their
 * parent exited. POSIX retire finds them by that exact environment marker;
 * Windows uses CIM process identity rooted at a recorded Herdr pane PID. Both
 * platforms kill descendants, verify survivors, and check the lane's ports.
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

export function parseWindowsProcessTable(value) {
  const data = typeof value === "string" ? JSON.parse(value || "[]") : value;
  const records = Array.isArray(data) ? data : data ? [data] : [];
  return records.map((entry) => ({
    pid: Number(entry.ProcessId),
    ppid: Number(entry.ParentProcessId),
    createdAt: typeof entry.CreationDate === "string" ? entry.CreationDate : undefined,
    line: typeof entry.CommandLine === "string" ? entry.CommandLine : "",
  })).filter((row) => Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isSafeInteger(row.ppid));
}

async function powershell(script) {
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true });
  return stdout;
}

export async function readProcessTable(options = {}) {
  const { platform = process.platform, run = (args) => execFileAsync("/bin/ps", args, { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }), runPowerShell = powershell } = typeof options === "function" ? { run: options } : options;
  if (platform === "win32") {
    const script = "Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress";
    return parseWindowsProcessTable(await runPowerShell(script));
  }
  const { stdout } = await run(["-axEww", "-o", "pid=,ppid=,etime=,command="]);
  return parseProcessTable(stdout);
}

/**
 * The lane's processes: every row carrying its exact marker (the variable
 * followed by whitespace or the end of the line), and their descendants.
 * Never this process or its ancestors.
 */
function descendants(rows, roots) {
  const marked = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows)
      if (!marked.has(row.pid) && marked.has(row.ppid)) {
        marked.add(row.pid);
        grew = true;
      }
  }
  return marked;
}

function processDepth(row, byPid) {
  let depth = 0;
  const seen = new Set([row.pid]);
  for (let pid = row.ppid; pid > 1 && !seen.has(pid);) {
    seen.add(pid);
    const parent = byPid.get(pid);
    if (!parent) break;
    depth += 1;
    pid = parent.ppid;
  }
  return depth;
}

function protectedAncestors(rows, self) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const protectedPids = new Set();
  for (let pid = self; pid > 1 && !protectedPids.has(pid); pid = byPid.get(pid)?.ppid ?? 0) protectedPids.add(pid);
  return protectedPids;
}

export function laneProcesses(rows, intentPath, { self = process.pid, recordedProcesses = [] } = {}) {
  const token = intentPath ? ` ${LANE_MARKER}=${intentPath}` : undefined;
  const roots = new Set(rows.filter((row) => {
    if (!token) return false;
    const at = row.line.indexOf(token);
    if (at < 0) return false;
    const next = row.line[at + token.length];
    return next === undefined || /\s/.test(next);
  }).map((row) => row.pid));
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  for (const record of recordedProcesses) {
    const row = byPid.get(Number(record?.pid));
    if (row && record.createdAt && row.createdAt === record.createdAt) roots.add(row.pid);
  }
  if (!roots.size) return [];
  const owned = descendants(rows, roots);
  const protectedPids = protectedAncestors(rows, self);
  return rows.filter((row) => owned.has(row.pid) && !protectedPids.has(row.pid) && row.pid > 1);
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
 * Stop descendants before parents so process identity remains provable. Each
 * depth gets SIGTERM, a grace period, then SIGKILL for stubborn members.
 * Returns the candidates and any that survived.
 */
async function stopWindowsProcess(pid, createdAt, force, runPowerShell = powershell) {
  const escaped = JSON.stringify(String(createdAt));
  const script = `$p = Get-CimInstance -ClassName Win32_Process -Filter \"ProcessId = ${pid}\"; if ($null -eq $p) { exit 3 }; if ([string]$p.CreationDate -ne ${escaped}) { exit 4 }; Stop-Process -Id ${pid}${force ? " -Force" : ""}`;
  await runPowerShell(script);
}

export async function killLaneProcesses({ intentPath, recordedProcesses = [], expectedPids, platform = process.platform, table = () => readProcessTable({ platform }), kill = process.kill.bind(process), runPowerShell = powershell, graceMs = 3_000, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const snapshot = await table();
  if (platform === "win32" && !recordedProcesses.length)
    throw new Error("Windows cannot enumerate process environments; exact recorded lane pane process identities are required.");
  if (platform === "win32" && recordedProcesses.some((record) => !record?.createdAt))
    throw new Error("Windows cannot prove creation time for a recorded process identity.");
  if (platform === "win32" && recordedProcesses.some((record) => snapshot.some((row) => row.pid === Number(record.pid)) && !snapshot.find((row) => row.pid === Number(record.pid))?.createdAt))
    throw new Error("Windows cannot prove creation time for a recorded process identity.");
  if (platform === "win32" && recordedProcesses.some((record) => snapshot.some((row) => row.pid === Number(record.pid) && row.createdAt !== record.createdAt)))
    throw new Error("Windows recorded process PID was reused before cleanup; refusing to stop it.");
  const found = laneProcesses(snapshot, intentPath, { recordedProcesses });
  const snapshotByPid = new Map(snapshot.map((row) => [row.pid, row]));
  found.sort((a, b) => processDepth(b, snapshotByPid) - processDepth(a, snapshotByPid));
  if (expectedPids) {
    const expected = [...expectedPids].map(Number).sort((a, b) => a - b);
    const observed = found.map((row) => row.pid).sort((a, b) => a - b);
    if (expected.join(",") !== observed.join(","))
      throw new Error(`process inventory changed before cleanup: planned=[${expected}] observed=[${observed}]; refusing to stop processes`);
  }
  if (!found.length) return { signalled: [], killed: [], survivors: [] };
  const signalOne = async (row, signalName) => {
    const current = await table();
    const samePid = current.find((candidate) => candidate.pid === row.pid);
    if (platform === "win32" && samePid && samePid.createdAt !== row.createdAt)
      throw new Error(`Windows process ${row.pid} was reused since inventory; refusing to stop it.`);
    const owned = laneProcesses(current, intentPath, { recordedProcesses });
    if (expectedPids) {
      const expected = new Set(expectedPids.map(Number));
      const unexpected = owned.filter((candidate) => !expected.has(candidate.pid));
      if (unexpected.length) throw new Error(`process inventory changed during cleanup: unexpected=[${unexpected.map((candidate) => candidate.pid).join(",")}]; refusing to stop processes`);
    }
    const live = owned.find((candidate) => candidate.pid === row.pid);
    if (!live) return false;
    if (platform === "win32" && live.createdAt !== row.createdAt)
      throw new Error(`Windows process ${row.pid} was reused since inventory; refusing to stop it.`);
    if (platform === "win32") {
      if (!row.createdAt) throw new Error(`Windows cannot prove creation time for process ${row.pid}.`);
      await stopWindowsProcess(row.pid, row.createdAt, signalName === "SIGKILL", runPowerShell);
      return true;
    }
    return signal(kill, row.pid, signalName);
  };
  const groups = new Map();
  for (const row of found) {
    const depth = processDepth(row, snapshotByPid);
    if (!groups.has(depth)) groups.set(depth, []);
    groups.get(depth).push(row);
  }
  const killed = [];
  const survivors = [];
  for (const depth of [...groups.keys()].sort((a, b) => b - a)) {
    const group = groups.get(depth);
    for (const row of group) await signalOne(row, "SIGTERM");
    await delay(graceMs);
    const current = await table();
    const stubborn = group.filter((row) => current.some((candidate) => candidate.pid === row.pid && (platform !== "win32" || candidate.createdAt === row.createdAt)));
    for (const row of stubborn) {
      if (await signalOne(row, "SIGKILL")) killed.push(row.pid);
    }
    if (stubborn.length) await delay(Math.min(graceMs, 1_000));
    const afterGroup = await table();
    const remainingInGroup = group.filter((row) => afterGroup.some((candidate) => candidate.pid === row.pid && (platform !== "win32" || candidate.createdAt === row.createdAt)));
    if (remainingInGroup.length) {
      survivors.push(...remainingInGroup.map((row) => row.pid));
      break;
    }
  }
  const afterTable = await table();
  const remaining = new Map(laneProcesses(afterTable, intentPath, { recordedProcesses }).map((row) => [row.pid, row]));
  for (const row of found) {
    const live = afterTable.find((candidate) => candidate.pid === row.pid && (platform !== "win32" || candidate.createdAt === row.createdAt));
    if (live) remaining.set(live.pid, live);
  }
  survivors.push(...[...remaining.keys()].filter((pid) => !survivors.includes(pid)));
  return {
    signalled: found.map((row) => ({ pid: row.pid, command: row.line.split(/\s+/)[0].split(/[\\/]/).pop() })),
    killed,
    survivors,
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

/**
 * Shells reparented to pid 1 (their terminal and parent gone) older than a
 * day. `laneOwned` marks the ones that inherited a lane tab's marker: only
 * those are Baa-ton's to report. Login shells from the user's own terminals
 * are theirs.
 */
export function orphanShells(rows, { minAgeMs = ORPHAN_SHELL_AGE_MS } = {}) {
  return rows
    .filter((row) => row.ppid === 1 && SHELL.test(row.line) && (row.ageMs ?? 0) >= minAgeMs)
    .map((row) => ({ pid: row.pid, ageMs: row.ageMs, command: row.line.split(/\s+/)[0], laneOwned: row.line.includes(` ${LANE_MARKER}=`) }));
}
