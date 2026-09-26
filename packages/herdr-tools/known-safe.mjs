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
 *   - a relative directory the same command recreates with `mkdir` or `mkdir -p`;
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
  /^(mkdir(?: -p)?|touch)(\s+"?[\w./$-]+"?)+$/,
  // A copy whose destination is a relative path in the worktree.
  /^cp(?:\s+-[a-z]+)*\s+"?[^\s;&|"]+"?\s+"?[\w.][\w./-]*"?$/,
  /^(?:export )?\w+="?SUBST"?$/,
  /^(?:export )?\w+="?[\w./:@-]*"?$/,
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

const RELATIVE_FILE = /^(?![/~])[\w.][\w./-]*$/;

/**
 * Files the command itself creates (so removing them later in the same
 * command is safe): `cat > f <<EOF`, `git show HEAD:x > f`, a relative `>`
 * redirect, `touch f`, or the destination of `cp src dst`. Only relative
 * paths without `..` count; cd confinement keeps them in the worktree.
 */
function createdFiles(body, heredocTargets) {
  const found = [
    ...heredocTargets,
    ...[...body.matchAll(/git show HEAD:\S+(?:\s*\|\s*sed\s+[^>\n]*?)?\s>\s*("?[\w./$-]+"?)/g)].map((match) => unquote(match[1])),
    // `>`, `2>` and `&>` create (truncate) the file; `>>` appends and does not.
    ...[...body.matchAll(/(?<![>\w])(?:[12&])?>(?!>)\s*("?[\w.][\w./-]*"?)/g)].map((match) => unquote(match[1])),
    ...[...body.matchAll(/(?:^|[\s;&|(])touch((?:\s+"?[\w.][\w./-]*"?)+)/g)].flatMap((match) => match[1].trim().split(/\s+/).map(unquote)),
    ...[...body.matchAll(/(?:^|[\s;&|(])cp(?:\s+-\w+)*\s+\S+\s+("?[\w.][\w./-]*"?)(?=[\s;&|]|$)/g)].map((match) => unquote(match[1])),
  ];
  return new Set(found.filter((path) => path && !path.includes("..") && (RELATIVE_FILE.test(path) || path.startsWith("$"))));
}

/** `git diff [--] [files] > <session scratchpad>/x.patch` earlier in the command. */
function savedPatches(body) {
  return [...body.matchAll(/git diff(?: HEAD)?((?:\s+(?!>)[^\s;&|>]+)*)\s*>\s*"?(\/(?:private\/)?tmp\/claude-\d+\/[\w.-]+\/[\w.-]+\/scratchpad\/[\w./-]+\.(?:patch|diff))"?/g)]
    .filter((match) => !match[2].includes(".."))
    .map((match) => {
      const args = match[1].trim().split(/\s+/).filter(Boolean);
      const files = args.filter((arg) => arg !== "--" && !arg.startsWith("-")).map(unquote);
      return { all: files.length === 0, files };
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
  const segments = splitOutsideQuotes(body)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return { segments, heredocTargets, body, expandingBody };
}

/**
 * Split on ;, &&, ||, | and newlines, but not inside single or double
 * quotes: `grep -n "a; b" f` is one segment. A backslash escapes the next
 * character outside single quotes.
 */
export function splitOutsideQuotes(body) {
  const segments = [];
  let current = "";
  let quote;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quote) {
      current += char;
      if (char === "\\" && quote === '"' && index + 1 < body.length) current += body[++index];
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\\" && index + 1 < body.length) {
      current += char + body[++index];
      continue;
    }
    const two = body.slice(index, index + 2);
    if (two === "&&" || two === "||") {
      segments.push(current);
      current = "";
      index += 1;
      continue;
    }
    if (char === ";" || char === "|" || char === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

/**
 * Claude Code `ask` rules for Bash (`Bash(git push *)`, `Bash(rm:*)`) as
 * matchers for one command segment (after leading env assignments).
 */
export function askRuleMatchers(rules = []) {
  return rules
    .map((rule) => /^Bash\((.*)\)$/.exec(String(rule))?.[1])
    .filter((pattern) => typeof pattern === "string" && pattern.trim())
    .map((pattern) => {
      const prefix = pattern.endsWith(":*") ? pattern.slice(0, -2) : undefined;
      const source = (prefix ?? pattern)
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      return new RegExp(prefix !== undefined ? `^${source}(\\s|$)` : `^${source}$`, "s");
    });
}

function segmentMatchesAsk(segment, matchers) {
  const plain = segment.replace(/^(?:\w+=\S+\s+)+/, "").trim();
  return matchers.some((matcher) => matcher.test(plain) || matcher.test(segment.trim()));
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
  // A variable assigned exactly once to a session scratchpad (or a subfolder).
  const assigned = (name) => [...body.matchAll(new RegExp(`(?:^|[\\s;&|(])(?:export\\s+)?${name}=`, "g"))].length;
  const scratchAssignments = [...body.matchAll(/(?:^|[\s;&|(])(?:export\s+)?(\w+)="?(\/(?:private\/)?tmp\/claude-\d+\/[\w.-]+\/[\w.-]+\/scratchpad(?:\/[\w.-]+)*)"?(?=[\s;&|]|$)/g)]
    .filter((match) => !match[2].includes("..") && assigned(match[1]) === 1 && bindings(body, match[1]) === 1);
  const scratchRoots = new Set(scratchAssignments.filter((match) => /\/scratchpad$/.test(match[2])).map((match) => match[1]));
  const scratchSubs = new Set(scratchAssignments.filter((match) => !/\/scratchpad$/.test(match[2])).map((match) => match[1]));
  const mktemp = new Set(
    [...body.matchAll(/(?:^|[\s;&|(])(\w+)="?\$\(mktemp -d\b/g)].map((match) => match[1]).filter((name) => bindings(body, name) === 1),
  );
  const loop = new Set(
    [...body.matchAll(/\bfor (\w+) in (\S+); do (?:break; done|rm -rf "\$\1"; done)/g)]
      .filter((match) => !match[2].includes("..") && SESSION_SCRATCHPAD_GLOB.test(match[2]))
      .map((match) => match[1])
      .filter((name) => bindings(body, name) === 1),
  );
  return { mktemp, loop, scratchRoots, scratchSubs };
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
  // rmdir removes only empty folders.
  const rmdir = /^rmdir((?:\s+-[p]+)*)\s+(.+)$/.exec(segment);
  if (rmdir) return rmdir[2].split(/\s+/).some((target) => target.includes("..")) ? { safe: false, reason: "rmdir target contains .." } : { safe: true, rule: "rmdir-empty" };
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
    const underRoot = /^\$\{?(\w+)\}?\/([\w.-]+(?:\/[\w.-]+)*)$/.exec(target);
    if (flags === "-rf" && /^(runtime\/)?selftest-[A-Za-z0-9]{8}$/.test(target)) rule = "rm-selftest";
    else if (underRoot && trusted.scratchRoots.has(underRoot[1])) rule = "rm-under-scratchpad-variable";
    else if (flags === "-rf" && variable && trusted.scratchSubs.has(variable)) rule = "rm-scratchpad-subfolder-variable";
    else if (flags === "-f" && /^\/(?:private\/)?tmp\/[\w.-]+$/.test(target)) rule = "rm-tmp-file";
    else if (flags === "-rf" && variable && trusted.mktemp.has(variable)) rule = "rm-mktemp-dir";
    else if (flags === "-rf" && variable && trusted.loop.has(variable)) rule = "rm-scratchpad-loop";
    else if (flags === "-f" && SESSION_SCRATCHPAD.test(target)) rule = "rm-scratchpad-file";
    else if (
      flags === "-rf" &&
      /^(?![/~])[\w.-]+(\/[\w.-]+)*$/.test(target) &&
      new RegExp(`mkdir(?: -p)? "?${escapeRegExp(target)}"?(\\s|$|&|;)`).test(context.body)
    )
      rule = "rm-recreated-dir";
    else if ((flags === "-f" || flags === "") && created.has(target)) rule = "rm-created-file";
    else return { safe: false, reason: `rm ${flags} ${target} is not a known-safe target` };
  }
  return { safe: true, rule };
}

/** Build outputs a lane may put back to HEAD after a build rewrote them. */
const GENERATED_ARTIFACTS = [/(^|\/)openapi(-spec)?\.(json|ya?ml)$/, /\.generated\.[\w]+$/, /(^|\/)(__generated__|generated)\//, /\.gen\.[jt]sx?$/];

function gitVerdict(segment, options, context = {}) {
  if (!/^git\s/.test(segment)) return undefined;
  const branch = options.branchPattern ?? DEFAULT_BRANCH;
  // Recreate the lane's own branch at origin/main: only in a clean worktree,
  // and only when that branch does not exist yet or is already merged, so no
  // unmerged commit can be lost.
  const reset = /^git (?:checkout|switch) (?:-q )?(?:-B|-C) (\S+) origin\/main$/.exec(segment);
  if (reset) {
    if (!branch.test(reset[1])) return { safe: false, reason: `branch name ${reset[1]}` };
    if (options.worktreeClean !== true) return { safe: false, reason: "resetting a branch needs a clean worktree" };
    const state = options.branchStates?.[reset[1]];
    if (state !== "missing" && state !== "merged") return { safe: false, reason: `branch ${reset[1]} has commits not on origin/main` };
    return { safe: true, rule: "git-reset-own-branch" };
  }
  // Discard working-tree changes to named files, only when the same command
  // saved them to a patch in a session scratchpad first, or when every file
  // is a generated build artifact.
  const discard = /^git (?:checkout(?: HEAD)? --|restore(?: --source=HEAD)?(?: --worktree)?(?: --)?) ((?:"?[\w.][\w./-]*"?\s*)+)$/.exec(segment);
  if (discard) {
    const files = discard[1].trim().split(/\s+/).map(unquote);
    if (files.some((file) => file.includes("..") || file === "." || file.startsWith("/"))) return { safe: false, reason: "discard target escapes or covers the whole tree" };
    if (files.every((file) => GENERATED_ARTIFACTS.some((pattern) => pattern.test(file)))) return { safe: true, rule: "git-revert-generated-artifact" };
    const saved = context.savedPatches ?? [];
    if (files.every((file) => saved.some((patch) => patch.all || patch.files.includes(file)))) return { safe: true, rule: "git-discard-after-patch" };
    return { safe: false, reason: "discarding changes needs a patch of them saved to scratch first" };
  }
  if (/\s(--force\S*|-f|-B|-C)(\s|$)|\breset --hard\b|\s\+\S/.test(segment)) return { safe: false, reason: "force, hard reset or forced ref update" };
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
  const repoOk = (repo) => !options.mergeRepo || repo === options.mergeRepo;
  const ownBranch = (name) => (options.branchPattern ?? DEFAULT_BRANCH).test(name) && (!options.ownBranch || name === options.ownBranch);
  if (/^(?:GH_TOKEN=\S+ )?gh pr (create|view)\b/.test(segment)) {
    if (!options.allowMergeByBranch) return { safe: false, reason: "pull requests are not enabled here" };
    const create = /^(?:GH_TOKEN=\S+ )?gh pr create((?:\s+(?:-R [\w.-]+\/[\w.-]+|--head \S+|--base main|--title "[^"]*"|--body-file -))+)(?:\s+<<-?\s*['"]?\w+['"]?)?$/.exec(segment);
    if (create) {
      const repo = /-R ([\w.-]+\/[\w.-]+)/.exec(create[1])?.[1];
      const head = /--head (\S+)/.exec(create[1])?.[1];
      if (!repo || !head || !repoOk(repo) || !ownBranch(head)) return { safe: false, reason: "a PR may be created only for this worktree's own branch in its own repository" };
      return { safe: true, rule: "gh-pr-create-own-branch" };
    }
    const view = /^(?:GH_TOKEN=\S+ )?gh pr view (\S+) -R ([\w.-]+\/[\w.-]+)(?: --json [\w,]+(?: -q '[^'|]*')?)?$/.exec(segment);
    if (view && !/^#?\d+$/.test(view[1]) && ownBranch(view[1]) && repoOk(view[2])) return { safe: true, rule: "gh-pr-view-own-branch" };
    return { safe: false, reason: "gh pr create/view must name this worktree's own branch, never a number" };
  }
  if (!/^(?:GH_TOKEN=\S+ )?gh pr merge\b/.test(segment)) return undefined;
  const merge = /^(?:GH_TOKEN=\S+ )?gh pr merge (\S+) (?:-R ([\w.-]+\/[\w.-]+) --merge|--merge -R ([\w.-]+\/[\w.-]+))$/.exec(segment);
  if (!merge) return { safe: false, reason: "merge must be `gh pr merge <branch> -R <owner/repo> --merge`" };
  if (/^#?\d+$/.test(merge[1]) || /\/pull\/\d+/.test(merge[1]))
    return { safe: false, reason: "merging by PR number is refused (numbers collide between sessions); merge by branch name" };
  if (!options.allowMergeByBranch) return { safe: false, reason: "merging is not enabled here" };
  if (options.mergeRepo && (merge[2] ?? merge[3]) !== options.mergeRepo) return { safe: false, reason: `repository ${merge[2] ?? merge[3]}` };
  if (!ownBranch(merge[1])) return { safe: false, reason: `branch name ${merge[1]}` };
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
    created: createdFiles(body, heredocTargets),
    trusted: trustedVariables(body),
    savedPatches: savedPatches(body),
  };
  const rules = new Set();
  // Scoped to ask rules (bypassPermissions): only segments matching an ask
  // rule caused the prompt; the rest run without one in that mode anyway.
  const scoped = options.scopeToAskRules && Array.isArray(options.askRules) && options.askRules.length > 0;
  const matchers = scoped ? askRuleMatchers(options.askRules) : [];
  let asked = 0;
  for (const segment of segments) {
    if (scoped) {
      if (!segmentMatchesAsk(segment, matchers)) continue;
      asked += 1;
    }
    const redirect = redirectVerdict(segment);
    if (redirect) return { decision: "defer", reason: redirect.reason };
    let normalized = stripRedirects(segment);
    for (const pattern of KNOWN_SUBSTITUTIONS) normalized = normalized.replace(pattern, "SUBST");
    const plain = normalized.replace(/^(?:(?!GH_TOKEN=)\w+=[\w./:@-]*\s+)+(?=\S)/, "");
    const verdict = rmVerdict(plain, context) ?? gitVerdict(plain, options, context) ?? ghVerdict(plain, options);
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
  if (scoped && asked === 0) return { decision: "defer", reason: "no segment matches an ask rule; the prompt has another cause" };
  return rules.size || (scoped && asked > 0) ? { decision: "allow", rules: [...rules] } : { decision: "defer", reason: "no known-safe rule applies" };
}

/*
 * Local validation (the `local-validation` approval grant): a lane's frozen
 * install, build, codegen, typecheck, lint and tests in its own worktree,
 * including headed browser tests. Package and lockfile edits, publish,
 * deploy, release, production and migrations stay outside it, and so does
 * any environment assignment that could point a command at a shared
 * database or service.
 */
const VALIDATION_SCRIPT =
  /^(?:build|compile|codegen|generate|gen|typecheck|type-check|check-types|types|tsc|lint|format:check|prettier:check|check|test|unit|e2e|playwright|storybook:build|(?:build|codegen|generate|gen|typecheck|lint|test|unit|e2e|playwright):[\w:.-]+)$/;
const OUTSIDE_VALIDATION = /deploy|publish|release|prod|push|migrat|seed|reset|drop|upgrade|update|add|remove/i;
const SAFE_ENV = /^(?:CI|FORCE_COLOR|NO_COLOR|DEBUG|TZ|HEADED|PWDEBUG|TURBO_FORCE|NODE_OPTIONS)=[\w.:,=/@+-]*$|^NODE_ENV=(?:test|development)$/;

function scriptClass(name) {
  if (!VALIDATION_SCRIPT.test(name) || OUTSIDE_VALIDATION.test(name)) return undefined;
  const base = name.split(":")[0];
  if (/^(build|compile|storybook)/.test(base)) return "build";
  if (/^(codegen|generate|gen)$/.test(base)) return "codegen";
  if (/^(typecheck|type-check|check-types|types|tsc|check)$/.test(base)) return "typecheck";
  if (/^(lint|format|prettier)/.test(base)) return "lint";
  return "test";
}

/** Strip a package-manager workspace selector: returns the remaining words. */
function withoutWorkspaceSelector(manager, words) {
  const rest = [...words];
  while (rest.length) {
    if (manager === "pnpm" && /^(?:--filter|-F)$/.test(rest[0]) && rest[1] && !rest[1].startsWith("-")) rest.splice(0, 2);
    else if (manager === "pnpm" && /^(?:--filter=\S+|-r|--recursive|--parallel|--stream|--if-present|-w|--workspace-root)$/.test(rest[0])) rest.shift();
    else if (manager === "npm" && /^(?:--workspace|-w)$/.test(rest[0]) && rest[1]) rest.splice(0, 2);
    else if (manager === "npm" && /^(?:--workspace=\S+|--workspaces|-ws|--if-present)$/.test(rest[0])) rest.shift();
    else if (manager === "yarn" && rest[0] === "workspace" && rest[1]) rest.splice(0, 2);
    else if (manager === "yarn" && rest[0] === "workspaces" && rest[1] === "foreach") rest.splice(0, 2);
    else break;
  }
  return rest;
}

const DIRECT_TOOLS = [
  [/^tsc(\s|$)/, "typecheck"],
  [/^vue-tsc(\s|$)/, "typecheck"],
  [/^eslint(\s|$)/, "lint"],
  [/^prettier (?:--check|-c)(\s|$)/, "lint"],
  [/^biome (?:check|lint|ci)(\s|$)/, "lint"],
  [/^vitest(?: run)?(\s|$)/, "test"],
  [/^jest(\s|$)/, "test"],
  [/^playwright test(\s|$)/, "e2e"],
  [/^node --test(\s|$)/, "test"],
  [/^turbo run \S/, "turbo"],
  [/^turbo (?:build|test|lint|typecheck)(\s|$)/, "turbo"],
  [/^next (?:build|lint)(\s|$)/, "build"],
  [/^vite build(\s|$)/, "build"],
  [/^graphql-codegen(\s|$)/, "codegen"],
  [/^prisma generate(\s|$)/, "codegen"],
];

function validationSegment(segment, leasedPorts = []) {
  let words = segment.split(/\s+/);
  while (words.length && /^\w+=/.test(words[0])) {
    const port = /^PORT=(\d+)$/.exec(words[0]);
    if (port && !leasedPorts.includes(Number(port[1]))) return { reason: `PORT=${port[1]} is not one of this lane's leased ports` };
    if (!port && !SAFE_ENV.test(words[0])) return { reason: `environment assignment ${words[0].split("=")[0]}` };
    words.shift();
  }
  if (!words.length) return undefined;
  const [first] = words;
  let rest = words.slice(1);
  let manager;
  if (/^(npm|pnpm|yarn|bun)$/.test(first)) manager = first;
  else if (first === "npx" || first === "bunx") return directTool(rest.filter((word) => word !== "--no-install").join(" "));
  else return directTool(words.join(" "));
  rest = withoutWorkspaceSelector(manager, rest);
  const [command, ...args] = rest;
  if (!command) return { reason: `${manager} with no command` };
  // Frozen installs: never a package argument, never a lockfile rewrite.
  if ((manager === "npm" && command === "ci") ||
      (/^(install|i)$/.test(command) && manager !== "npm")) {
    const frozen = args.some((arg) => /^--(?:frozen-lockfile|immutable)$/.test(arg)) || (manager === "npm" && command === "ci");
    if (!frozen) return { reason: `${manager} ${command} without --frozen-lockfile` };
    if (args.some((arg) => !arg.startsWith("-") || /^--(?:no-frozen-lockfile|fix-lockfile|lockfile-only|force)$/.test(arg)))
      return { reason: `${manager} ${command} ${args.join(" ")}: package arguments or lockfile rewrites` };
    return { validation: "install" };
  }
  if (manager === "pnpm" && command === "exec") return directTool(args.join(" "));
  if (command === "turbo") return directTool(rest.join(" ")) ?? { reason: `${manager} turbo ${args.join(" ")}` };
  if (manager === "yarn" && /^(tsc|eslint|vitest|jest|playwright|turbo)$/.test(command)) return directTool(rest.join(" "));
  const script = command === "run" || command === "run-script" ? args[0] : command === "t" ? "test" : command;
  if (!script) return { reason: `${manager} run with no script` };
  const kind = scriptClass(script);
  if (!kind) return { reason: `${manager} ${script} is not a validation script` };
  const extra = command === "run" || command === "run-script" ? args.slice(1) : args;
  if (manager === "pnpm" && extra[0] === "turbo") return directTool(extra.join(" "));
  return { validation: kind };
}

function directTool(text) {
  if (/^turbo /.test(text)) {
    const tasks = text.replace(/^turbo (?:run )?/, "").split(/\s+/).filter((word) => !word.startsWith("-") && !word.includes("="));
    const kinds = tasks.map(scriptClass);
    if (!tasks.length || kinds.some((kind) => !kind)) return { reason: `turbo ${tasks.join(" ")} includes a task outside validation` };
    return { validation: kinds[0] };
  }
  for (const [pattern, kind] of DIRECT_TOOLS) if (pattern.test(text)) return { validation: kind };
  return undefined;
}

/**
 * Classify one command against the local-validation grant.
 * Options: cwd (the lane's worktree), leasedPorts (ports a PORT= assignment may use).
 * Returns { matched: true, classes } or { matched: false, reason }.
 */
export function classifyLocalValidation(command, options = {}) {
  if (typeof command !== "string" || !command.trim()) return { matched: false, reason: "empty command" };
  const { segments, expandingBody } = commandSegments(command);
  if (expandingBody || /`|\$\(|<\(|>\(/.test(command)) return { matched: false, reason: "command or process substitution" };
  const classes = new Set();
  for (const segment of segments) {
    const redirect = redirectVerdict(segment);
    if (redirect) return { matched: false, reason: redirect.reason };
    const plain = stripRedirects(segment);
    if (/^cd(\s|$)/.test(plain)) {
      const cd = cdVerdict(plain, options);
      if (cd) return { matched: false, reason: cd.reason };
      continue;
    }
    const verdict = validationSegment(plain, options.leasedPorts);
    if (verdict?.validation) {
      classes.add(verdict.validation);
      continue;
    }
    if (verdict?.reason) return { matched: false, reason: verdict.reason };
    if (/\s--output\b|^sort\b.*\s-o/.test(plain)) return { matched: false, reason: `writes a file: ${segment.slice(0, 120)}` };
    if (INERT.some((pattern) => pattern.test(plain)) || sedInert(plain)) continue;
    return { matched: false, reason: `not a local validation command: ${segment.slice(0, 120)}` };
  }
  return classes.size ? { matched: true, classes: [...classes] } : { matched: false, reason: "no validation command" };
}

/*
 * The unattended default for a lane's routed permission prompt that nobody
 * answered: allow what stays inside the lane (its worktree, a session
 * scratchpad, /tmp) and uses no network, credentials, publishing or system
 * commands; deny the rest with a reason the lane can act on.
 */
const OUTSIDE_COMMANDS = /(^|[\s;&|(])(sudo|su|curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet|ftp|docker|podman|kubectl|helm|terraform|aws|gcloud|az|psql|mysql|mongosh|redis-cli|launchctl|crontab|osascript|open|shutdown|reboot|chown|security|gh)(\s|$)/;
const OUTSIDE_SUBCOMMANDS = /\bgit\s+(push|remote|config\s+--global|credential)\b|\b(npm|pnpm|yarn|bun)\s+(publish|login|adduser|dist-tag|deprecate|unpublish)\b|\bgit\s+.*--global\b/;

function pathInside(path, cwd) {
  const roots = [cwd, "/tmp", "/private/tmp", "/dev/null", "/dev/stdout", "/dev/stderr"].filter(Boolean).map((root) => root.replace(/\/+$/, ""));
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

export function laneConfinedVerdict(toolName, toolInput, { cwd } = {}) {
  if (toolName === "Bash") {
    const command = String(toolInput?.command ?? "");
    if (!command.trim()) return { allow: false, reason: "empty command" };
    const outside = OUTSIDE_COMMANDS.exec(command) ?? OUTSIDE_SUBCOMMANDS.exec(command);
    if (outside) return { allow: false, reason: `\`${outside[0].trim()}\` reaches outside the lane (network, credentials, publishing or the system)` };
    if (/(^|[\s"'=:])(~|\$HOME)(\/|\s|$)/.test(command)) return { allow: false, reason: "it touches the home directory" };
    if (/(^|[\s"'=/])\.\.(\/|\s|$)/.test(command)) return { allow: false, reason: "it uses a .. path out of the worktree" };
    const absolute = [...command.matchAll(/(?:^|[\s"'=:>])(\/[\w.@+-][^\s"';&|)]*)/g)].map((match) => match[1]);
    const escaped = absolute.find((path) => !pathInside(path, cwd) && !/^\/(usr|bin|sbin|opt|System|Library|Applications)\//.test(path));
    if (escaped) return { allow: false, reason: `${escaped} is outside the lane's worktree and scratch` };
    const writesSystem = absolute.find((path) => /^\/(usr|bin|sbin|opt|System|Library|Applications)\//.test(path) && new RegExp(`(>|\\b(rm|mv|cp|chmod|tee|ln|install)\\b[^;&|]*)\\s*${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(command));
    if (writesSystem) return { allow: false, reason: `it writes to the system path ${writesSystem}` };
    return { allow: true, reason: "the command stays inside the lane's worktree and scratch" };
  }
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(toolName)) {
    const path = String(toolInput?.file_path ?? toolInput?.notebook_path ?? "");
    if (path && pathInside(path, cwd) && !path.split("/").includes("..")) return { allow: true, reason: "the edit is inside the lane's worktree or scratch" };
    return { allow: false, reason: `${path || "the file"} is outside the lane's worktree and scratch` };
  }
  return { allow: false, reason: `${toolName} is not covered by the unattended policy` };
}
