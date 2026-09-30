import { createHash, randomUUID } from "node:crypto";

const SAFE_ATOM = /^[A-Za-z0-9._/:=@+-]+$/;

/** Accept only one literal gh PR operation; never parse shell programs as argv. */
export function parseApprovedGhOperation(command) {
  if (typeof command !== "string" || /[;&|`$<>\n\r\\]/.test(command)) return undefined;
  const argv = command.trim().split(/\s+/);
  if (!argv.length || argv.some((arg) => !SAFE_ATOM.test(arg))) return undefined;
  if (argv[0] !== "gh" || argv[1] !== "pr" || !["create", "merge"].includes(argv[2])) return undefined;
  if (argv.slice(3).some((arg) => arg.startsWith("-") && arg.length < 2)) return undefined;
  const repos = [];
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === "-R" || argv[i] === "--repo") {
      if (!argv[i + 1]) return undefined;
      repos.push(argv[++i]);
    } else if (argv[i].startsWith("--repo=")) repos.push(argv[i].slice(7));
    else if (argv[i].startsWith("-R=")) repos.push(argv[i].slice(3));
  }
  if (repos.length !== 1 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repos[0])) return undefined;
  return { operation: argv[2], argv, repo: repos[0] };
}

/** Broad fail-closed detector: wrappers/scripts are mutations, never approvals. */
export function containsGhPrMutation(command) {
  return typeof command === "string" && /(?:['"]?\bgh['"]?)(?:\s+--[\w-]+(?:=\S+|\s+\S+)?)*\s+pr\s+(?:create|merge)\b/i.test(command);
}

export function issueExternalApproval(command, binding, { now = Date.now(), ttlMs = 30_000 } = {}) {
  const parsed = parseApprovedGhOperation(command);
  if (!parsed || !binding?.repo || !binding?.head || !binding?.paneId || !binding?.sessionId || binding?.caller !== "root" || binding?.targetRepo !== parsed.repo) return undefined;
  return {
    id: randomUUID(),
    digest: createHash("sha256").update(JSON.stringify({ argv: parsed.argv, binding, operation: parsed.operation })).digest("hex"),
    argv: parsed.argv,
    operation: parsed.operation,
    binding: { ...binding },
    expiresAt: now + ttlMs,
    used: false,
  };
}

/** Consume before execution. Even failed/mismatched attempts burn the token. */
export function consumeExternalApproval(token, command, binding, { now = Date.now() } = {}) {
  if (!token || token.used) return false;
  token.used = true;
  const parsed = parseApprovedGhOperation(command);
  if (!parsed || token.expiresAt <= now || token.binding?.targetRepo !== parsed.repo) return false;
  const digest = createHash("sha256").update(JSON.stringify({ argv: parsed.argv, binding, operation: parsed.operation })).digest("hex");
  return digest === token.digest && JSON.stringify(parsed.argv) === JSON.stringify(token.argv) && JSON.stringify(binding) === JSON.stringify(token.binding);
}
