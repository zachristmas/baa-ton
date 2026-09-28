#!/usr/bin/env node
/**
 * The lane guard: a PreToolUse hook for every Claude lane Baa-ton launches.
 * Lanes run in bypassPermissions mode (no prompts), so the hard limits are
 * enforced here, whatever the permission mode, next to the deny rules in the
 * lane's settings:
 * - Write, Edit, MultiEdit and NotebookEdit only inside the lane's own
 *   worktree (the session cwd), /tmp, a session scratchpad or the lane's
 *   scratch directory;
 * - no tool reads or writes credentials: SSH keys, cloud credentials,
 *   .netrc, keychain passwords, `gh auth token`, and .env files outside the
 *   worktree.
 * Anything else gets no decision from this hook (the normal rules apply).
 *
 * Usage: node lane-guard.mjs [--scratch <dir>]   (hook input on stdin)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const home = homedir();
const CREDENTIAL_PATH = new RegExp(
  [
    `(?:^|[\\s'"=:(])(?:~|${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})/\\.(?:ssh|aws|gnupg|netrc|docker/config\\.json|config/gh/hosts\\.yml)\\b`,
    "\\bid_(?:rsa|ed25519|ecdsa|dsa)\\b",
    "(?:^|[\\s/'\"])\\.netrc\\b",
    "\\.aws/credentials\\b",
  ].join("|"),
);
const CREDENTIAL_COMMAND = /\bsecurity\s+find-(?:generic|internet)-password\b|\bgh\s+auth\s+token\b|\bprintenv\s+\w*(?:TOKEN|SECRET|PASSWORD|KEY)\w*\b/i;

function inside(path, root) {
  const base = root.replace(/\/+$/, "");
  return path === base || path.startsWith(`${base}/`);
}

/** The guard's verdict for one tool call: { deny: reason } or undefined. */
export function laneGuardVerdict({ tool_name: tool, tool_input: input = {}, cwd } = {}, { scratch } = {}) {
  const worktree = typeof cwd === "string" && isAbsolute(cwd) ? cwd : undefined;
  const allowedRoots = [worktree, "/tmp", "/private/tmp", scratch].filter(Boolean);
  const pathOf = (value) => (typeof value === "string" && value ? (isAbsolute(value) ? resolve(value) : worktree ? resolve(worktree, value) : undefined) : undefined);
  const envOutsideWorktree = (path) => /(?:^|\/)\.env(?:\.[\w-]+)?$/.test(path) && !(worktree && inside(path, worktree));
  if (WRITE_TOOLS.has(tool)) {
    const path = pathOf(input.file_path ?? input.notebook_path);
    if (!path) return undefined;
    if (CREDENTIAL_PATH.test(path) || envOutsideWorktree(path)) return { deny: `${tool} of a credential file (${path}) is not allowed in a lane` };
    if (!allowedRoots.some((root) => inside(path, root))) return { deny: `${tool} outside the lane's worktree, /tmp and its scratch (${path}); lanes write only inside their own worktree` };
    return undefined;
  }
  if (tool === "Read" || tool === "Glob" || tool === "Grep") {
    const path = pathOf(input.file_path ?? input.path);
    if (path && (CREDENTIAL_PATH.test(path) || envOutsideWorktree(path))) return { deny: `${tool} of a credential file (${path}) is not allowed in a lane` };
    return undefined;
  }
  if (tool === "Bash") {
    const command = String(input.command ?? "");
    // Machine-wide kills: a lane's `killall node pnpm turbo` took down the
    // supervisor, the spec host and every lane's MCP bridge. A lane stops
    // its own processes by pid (echo $! > pidfile, then kill $(cat pidfile))
    // or with a pkill pattern naming its own worktree.
    const own = "stop your own processes by pid (start them with `echo $! > /tmp/<name>.pid`, stop them with `kill $(cat /tmp/<name>.pid)`) or with `pkill -f` and a pattern that names your worktree path";
    if (/(?:^|[\s;&|(])killall(?:\s|$)/.test(command)) return { deny: `killall stops every matching process on the machine, other lanes' and Baa-ton's too; ${own}` };
    if (/(?:^|[\s;&|(])kill\s+(?:-\S+\s+)*(?:-1|0)(?:\s|$)/.test(command)) return { deny: `kill -1 and kill 0 reach far beyond this lane; ${own}` };
    for (const match of command.matchAll(/(?:^|[\s;&|(])pkill\b([^;&|]*)/g)) {
      if (!(worktree && match[1].includes(worktree))) return { deny: `pkill without your worktree path in its pattern can stop other lanes and Baa-ton itself; ${own}` };
    }
    if (CREDENTIAL_COMMAND.test(command) || CREDENTIAL_PATH.test(command)) return { deny: "this command reads credentials (keys, tokens, keychain or cloud credentials), which lanes never do" };
    for (const match of command.matchAll(/(?:^|[\s'"=<>])((?:~|\/)[^\s'";|&<>]*\/\.env(?:\.[\w-]+)?)(?=$|[\s'";|&<>])/g)) {
      const path = match[1].startsWith("~") ? `${home}${match[1].slice(1)}` : match[1];
      if (envOutsideWorktree(path)) return { deny: `this command touches an environment file outside the lane's worktree (${path})` };
    }
  }
  return undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--scratch");
  const scratch = index > 0 ? process.argv[index + 1] : undefined;
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    process.exit(0);
  }
  const verdict = laneGuardVerdict(input, { scratch });
  if (verdict)
    process.stdout.write(
      `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Baa-ton lane guard: ${verdict.deny}.` } })}\n`,
    );
  process.exit(0);
}
