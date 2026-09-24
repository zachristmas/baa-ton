/**
 * Known-safe command classifier for a lane's Bash permission prompts.
 *
 * The lane PermissionRequest hook (known-safe-hook.mjs) asks this module
 * whether a prompted Bash command can be approved without a person. An
 * approval covers the whole command, so the answer is "allow" only when EVERY
 * segment (split on ;, &&, ||, | and newlines, with heredoc bodies treated as
 * data) is inert or passes one of the rules below, and at least one rule
 * matched. Anything else is "defer": the prompt stays up and is routed to the
 * root as usual. The classifier never denies.
 *
 * Rules (ported from an operator's confirmation watcher):
 * - rm: every target is one of
 *   - a file the same command created (`git show HEAD:<path> > f`,
 *     `cat > f <<EOF`), removed with -f or no flags;
 *   - a variable bound once to `$(mktemp -d)`, removed with -rf;
 *   - a loop variable bound only by `for V in <session scratchpad glob>; do
 *     break; done`, never reassigned, removed with -rf;
 *   - one named file (no glob) inside a session scratchpad, removed with -f;
 *   - a relative directory the same command recreates with `mkdir -p`;
 *   - a `selftest-XXXXXXXX` directory (optionally under runtime/).
 *   `find . -maxdepth 1 -type d -name 'selftest-*' -exec rm -rf {} +` counts
 *   as the selftest rule. Any `..` anywhere in a target is unsafe.
 * - git on a feature branch: create one from origin/main, detach at
 *   origin/main, and (only with allowOwnBranchPush) push it. A main, master
 *   or HEAD target, a refspec, --force, -f and reset --hard are unsafe.
 * - gh pr merge: only with allowMergeByBranch, only by branch name, never by
 *   PR number (numbers collide between sessions working one repo).
 */

/** A path inside some Claude session scratchpad: <tmp>/claude-<uid>/<project>/<session>/scratchpad/... */
const SESSION_SCRATCHPAD = /^\/(?:private\/)?tmp\/claude-\d+\/[\w.-]+\/[\w.-]+\/scratchpad\/[\w.-][\w./-]*$/;
/** The same, with glob characters allowed in each component (for loop bindings). */
const SESSION_SCRATCHPAD_GLOB = /^\/(?:private\/)?tmp\/claude-\d+\/[\w.*?-]+\/[\w.*?-]+\/scratchpad\/[\w.*?-][\w./*?-]*$/;

/** Substitutions the rules themselves understand; any other `$(` or backtick defers. */
const KNOWN_SUBSTITUTIONS = [/\$\(mktemp -d(?: [\w./-]+)*\)/g, /\$\(gh auth token(?: --user [\w-]+)?\)/g];

/** Segments that are inert on their own: read-only, or confined to creating files. */
const INERT = [
  /^(pwd|ls|cat|head|tail|wc|grep|rg|echo|printf|true|false|test|date|which|stat|du|sort|uniq|cut|tr|diff|cmp|basename|dirname|realpath|jq)(\s|$)/,
  /^\[ .* \]$/,
  /^(mkdir -p|touch)(\s+"?[\w./$-]+"?)+$/,
  /^\w+="?SUBST"?$/,
  /^\w+="?[\w./:@-]*"?$/,
  /^git (status|log|diff|show|fetch|branch --show-current|rev-parse|ls-files|merge-base)(\s|$)/,
  /^(npm test|node --test|npx tsc|tsc)(\s|$)/,
  /^for \w+ in [^;]+$/,
  /^(do|done|then|fi|else|break|continue)$/,
  /^do (break|continue)$/,
];

const DEFAULT_BRANCH = /^(?!(?:main|master|HEAD)$)[A-Za-z0-9][\w./-]*$/;

/**
 * sed that only prints or substitutes: `sed [-n] [-E] '<script>' [files]`,
 * where the script is `Np`, `N,Mp` or `s` commands without the w or e flags.
 */
function sedInert(segment) {
  const match = /^sed((?: -[nE])*) '([^']*)'((?:\s+[\w./-]+)*)$/.exec(segment);
  if (!match) return false;
  return match[2].split(";").every((command) => {
    const part = command.trim();
    if (/^\d+(,\d+)?p$|^\$p$/.test(part)) return true;
    const substitute = /^s(.)/.exec(part);
    if (!substitute || /[\w\s\\]/.test(substitute[1])) return false;
    const pieces = part.slice(2).split(substitute[1]);
    return pieces.length === 3 && /^[gIp0-9]*$/.test(pieces[2]);
  });
}

/** Split a command into segments, treating heredoc bodies as data. */
export function commandSegments(command) {
  const lines = String(command).split("\n");
  const kept = [];
  const heredocTargets = [];
  let expandingBody = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    kept.push(line);
    const heredoc = /<<-?\s*(['"]?)(\w+)\1/.exec(line);
    if (!heredoc) continue;
    const quoted = heredoc[1] !== "";
    const delimiter = heredoc[2];
    while (index + 1 < lines.length && lines[index + 1].trim() !== delimiter) {
      index += 1;
      // An unquoted delimiter means the shell expands the body.
      if (!quoted && /`|\$\(/.test(lines[index])) expandingBody = true;
    }
    index += 1;
    const target = /\bcat\s*>\s*("?[\w./-]+"?)\s*<</.exec(line);
    if (target) heredocTargets.push(unquote(target[1]));
  }
  const body = kept.join("\n");
  const segments = body
    .split(/\s*(?:&&|\|\||;|\||\n)\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return { segments, heredocTargets, body, expandingBody };
}

function unquote(value) {
  return value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Count the ways `variable` is bound in `body` (assignment, read, for). */
function bindings(body, variable) {
  const pattern = new RegExp(`(?:^|[\\s;&|(])(?:export\\s+)?${variable}=|\\bread\\b[^\\n;&|]*\\b${variable}\\b|\\bfor ${variable} in `, "g");
  return [...body.matchAll(pattern)].length;
}

/** The mktemp -d variables and scratchpad loop variables the rm rule trusts. */
function trustedVariables(body) {
  const mktemp = new Set(
    [...body.matchAll(/(?:^|[\s;&|(])(\w+)="?\$\(mktemp -d\b/g)].map((match) => match[1]).filter((name) => bindings(body, name) === 1),
  );
  const loop = new Set(
    [...body.matchAll(/\bfor (\w+) in (\S+); do (?:break; done|rm -rf "\$\1"; done)/g)]
      .filter((match) => !match[2].includes("..") && SESSION_SCRATCHPAD_GLOB.test(match[2]))
      .map((match) => match[1])
      .filter((name) => bindings(body, name) === 1),
  );
  return { mktemp, loop };
}

function normalizeFlags(flagText) {
  const letters = new Set();
  for (const flag of flagText.trim().split(/\s+/).filter(Boolean)) {
    if (!/^-[rRf]+$/.test(flag)) return undefined;
    for (const letter of flag.slice(1)) letters.add(letter === "R" ? "r" : letter);
  }
  if (!letters.size) return "";
  if (letters.size === 1 && letters.has("f")) return "-f";
  if (letters.size === 2) return "-rf";
  return undefined; // -r alone prompts interactively on write-protected files; not a pattern the rules cover
}

function rmVerdict(segment, context) {
  if (/^find \. -maxdepth 1 -type d -name '?selftest-\*'? -exec rm -rf \{\} (\+|\\;)$/.test(segment)) return { safe: true, rule: "rm-selftest" };
  const match = /^rm((?:\s+-\S+)*)\s+(.+)$/.exec(segment);
  if (!match) return /^(rm|rmdir|unlink)(\s|$)/.test(segment) || /-exec\s+rm\b|-delete\b/.test(segment) ? { safe: false, reason: `unrecognized removal: ${segment}` } : undefined;
  const flags = normalizeFlags(match[1]);
  if (flags === undefined) return { safe: false, reason: `rm flags ${match[1].trim()}` };
  const { created, trusted } = context;
  let rule;
  for (const raw of match[2].split(/\s+/)) {
    const target = unquote(raw);
    if (target.includes("..")) return { safe: false, reason: `rm target ${target} contains ..` };
    const variable = /^\$\{?(\w+)\}?$/.exec(target)?.[1];
    if (flags === "-rf" && /^(runtime\/)?selftest-[A-Za-z0-9]{8}$/.test(target)) rule = "rm-selftest";
    else if (flags === "-rf" && variable && trusted.mktemp.has(variable)) rule = "rm-mktemp-dir";
    else if (flags === "-rf" && variable && trusted.loop.has(variable)) rule = "rm-scratchpad-loop";
    else if (flags === "-f" && SESSION_SCRATCHPAD.test(target)) rule = "rm-scratchpad-file";
    else if (
      flags === "-rf" &&
      /^(?![/~])[\w.-]+(\/[\w.-]+)*$/.test(target) &&
      new RegExp(`mkdir -p "?${escapeRegExp(target)}"?(\\s|$|&|;)`).test(context.body)
    )
      rule = "rm-recreated-dir";
    else if ((flags === "-f" || flags === "") && created.has(target)) rule = "rm-created-file";
    else return { safe: false, reason: `rm ${flags} ${target} is not a known-safe target` };
  }
  return { safe: true, rule };
}

function gitVerdict(segment, options) {
  if (!/^git\s/.test(segment)) return undefined;
  if (/\s(--force\S*|-f|-B|-C)(\s|$)|\breset --hard\b|\s\+\S/.test(segment)) return { safe: false, reason: "force, hard reset or forced ref update" };
  const branch = options.branchPattern ?? DEFAULT_BRANCH;
  const create = /^git (?:checkout|switch) (?:-q )?(?:-b|-c) (\S+) origin\/main$/.exec(segment);
  if (create) return branch.test(create[1]) ? { safe: true, rule: "git-create-branch" } : { safe: false, reason: `branch name ${create[1]}` };
  if (/^git (?:checkout|switch) (?:-q )?--detach origin\/main$/.test(segment)) return { safe: true, rule: "git-detach-origin-main" };
  const push = /^git push(?: -q)?(?: -u)? origin (\S+)$/.exec(segment);
  if (/^git push\b/.test(segment)) {
    if (!push) return { safe: false, reason: "git push must be `git push [-q] [-u] origin <branch>`" };
    if (!options.allowOwnBranchPush) return { safe: false, reason: "pushing is not enabled here" };
    const target = push[1];
    if (target.includes(":") || !branch.test(target) || (options.ownBranch && target !== options.ownBranch))
      return { safe: false, reason: `push target ${target}` };
    return { safe: true, rule: "git-push-own-branch" };
  }
  return undefined;
}

function ghVerdict(segment, options) {
  if (!/^(?:GH_TOKEN=\S+ )?gh pr merge\b/.test(segment)) return undefined;
  const merge = /^(?:GH_TOKEN=\S+ )?gh pr merge (\S+) (?:-R ([\w.-]+\/[\w.-]+) --merge|--merge -R ([\w.-]+\/[\w.-]+))$/.exec(segment);
  if (!merge) return { safe: false, reason: "merge must be `gh pr merge <branch> -R <owner/repo> --merge`" };
  if (/^#?\d+$/.test(merge[1]) || /\/pull\/\d+/.test(merge[1]))
    return { safe: false, reason: "merging by PR number is refused (numbers collide between sessions); merge by branch name" };
  if (!options.allowMergeByBranch) return { safe: false, reason: "merging is not enabled here" };
  if (options.mergeRepo && (merge[2] ?? merge[3]) !== options.mergeRepo) return { safe: false, reason: `repository ${merge[2] ?? merge[3]}` };
  if (!(options.branchPattern ?? DEFAULT_BRANCH).test(merge[1])) return { safe: false, reason: `branch name ${merge[1]}` };
  return { safe: true, rule: "gh-merge-by-branch" };
}

/**
 * Relative targets are only safe while the shell stays in the lane's
 * worktree: `cd` may go to a relative path without `..`, or to options.cwd
 * (the hook passes the session's working directory) or below it.
 */
function cdVerdict(segment, options) {
  const target = unquote(segment.replace(/^cd\s*/, "").trim());
  if (!target || target.includes("..") || /[$`*?~]/.test(target)) return { safe: false, reason: `cd ${target || "(home)"}` };
  if (!target.startsWith("/")) return undefined;
  const cwd = options.cwd?.replace(/\/+$/, "");
  if (cwd && (target === cwd || target.startsWith(`${cwd}/`))) return undefined;
  return { safe: false, reason: `cd ${target} leaves the working directory` };
}

/** Redirections must stay in the working tree, a session scratchpad or /dev/null. */
function redirectVerdict(segment) {
  for (const match of segment.matchAll(/(?:^|[^<\d&])\d?>>?\s*("?[^\s;&|]+"?)/g)) {
    const target = unquote(match[1]);
    if (target.startsWith("&")) continue;
    if (target === "/dev/null") continue;
    if (target.includes("..")) return { safe: false, reason: `redirect to ${target}` };
    if (/^[/~]/.test(target) && !SESSION_SCRATCHPAD.test(target)) return { safe: false, reason: `redirect to ${target}` };
  }
  return undefined;
}

function stripRedirects(segment) {
  return segment
    .replace(/\s+\d?>>?\s*&\d/g, "")
    .replace(/\s+\d?>>?\s*"?[^\s;&|"]+"?/g, "")
    .trim();
}

/**
 * Classify one Bash command. Options: cwd, branchPattern, ownBranch,
 * allowOwnBranchPush, allowMergeByBranch, mergeRepo.
 * Returns { decision: "allow", rules } or { decision: "defer", reason }.
 */
export function classifyCommand(command, options = {}) {
  if (typeof command !== "string" || !command.trim()) return { decision: "defer", reason: "empty command" };
  const { segments, heredocTargets, body, expandingBody } = commandSegments(command);
  if (expandingBody) return { decision: "defer", reason: "command substitution inside an unquoted heredoc" };
  let scrubbed = body;
  for (const pattern of KNOWN_SUBSTITUTIONS) scrubbed = scrubbed.replace(pattern, "SUBST");
  if (/`|\$\(|<\(|>\(/.test(scrubbed)) return { decision: "defer", reason: "command or process substitution" };
  const context = {
    body,
    created: new Set([
      ...heredocTargets,
      ...[...body.matchAll(/git show HEAD:\S+(?:\s*\|\s*sed\s+[^>\n]*?)?\s>\s*("?[\w./$-]+"?)/g)].map((match) => unquote(match[1])),
    ]),
    trusted: trustedVariables(body),
  };
  const rules = new Set();
  for (const segment of segments) {
    const redirect = redirectVerdict(segment);
    if (redirect) return { decision: "defer", reason: redirect.reason };
    let normalized = stripRedirects(segment);
    for (const pattern of KNOWN_SUBSTITUTIONS) normalized = normalized.replace(pattern, "SUBST");
    const plain = normalized.replace(/^(?:(?!GH_TOKEN=)\w+=[\w./:@-]*\s+)+(?=\S)/, "");
    const verdict = rmVerdict(plain, context) ?? gitVerdict(plain, options) ?? ghVerdict(plain, options);
    if (verdict) {
      if (!verdict.safe) return { decision: "defer", reason: verdict.reason };
      rules.add(verdict.rule);
      continue;
    }
    if (/^cd(\s|$)/.test(plain)) {
      const cd = cdVerdict(plain, options);
      if (cd) return { decision: "defer", reason: cd.reason };
      continue;
    }
    if (/\s--output\b|^sort\b.*\s-o/.test(plain)) return { decision: "defer", reason: `writes a file: ${segment.slice(0, 120)}` };
    if (/^git show HEAD:\S+$/.test(plain) || sedInert(plain) || /^cat\s*<<-?\s*['"]?\w+['"]?$/.test(plain) || INERT.some((pattern) => pattern.test(plain))) continue;
    return { decision: "defer", reason: `not a known-safe command: ${segment.slice(0, 120)}` };
  }
  return rules.size ? { decision: "allow", rules: [...rules] } : { decision: "defer", reason: "no known-safe rule applies" };
}
