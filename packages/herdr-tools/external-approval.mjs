import { createHash, randomUUID } from "node:crypto";

const SAFE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Conservative POSIX-shell word lexer. Operators are preserved; expansions are
// never evaluated. Any syntax outside this small grammar is ineligible for approval.
function lexShell(input) {
  if (typeof input !== "string" || input.length > 20_000) return undefined;
  const out = [];
  let word = "", active = false, quote = "";
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote === "'") { if (c === "'") quote = ""; else word += c; active = true; continue; }
    if (quote === '"') {
      if (c === '"') { quote = ""; active = true; }
      else if (c === "\\") { if (++i >= input.length) return undefined; word += input[i]; active = true; }
      else { word += c; active = true; }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; active = true; continue; }
    if (c === "\\") { if (++i >= input.length || /[\n\r]/.test(input[i])) return undefined; word += input[i]; active = true; continue; }
    if (/[\n\r;]/.test(c) || c === "&" || c === "|" || c === "(" || c === ")" || c === "<" || c === ">") {
      if (active) { out.push({ word }); word = ""; active = false; }
      let op = c;
      if (["&", "|", ">", "<"].includes(c) && input[i + 1] === c) op += input[++i];
      if ((c === "&" || c === "|") && input[i + 1] === "&" && op.length === 1) op += input[++i];
      out.push({ op }); continue;
    }
    if (/\s/.test(c)) { if (active) { out.push({ word }); word = ""; active = false; } continue; }
    word += c; active = true;
  }
  if (quote) return undefined;
  if (active) out.push({ word });
  return out;
}
function wordsOnly(tokens) { return tokens?.every((t) => t.word !== undefined) ? tokens.map((t) => t.word) : undefined; }
function directOperation(argv) {
  if (!argv || argv[0] !== "gh" || argv[1] !== "pr" || !["create", "merge"].includes(argv[2])) return undefined;
  const repos = [];
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (/[$`*?{}]/.test(a)) return undefined;
    if (a === "-R" || a === "--repo") { if (!argv[i + 1]) return undefined; repos.push(argv[++i]); }
    else if (a.startsWith("--repo=")) repos.push(a.slice(7));
    else if (a.startsWith("-R=") ) repos.push(a.slice(3));
  }
  if (repos.length !== 1 || !SAFE_REPO.test(repos[0])) return undefined;
  return { operation: argv[2], argv, repo: repos[0] };
}

export function parseApprovedGhOperation(command) {
  const tokens = lexShell(command);
  const argv = wordsOnly(tokens);
  return directOperation(argv);
}

// Detect target commands even through shell wrappers, quoting, concatenation,
// environment assignments and `sh -c`. Unknown syntax mentioning gh is blocked.
export function containsGhPrMutation(command) {
  const tokens = lexShell(command);
  if (!tokens) return typeof command === "string" && /\b(?:gh|pr)\b/i.test(command);
  const readonly = wordsOnly(tokens);
  const readOnlyVerbs = new Set(["list", "view", "status", "diff", "checks"]);
  if (readonly && readonly.length >= 3 && readonly[0] === "gh" && readonly[1] === "pr" && readOnlyVerbs.has(readonly[2]) && command === readonly.join(" ") && !/[$`*?{}~#]/.test(command)) return false;
  const optionTakesValue = new Set(["-R", "--repo", "--hostname", "--config"]);
  let sawGhPr = false;
  const scan = (list, depth = 0) => {
    if (depth > 4) return true;
    for (let i = 0; i < list.length; i++) {
      const executable = list[i]?.word;
      if (executable === "gh" || executable?.endsWith("/gh") || executable === "gh.exe") {
        let j = i + 1;
        while (list[j]?.word?.startsWith("-")) {
          const flag = list[j++].word.split("=", 1)[0];
          if (!list[j - 1].word.includes("=") && optionTakesValue.has(flag) && list[j]?.word) j++;
        }
        if (list[j]?.word === "pr") {
          sawGhPr = true;
          j++;
          while (list[j]?.word?.startsWith("-")) {
            const flag = list[j++].word.split("=", 1)[0];
            if (!list[j - 1].word.includes("=") && optionTakesValue.has(flag) && list[j]?.word) j++;
          }
          // Every PR command except the exact full-command exception above is gated.
          return true;
        }
      }
      if ((list[i].word === "sh" || list[i].word === "bash") && list[i + 1]?.word === "-c" && list[i + 2]?.word) {
        const nested = lexShell(list[i + 2].word);
        if (!nested || scan(nested, depth + 1)) return true;
      }
    }
    return false;
  };
  if (scan(tokens)) return true;
  // Syntax outside our lexer mentioning both components is ambiguous, unless
  // the only parsed gh pr command(s) were explicitly read-only.
  return !sawGhPr && /\bgh\b/i.test(command) && /\bpr\b/i.test(command);
}

// Dynamic/indirect execution and shell composition are denied in Herdr sessions.
// This catches eval-only commands that cannot be tied lexically to a target.
export function containsUnsafeShellExecution(command) {
  const tokens = lexShell(command);
  if (!tokens || tokens.some((token) => token.op !== undefined)) return true;
  if (typeof command !== "string" || command !== tokens.map((token) => token.word).join(" ") || /[$`*?{}~#]/.test(command)) return true;
  const words = wordsOnly(tokens) ?? [];
  return words.some((word) => ["eval", "source", ".", "env", "command", "exec", "sh", "bash", "zsh", "dash"].includes(word));
}

export function issueExternalApproval(command, binding, { now = Date.now(), ttlMs = 30_000 } = {}) {
  const parsed = parseApprovedGhOperation(command);
  if (!parsed || !binding?.repo || !binding?.head || !binding?.paneId || !binding?.sessionId || binding?.caller !== "root" || binding?.targetRepo !== parsed.repo || !binding?.remoteName || !binding?.host) return undefined;
  return { id: randomUUID(), digest: createHash("sha256").update(JSON.stringify({ argv: parsed.argv, binding, operation: parsed.operation })).digest("hex"), argv: parsed.argv, operation: parsed.operation, binding: { ...binding }, expiresAt: now + ttlMs, used: false };
}

export function consumeExternalApproval(token, command, binding, { now = Date.now() } = {}) {
  if (!token || token.used) return false;
  token.used = true;
  const parsed = parseApprovedGhOperation(command);
  if (!parsed || token.expiresAt <= now || token.binding?.targetRepo !== parsed.repo) return false;
  const digest = createHash("sha256").update(JSON.stringify({ argv: parsed.argv, binding, operation: parsed.operation })).digest("hex");
  return digest === token.digest && JSON.stringify(parsed.argv) === JSON.stringify(token.argv) && JSON.stringify(binding) === JSON.stringify(token.binding);
}
