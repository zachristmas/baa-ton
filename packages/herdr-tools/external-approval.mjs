import { createHash, randomUUID } from "node:crypto";

const SAFE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function lexShell(input) {
  if (typeof input !== "string" || input.length > 20_000) return undefined;
  const out = []; let word = "", active = false, quote = "";
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote === "'") { if (c === "'") quote = ""; else word += c; active = true; continue; }
    if (quote === '"') { if (c === '"') { quote = ""; active = true; } else if (c === "\\") { if (++i >= input.length) return undefined; word += input[i]; active = true; } else { word += c; active = true; } continue; }
    if (c === "'" || c === '"') { quote = c; active = true; continue; }
    if (c === "\\") { if (++i >= input.length || /[\n\r]/.test(input[i])) return undefined; word += input[i]; active = true; continue; }
    if (/[\n\r;]/.test(c) || c === "&" || c === "|" || c === "(" || c === ")" || c === "<" || c === ">") {
      if (active) { out.push({ word }); word = ""; active = false; }
      let op = c; if (["&", "|", ">", "<"].includes(c) && input[i + 1] === c) op += input[++i];
      if ((c === "&" || c === "|") && input[i + 1] === "&" && op.length === 1) op += input[++i]; out.push({ op }); continue;
    }
    if (/\s/.test(c)) { if (active) { out.push({ word }); word = ""; active = false; } continue; }
    word += c; active = true;
  }
  if (quote) return undefined; if (active) out.push({ word }); return out;
}
function wordsOnly(tokens) { return tokens?.every((t) => t.word !== undefined) ? tokens.map((t) => t.word) : undefined; }
function directOperation(argv) {
  if (!argv) return undefined;
  if (argv[0] === "git" && argv[1] === "push") {
    if (argv.length !== 4 || argv[2].startsWith("-") || argv[2].includes("://") || argv[2].includes("@") || !/^[A-Za-z0-9_.-]+$/.test(argv[2])) return undefined;
    const match = /^([0-9a-fA-F]{40}|[0-9a-fA-F]{64}):refs\/heads\/([A-Za-z0-9][A-Za-z0-9._/-]*)$/.exec(argv[3]);
    if (!match || match[2].split("/").some((part) => !part || part === "." || part === "..") || match[2].endsWith(".")) return undefined;
    return { operation: "push", argv, remoteName: argv[2], branch: match[2], sourceRef: match[1].toLowerCase(), destinationRef: `refs/heads/${match[2]}` };
  }
  if (argv[0] !== "gh" || argv[1] !== "pr" || !["create", "merge"].includes(argv[2])) return undefined;
  const repos = [];
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i]; if (/[$`*?{}]/.test(a) || a === "--hostname" || a.startsWith("--hostname=")) return undefined;
    if (a === "-R" || a === "--repo") { if (!argv[i + 1]) return undefined; repos.push(argv[++i]); }
    else if (a.startsWith("--repo=")) repos.push(a.slice(7)); else if (a.startsWith("-R=")) repos.push(a.slice(3));
  }
  if (repos.length !== 1 || !SAFE_REPO.test(repos[0])) return undefined;
  return { operation: argv[2], argv, repo: repos[0] };
}
export function parseApprovedGhOperation(command) { return directOperation(wordsOnly(lexShell(command))); }
export function parseApprovedExternalOperation(command) { return directOperation(wordsOnly(lexShell(command))); }
function hasDynamicShellSyntax(input) {
  let quote = "", escaped = false, wordStart = true;
  for (const c of input) {
    if (escaped) { escaped = false; wordStart = false; continue; }
    if (quote === "'") { if (c === "'") quote = ""; wordStart = false; continue; }
    if (quote === '"') { if (c === '"') quote = ""; else if (c === "\\") escaped = true; else if (c === "$" || c === "`") return true; wordStart = false; continue; }
    if (c === "\\") { escaped = true; wordStart = false; continue; }
    if (c === "'" || c === '"') { quote = c; wordStart = false; continue; }
    if (c === "$" || c === "`" || c === "*" || c === "?" || c === "{" || c === "}" || (c === "~" && wordStart) || (c === "#" && wordStart)) return true;
    if (/\s/.test(c) || /[;&|()<>]/.test(c)) wordStart = true; else wordStart = false;
  }
  return false;
}
export function containsGhPrMutation(command) {
  const tokens = lexShell(command);
  if (!tokens) return typeof command === "string" && /\b(?:gh|pr)\b/i.test(command);
  const readonly = wordsOnly(tokens); const readOnlyVerbs = new Set(["list", "view", "status", "diff", "checks"]);
  const literalReadOnlyVerb = /^\s*gh\s+pr\s+([^\s'"]+)/.exec(command)?.[1];
  if (readonly && readonly.length >= 3 && readonly[0] === "gh" && readonly[1] === "pr" && readOnlyVerbs.has(readonly[2]) && literalReadOnlyVerb === readonly[2] && !hasDynamicShellSyntax(command)) return false;
  const optionTakesValue = new Set(["-R", "--repo", "--hostname", "--config"]); let sawGhPr = false;
  const scan = (list, depth = 0) => {
    if (depth > 4) return true;
    for (let i = 0; i < list.length; i++) {
      const executable = list[i]?.word;
      if (executable === "gh" || executable?.endsWith("/gh") || executable === "gh.exe") {
        let j = i + 1;
        while (list[j]?.word?.startsWith("-")) { const flag = list[j++].word.split("=", 1)[0]; if (!list[j - 1].word.includes("=") && optionTakesValue.has(flag) && list[j]?.word) j++; }
        if (list[j]?.word === "pr") { sawGhPr = true; return true; }
      }
      if ((list[i].word === "sh" || list[i].word === "bash") && list[i + 1]?.word === "-c" && list[i + 2]?.word) { const nested = lexShell(list[i + 2].word); if (!nested || scan(nested, depth + 1)) return true; }
    }
    return false;
  };
  if (scan(tokens)) return true;
  return !sawGhPr && /\bgh\b/i.test(command) && /\bpr\b/i.test(command);
}
export function containsGitPush(command) {
  const tokens = lexShell(command); if (!tokens) return typeof command === "string" && /\bgit\b/i.test(command) && /\bpush\b/i.test(command);
  // Global Git flags (-C/-c/--git-dir) must not bypass the pre-execution gate.
  // Conservatively fence any push word after a Git executable in a command.
  let git = false;
  for (const token of tokens) {
    if (token.op) { git = false; continue; }
    if (token.word === "git" || token.word === "git.exe" || /[/\\]git(?:\.exe)?$/.test(token.word)) git = true;
    if (git && token.word === "push") return true;
  }
  return false;
}
export function containsUnsafeShellExecution(command) {
  const tokens = lexShell(command); if (!tokens) return true;
  const words = wordsOnly(tokens) ?? [];
  if (words.some((word) => ["eval", "source", ".", "command", "exec", "sh", "bash", "zsh", "dash"].includes(word))) return true;
  return hasDynamicShellSyntax(command);
}
export function issueExternalApproval(command, binding, { now = Date.now(), ttlMs = 30_000 } = {}) {
  const parsed = parseApprovedExternalOperation(command);
  if (!parsed || !binding?.repo || !binding?.head || !binding?.paneId || !binding?.sessionId || binding?.caller !== "root" || !binding?.remoteName || !binding?.host) return undefined;
  if (parsed.operation === "push" && (parsed.remoteName !== binding.remoteName || parsed.branch !== binding.branch || binding.destinationRef !== parsed.destinationRef || parsed.sourceRef !== binding.head)) return undefined;
  if (parsed.operation !== "push" && binding.targetRepo?.toLowerCase() !== parsed.repo.toLowerCase()) return undefined;
  return { id: randomUUID(), digest: createHash("sha256").update(JSON.stringify({ argv: parsed.argv, binding, operation: parsed.operation })).digest("hex"), argv: parsed.argv, operation: parsed.operation, binding: { ...binding }, expiresAt: now + ttlMs, used: false };
}
export function consumeExternalApproval(token, command, binding, { now = Date.now() } = {}) {
  if (!token || token.used) return false;
  const parsed = parseApprovedExternalOperation(command); if (!parsed || token.expiresAt <= now) return false;
  if (parsed.operation === "push" && (parsed.remoteName !== binding.remoteName || parsed.branch !== binding.branch || binding.destinationRef !== parsed.destinationRef)) return false;
  if (parsed.operation !== "push" && binding.targetRepo?.toLowerCase() !== parsed.repo.toLowerCase()) return false;
  const digest = createHash("sha256").update(JSON.stringify({ argv: parsed.argv, binding, operation: parsed.operation })).digest("hex");
  const valid = digest === token.digest && JSON.stringify(parsed.argv) === JSON.stringify(token.argv) && JSON.stringify(binding) === JSON.stringify(token.binding);
  if (valid) token.used = true;
  return valid;
}
