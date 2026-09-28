/**
 * The ports and databases an item's own demo scripts pin
 * (scripts/demo-<id>*: a guard, a lane-config.sh, env files). A verify or
 * demo lane leased other ports refused to run the item's demo off its lease,
 * and would not edit the item's scripts, so it stalled. The pins are handed
 * to the lane as its own for that demo (docs/SPEC-LOOP.md).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 256 * 1024;
const PORT_PATTERNS = [/\b[A-Z_]*PORT[A-Z_]*\s*[=:]\s*["']?(\d{4,5})\b/g, /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})\b/g, /--port[=\s]+(\d{4,5})\b/g];
const DB_PATTERNS = [/\b(?:[A-Z_]*DB_NAME|PGDATABASE|POSTGRES_DB|DATABASE_NAME|DB)\s*[=:]\s*["']?([A-Za-z_][\w-]{2,62})\b/g, /\bpostgres(?:ql)?:\/\/[^\s'"/]*\/([A-Za-z_][\w-]{2,62})\b/g];

function files(dir, depth = 0) {
  const found = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory() && depth < 2) found.push(...files(path, depth + 1));
    else if (entry.isFile() && /\.(?:mjs|cjs|js|ts|sh|env|json|ya?ml|toml|txt|conf)$|^\.?env/.test(entry.name)) found.push(path);
  }
  return found;
}

/** { dirs, ports, databases } pinned by the item's demo scripts, or undefined. */
export function findDemoPins(worktree, itemId) {
  if (!worktree || !itemId) return undefined;
  const scripts = join(worktree, "scripts");
  let names = [];
  try {
    names = readdirSync(scripts);
  } catch {
    return undefined;
  }
  const prefix = `demo-${String(itemId).toLowerCase()}`;
  const dirs = names.filter((name) => name.toLowerCase() === prefix || name.toLowerCase().startsWith(`${prefix}-`)).map((name) => join(scripts, name));
  if (!dirs.length) return undefined;
  const ports = new Set();
  const databases = new Set();
  for (const dir of dirs)
    for (const path of files(dir)) {
      let text;
      try {
        if (statSync(path).size > MAX_BYTES) continue;
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      for (const pattern of PORT_PATTERNS)
        for (const match of text.matchAll(pattern)) {
          const port = Number(match[1]);
          if (port >= 1024 && port <= 65535) ports.add(port);
        }
      for (const pattern of DB_PATTERNS) for (const match of text.matchAll(pattern)) databases.add(match[1]);
    }
  if (!ports.size && !databases.size) return undefined;
  return { dirs: dirs.map((dir) => dir.slice(worktree.length + 1)), ports: [...ports].sort((a, b) => a - b), databases: [...databases].sort() };
}

/** The contract lines that hand a lane its item's demo pins. */
export function demoPinLines(pins) {
  if (!pins || (!pins.ports?.length && !pins.databases?.length)) return [];
  const what = [pins.ports?.length ? `ports ${pins.ports.join(", ")}` : "", pins.databases?.length ? `database${pins.databases.length > 1 ? "s" : ""} ${pins.databases.join(", ")}` : ""].filter(Boolean).join(" and ");
  return [
    `This item's own demo scripts (${pins.dirs.join(", ")}) pin ${what}. They are yours for this item's demo: run it on them exactly as the scripts are written (dev stacks take turns, so nothing else uses them meanwhile). Do not edit the demo scripts to use leased values, and do not stop over a lease mismatch.`,
  ];
}
