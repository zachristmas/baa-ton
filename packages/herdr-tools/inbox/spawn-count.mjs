/**
 * How many processes Baa-ton starts (docs/SELF-HEALING.md): every child
 * process a Node process starts goes through ChildProcess.prototype.spawn
 * (spawn, execFile, exec and fork alike). Each Baa-ton process (supervisor,
 * spec host, root extension, lane bridges) tallies its own by command and,
 * once a minute, appends one line to <config dir>/spawn-counts.jsonl; the
 * supervisor sums the lines into one per-minute log entry, so the spawn rate
 * can be set against the OS's exec-check load.
 */
import { ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const SPAWN_COUNT_FILE = "spawn-counts.jsonl";
const FLUSH_MS = 60_000;
const MAX_BYTES = 2 * 1024 * 1024;
let installed;

export function spawnCountPath(env = process.env) {
  const dir = env.HERDR_PLUGIN_CONFIG_DIR || join(env.HOME || homedir(), ".config", "herdr", "plugins", "config", "herdr-orchestrator-controller");
  return join(dir, SPAWN_COUNT_FILE);
}

/** The tally key for one spawn: the command's basename, with lane shells (herdr tab create) apart. */
export function spawnKey(file, args = []) {
  const name = basename(String(file ?? "?"));
  if (name === "herdr" && args[0] === "tab" && args[1] === "create") return "lane-shell (herdr tab create)";
  // Which herdr call: the subcommand pair names what polls.
  if (name === "herdr" && /^[a-z-]+$/.test(String(args[0] ?? ""))) return `herdr ${args[0]}${/^[a-z-]+$/.test(String(args[1] ?? "")) ? ` ${args[1]}` : ""}`;
  if (name === "git") return `git ${String(args.find((arg) => /^[a-z][a-z-]*$/.test(String(arg))) ?? "")}`.trim();
  if ((name === "sh" || name === "bash" || name === "zsh") && args[0] === "-c") return `${name} -c ${basename(String(args[1] ?? "").split(/\s+/)[0] || "?")}`;
  return name;
}

/**
 * Count this process's spawns under `role`, flushed once a minute. Idempotent;
 * off under BAA_TON_NO_SPAWN_PROBE=1 (tests). Returns a flush function.
 */
export function installSpawnCounter(role, { env = process.env, path = spawnCountPath(env), clock = () => Date.now() } = {}) {
  if (installed) return installed;
  if (env.BAA_TON_NO_SPAWN_PROBE === "1") return (installed = () => undefined);
  const counts = new Map();
  const original = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function countedSpawn(options) {
    try {
      const key = spawnKey(options?.file, (options?.args ?? []).slice(1));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } catch {
      // Counting never gets in a spawn's way.
    }
    return original.call(this, options);
  };
  const flush = () => {
    if (!counts.size) return;
    const line = `${JSON.stringify({ at: new Date(clock()).toISOString(), role, pid: process.pid, counts: Object.fromEntries(counts) })}\n`;
    counts.clear();
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, line, { mode: 0o600 });
    } catch {
      // Best effort.
    }
  };
  const timer = setInterval(flush, FLUSH_MS);
  timer.unref?.();
  process.once("exit", flush);
  installed = flush;
  return flush;
}

/**
 * The supervisor's reader: the lines appended since the last read, summed
 * into { total, byRole: { role: { key: n } } }. The file is rotated past 2 MB.
 */
export function createSpawnCountReader({ path = spawnCountPath() } = {}) {
  let offset = 0;
  return {
    read() {
      let text = "";
      try {
        const size = statSync(path).size;
        if (size < offset) offset = 0;
        text = readFileSync(path, "utf8").slice(offset);
        offset += Buffer.byteLength(text);
        if (size > MAX_BYTES) {
          renameSync(path, `${path}.1`);
          offset = 0;
        }
      } catch {
        return { total: 0, byRole: {} };
      }
      const byRole = {};
      let total = 0;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const bucket = (byRole[entry.role] ??= {});
          for (const [key, count] of Object.entries(entry.counts ?? {})) {
            bucket[key] = (bucket[key] ?? 0) + count;
            total += count;
          }
        } catch {
          // A torn line is skipped.
        }
      }
      return { total, byRole };
    },
  };
}

/** One log line: "spawns in the last minute: 37 (spec-host: git 20, herdr 8; supervisor: herdr 4; hook events 5)". */
export function formatSpawnCounts({ total, byRole }, extra = {}) {
  const parts = Object.entries(byRole)
    .map(([role, counts]) => `${role}: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key} ${count}`).join(", ")}`);
  for (const [key, count] of Object.entries(extra)) if (count) parts.push(`${key} ${count}`);
  const extraTotal = Object.values(extra).reduce((sum, count) => sum + (count || 0), 0);
  return `spawns in the last minute: ${total + extraTotal}${parts.length ? ` (${parts.join("; ")})` : ""}`;
}
