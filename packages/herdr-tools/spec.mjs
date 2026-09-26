/**
 * Spec loop, part 1: the spec file, its item state and the verifier
 * (docs/SPEC-LOOP.md sections 1, 3 and 9).
 *
 * `.baa-ton/spec.json` is the single source of truth for what "done" means.
 * Item state lives in a side file, `.baa-ton/herdr-orchestrator/spec-state.json`,
 * not in the manifest (older manifest writers drop unknown top-level keys).
 * The verifier is deterministic and uses no LLM: an item is done only when
 * every check passes, and it is the only thing that can say so.
 */
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const SPEC_PATH = ".baa-ton/spec.json";
export const SPEC_STATE_PATH = ".baa-ton/herdr-orchestrator/spec-state.json";
export const STAGES = ["decide", "build", "review", "integrate", "verify"];
export const ITEM_STATES = [
  "pending",
  "deciding",
  "ready",
  "building",
  "reviewing",
  "integrating",
  "awaiting-push",
  "verifying",
  "done",
  "blocked",
  "failed",
  // Out of scope for now (acceptance says deferred, no owned files): not counted in M.
  "deferred",
  // Settled by a decision, no code (the user resolved it, or it was verified
  // absent): counted as done by decision.
  "resolved",
];
// human-gate: push, deploy, production, scope; exhausted: every retry of a stage failed.
const BLOCK_REASONS = ["decision", "dependency", "capacity", "human-gate", "exhausted"];
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value, allowed, label) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`${label} has unsupported keys: ${extra.join(", ")}.`);
}

function text(value, label, { max = 2000, optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label} must be a non-empty string of at most ${max} characters.`);
  return value;
}

function strings(value, label, { optional = true, pattern } = {}) {
  if (value === undefined && optional) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim() || (pattern && !pattern.test(item))))
    throw new Error(`${label} must be an array of non-empty strings.`);
  return [...value];
}

function relativePath(value, label) {
  text(value, label, { max: 500 });
  if (isAbsolute(value) || normalize(value).split(/[\\/]/).includes(".."))
    throw new Error(`${label} must be a path inside the target repository.`);
  return value;
}

function positiveInteger(value, label, { max = 1000, optional = true, min = 1 } = {}) {
  if (value === undefined && optional) return undefined;
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}

/** Validate a spec document strictly; throws with the first problem. */
/**
 * Build outputs every build regenerates (a stale committed baseline shows as
 * a modified file in each worktree). Put back to HEAD, when the item does not
 * own them, before the uncommitted-outside-owns check.
 */
export const DEFAULT_GENERATED_ARTIFACTS = ["**/openapi-spec.json", "packages/shared/api-clients/src/api/**"];

export function validateSpec(input) {
  if (!isRecord(input)) throw new Error("spec must be a JSON object.");
  onlyKeys(input, ["version", "target", "defaults", "stages", "items"], "spec");
  if (input.version !== 1) throw new Error("spec.version must be 1.");
  if (!isRecord(input.target)) throw new Error("spec.target must be an object.");
  onlyKeys(input.target, ["repo", "remote", "branch", "preview", "suite"], "spec.target");
  const target = {
    repo: text(input.target.repo, "spec.target.repo", { max: 500 }),
    remote: text(input.target.remote, "spec.target.remote", { max: 100 }),
    branch: text(input.target.branch, "spec.target.branch", { max: 200 }),
  };
  if (!/^[\w.-]+$/.test(target.remote)) throw new Error("spec.target.remote must be a remote name.");
  // The full suite the integration stage runs after each merge.
  target.suite = strings(input.target.suite, "spec.target.suite") ?? [];
  if (!/^[\w./-]+$/.test(target.branch) || target.branch.includes("..")) throw new Error("spec.target.branch must be a branch name.");
  if (input.target.preview !== undefined) {
    if (!isRecord(input.target.preview)) throw new Error("spec.target.preview must be an object.");
    onlyKeys(input.target.preview, ["url", "releaseCheck"], "spec.target.preview");
    target.preview = {
      url: text(input.target.preview.url, "spec.target.preview.url", { max: 500 }),
      ...(input.target.preview.releaseCheck !== undefined
        ? { releaseCheck: text(input.target.preview.releaseCheck, "spec.target.preview.releaseCheck", { max: 500 }) }
        : {}),
    };
  }
  const defaults = { maxParallel: 4, maxBuildAttempts: 3, pushGate: "round", finalReport: "alongside", generatedArtifacts: [...DEFAULT_GENERATED_ARTIFACTS] };
  // Optional live capacity floor the driver samples before dispatching.
  if (input.defaults !== undefined) {
    if (!isRecord(input.defaults)) throw new Error("spec.defaults must be an object.");
    onlyKeys(input.defaults, ["maxParallel", "maxBuildAttempts", "pushGate", "finalReport", "minFreeMemoryGb", "maxSwapUsedGb", "generatedArtifacts", "fixBaseline", "maxDeclines"], "spec.defaults");
    if (input.defaults.maxDeclines !== undefined) defaults.maxDeclines = positiveInteger(input.defaults.maxDeclines, "spec.defaults.maxDeclines", { max: 10 });
    if (input.defaults.fixBaseline !== undefined) {
      if (typeof input.defaults.fixBaseline !== "boolean") throw new Error("spec.defaults.fixBaseline must be true or false.");
      if (input.defaults.fixBaseline) defaults.fixBaseline = true;
    }
    if (input.defaults.generatedArtifacts !== undefined) {
      const globs = input.defaults.generatedArtifacts;
      if (!Array.isArray(globs) || globs.some((glob) => typeof glob !== "string" || !glob.trim() || glob.startsWith("/") || glob.split("/").includes("..")))
        throw new Error("spec.defaults.generatedArtifacts must be a list of repository-relative globs.");
      defaults.generatedArtifacts = globs.map((glob) => glob.trim());
    }
    for (const key of ["minFreeMemoryGb", "maxSwapUsedGb"])
      if (input.defaults[key] !== undefined) {
        if (typeof input.defaults[key] !== "number" || !(input.defaults[key] >= 0) || input.defaults[key] > 4096)
          throw new Error(`spec.defaults.${key} must be a number of GB.`);
        defaults[key] = input.defaults[key];
      }
    if (input.defaults.finalReport !== undefined) {
      if (!["alongside", "replace"].includes(input.defaults.finalReport))
        throw new Error('spec.defaults.finalReport must be "alongside" (keep the build lane\'s report and add a .final one) or "replace".');
      defaults.finalReport = input.defaults.finalReport;
    }
    if (input.defaults.pushGate !== undefined) {
      if (!["round", "item"].includes(input.defaults.pushGate))
        throw new Error('spec.defaults.pushGate must be "round" (one push prompt per integration round) or "item".');
      defaults.pushGate = input.defaults.pushGate;
    }
    defaults.maxParallel = positiveInteger(input.defaults.maxParallel, "spec.defaults.maxParallel", { max: 32 }) ?? defaults.maxParallel;
    defaults.maxBuildAttempts = positiveInteger(input.defaults.maxBuildAttempts, "spec.defaults.maxBuildAttempts", { max: 20 }) ?? defaults.maxBuildAttempts;
  }
  const stages = {};
  if (input.stages !== undefined) {
    if (!isRecord(input.stages)) throw new Error("spec.stages must be an object.");
    onlyKeys(input.stages, STAGES, "spec.stages");
    for (const [name, stage] of Object.entries(input.stages)) {
      if (!isRecord(stage)) throw new Error(`spec.stages.${name} must be an object.`);
      onlyKeys(stage, ["profile", "differentFrom", "fallbackProfiles"], `spec.stages.${name}`);
      stages[name] = { profile: text(stage.profile, `spec.stages.${name}.profile`, { max: 100 }) };
      if (stage.fallbackProfiles !== undefined) {
        if (!Array.isArray(stage.fallbackProfiles) || stage.fallbackProfiles.length > 5)
          throw new Error(`spec.stages.${name}.fallbackProfiles must be a list of up to 5 profile names.`);
        stages[name].fallbackProfiles = stage.fallbackProfiles.map((profile, index) => text(profile, `spec.stages.${name}.fallbackProfiles[${index}]`, { max: 100 }));
      }
      if (stage.differentFrom !== undefined) {
        if (!STAGES.includes(stage.differentFrom) || stage.differentFrom === name)
          throw new Error(`spec.stages.${name}.differentFrom must name another stage.`);
        stages[name].differentFrom = stage.differentFrom;
      }
    }
  }
  if (!Array.isArray(input.items) || !input.items.length) throw new Error("spec.items must be a non-empty array.");
  const ids = new Set();
  const items = input.items.map((item, index) => {
    const label = `spec.items[${index}]`;
    if (!isRecord(item)) throw new Error(`${label} must be an object.`);
    onlyKeys(item, ["id", "title", "dependsOn", "owns", "sharedTouch", "migrations", "decisions", "acceptance", "adopt"], label);
    if (typeof item.id !== "string" || !ITEM_ID.test(item.id)) throw new Error(`${label}.id must be a short identifier.`);
    if (ids.has(item.id)) throw new Error(`${label}.id ${item.id} is duplicated.`);
    ids.add(item.id);
    if (!isRecord(item.acceptance)) throw new Error(`${label}.acceptance must be an object.`);
    onlyKeys(item.acceptance, ["text", "tests", "preview", "evidence"], `${label}.acceptance`);
    const acceptance = {
      text: text(item.acceptance.text, `${label}.acceptance.text`, { max: 4000 }),
      tests: strings(item.acceptance.tests, `${label}.acceptance.tests`) ?? [],
      preview: (strings(item.acceptance.preview, `${label}.acceptance.preview`) ?? []).map((path, i) =>
        relativePath(path, `${label}.acceptance.preview[${i}]`),
      ),
    };
    if (item.acceptance.evidence !== undefined) {
      const evidence = item.acceptance.evidence;
      if (!isRecord(evidence)) throw new Error(`${label}.acceptance.evidence must be an object.`);
      onlyKeys(evidence, ["report", "minImages"], `${label}.acceptance.evidence`);
      acceptance.evidence = {
        report: relativePath(evidence.report, `${label}.acceptance.evidence.report`),
        minImages: positiveInteger(evidence.minImages, `${label}.acceptance.evidence.minImages`, { min: 0 }) ?? 0,
      };
    }
    let adopt;
    if (item.adopt !== undefined) {
      // Existing work in a live run (see spec-adopt.mjs). Paths are absolute:
      // lanes kept worktrees and reports outside the target repository.
      if (!isRecord(item.adopt)) throw new Error(`${label}.adopt must be an object.`);
      onlyKeys(item.adopt, ["worktree", "branch", "report", "workflow", "review", "accepted", "resolved"], `${label}.adopt`);
      adopt = {};
      for (const key of ["worktree", "report"])
        if (item.adopt[key] !== undefined) {
          text(item.adopt[key], `${label}.adopt.${key}`, { max: 1000 });
          if (!isAbsolute(item.adopt[key]) || item.adopt[key].split(/[\\/]/).includes(".."))
            throw new Error(`${label}.adopt.${key} must be an absolute path.`);
          adopt[key] = item.adopt[key];
        }
      if (item.adopt.branch !== undefined) {
        text(item.adopt.branch, `${label}.adopt.branch`, { max: 200 });
        if (!/^[\w./-]+$/.test(item.adopt.branch) || item.adopt.branch.includes("..") || ["main", "master", "HEAD"].includes(item.adopt.branch))
          throw new Error(`${label}.adopt.branch must be a feature branch name.`);
        adopt.branch = item.adopt.branch;
      }
      for (const key of ["workflow", "review"])
        if (item.adopt[key] !== undefined) {
          if (typeof item.adopt[key] !== "string" || !/^[\w.-]{1,80}$/.test(item.adopt[key]))
            throw new Error(`${label}.adopt.${key} must be a workflow id.`);
          adopt[key] = item.adopt[key];
        }
      if (item.adopt.accepted !== undefined) {
        if (typeof item.adopt.accepted !== "boolean") throw new Error(`${label}.adopt.accepted must be true or false.`);
        adopt.accepted = item.adopt.accepted;
      }
      if (item.adopt.resolved !== undefined) adopt.resolved = text(item.adopt.resolved, `${label}.adopt.resolved`, { max: 500 });
      if (adopt.worktree && !adopt.branch) throw new Error(`${label}.adopt.worktree needs adopt.branch.`);
    }
    return {
      ...(adopt ? { adopt } : {}),
      id: item.id,
      title: text(item.title, `${label}.title`, { max: 300 }),
      dependsOn: strings(item.dependsOn, `${label}.dependsOn`) ?? [],
      owns: strings(item.owns, `${label}.owns`) ?? [],
      sharedTouch: strings(item.sharedTouch, `${label}.sharedTouch`) ?? [],
      migrations: positiveInteger(item.migrations, `${label}.migrations`, { min: 0, max: 50 }) ?? 0,
      decisions: strings(item.decisions, `${label}.decisions`) ?? [],
      acceptance,
    };
  });
  for (const item of items)
    for (const dependency of item.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Item ${item.id} depends on unknown item ${dependency}.`);
      if (dependency === item.id) throw new Error(`Item ${item.id} depends on itself.`);
    }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(items.map((item) => [item.id, item]));
  const visit = (id, path) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Items have a dependency cycle: ${[...path, id].join(" -> ")}.`);
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of items) visit(item.id, []);
  return { version: 1, target, defaults, stages, items };
}

/** The spec's target repository as an absolute path (`~` expands). */
export function targetRepo(spec, cwd) {
  const repo = spec.target.repo;
  if (repo === "~" || repo.startsWith("~/")) return join(homedir(), repo.slice(2));
  return resolve(cwd, repo);
}

/**
 * Item state (`spec-state.json`), written by later stages:
 *   { version: 1, items: { <id>: {
 *       state, blockedReason?, attempts?, lane?: { workflowId, laneId }, since?,
 *       integratedSha?,
 *       evidence?: { report, sha256, images, sha },
 *       tests?: [{ command, sha, result: "pass" | "fail", at }],
 *       preview?: [{ spec, sha, releaseSha, result, at }],
 *       history?: [...] } } }
 */
export function validateSpecState(input) {
  if (input === undefined) return { version: 1, items: {} };
  if (!isRecord(input) || input.version !== 1 || !isRecord(input.items))
    throw new Error("spec-state.json must be { version: 1, items: {...} }.");
  for (const [id, item] of Object.entries(input.items)) {
    if (!isRecord(item)) throw new Error(`spec-state item ${id} must be an object.`);
    if (item.state !== undefined && !ITEM_STATES.includes(item.state)) throw new Error(`spec-state item ${id} has unknown state ${item.state}.`);
    if (item.state === "blocked" && !BLOCK_REASONS.includes(item.blockedReason))
      throw new Error(`spec-state item ${id} is blocked without a reason (${BLOCK_REASONS.join(", ")}).`);
  }
  return input;
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`${path}: ${error.message}`);
  }
}

export async function loadSpec(cwd) {
  const raw = await readJsonIfPresent(join(cwd, SPEC_PATH));
  if (raw === undefined) return undefined;
  return validateSpec(raw);
}

export async function loadSpecState(cwd) {
  return validateSpecState(await readJsonIfPresent(join(cwd, SPEC_STATE_PATH)));
}

/** Count `word/media/` entries in a .docx (zip) from its central directory. */
export function docxImageCount(buffer) {
  const minimum = 22;
  if (buffer.length < minimum) return undefined;
  let end = -1;
  for (let at = buffer.length - minimum; at >= Math.max(0, buffer.length - minimum - 65_535); at -= 1)
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  if (end < 0) return undefined;
  const entries = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  let images = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) return undefined;
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (/^word\/media\/[^/]+\.(png|jpe?g|gif|bmp|tiff?|webp|emf|wmf|svg)$/i.test(name)) images += 1;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return images;
}

/** Images in a report: a .docx by its media entries; Markdown/HTML by references. */
export function reportImageCount(path, buffer) {
  if (/\.docx$/i.test(path)) return docxImageCount(buffer);
  const body = buffer.toString("utf8");
  return (body.match(/!\[[^\]]*\]\([^)]+\)/g)?.length ?? 0) + (body.match(/<img\b/gi)?.length ?? 0);
}

export async function gitAncestor(repo, ancestor, descendant) {
  try {
    await execFile("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant], { timeout: 20_000 });
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw new Error(`git merge-base failed: ${String(error.stderr || error.message).trim().slice(0, 200)}`);
  }
}

/**
 * Check one item. Returns { done, checks: [{ name, ok, detail }], failing? }
 * with the checks in order; `failing` is the first that did not pass.
 */
export async function verifyItem(spec, state, item, { repo, ancestor = gitAncestor } = {}) {
  const record = state.items?.[item.id] ?? {};
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });
  const evidence = item.acceptance.evidence;
  if (evidence) {
    let buffer;
    // The verify stage records where it wrote the final report; before that
    // the report is looked up in the target repository.
    const reportPath = typeof record.evidence?.path === "string" ? record.evidence.path : join(repo, evidence.report);
    try {
      buffer = await readFile(reportPath);
    } catch {
      buffer = undefined;
    }
    if (!buffer) check("evidence", false, `report ${evidence.report} is missing`);
    else {
      const images = reportImageCount(evidence.report, buffer);
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      if (images === undefined) check("evidence", false, `report ${evidence.report} is not a readable .docx`);
      else if (images < evidence.minImages) check("evidence", false, `report has ${images} of ${evidence.minImages} images`);
      else if (!record.evidence?.sha256) check("evidence", false, "report hash is not recorded");
      else if (record.evidence.sha256 !== sha256) check("evidence", false, "report changed since it was recorded");
      else check("evidence", true, `${images} images, hash matches`);
    }
  }
  const targetRef = `${spec.target.remote}/${spec.target.branch}`;
  let integrated = false;
  if (!record.integratedSha) check("integrated", false, "no integrated commit recorded");
  else {
    try {
      integrated = await ancestor(repo, record.integratedSha, `refs/remotes/${targetRef}`);
      check("integrated", integrated, integrated ? `${record.integratedSha.slice(0, 12)} is on ${targetRef}` : `${record.integratedSha.slice(0, 12)} is not on ${targetRef}`);
    } catch (error) {
      check("integrated", false, error.message);
    }
  }
  for (const command of item.acceptance.tests) {
    const runs = (Array.isArray(record.tests) ? record.tests : []).filter((run) => run.command === command && run.sha === record.integratedSha);
    const last = runs.at(-1);
    check(
      `test: ${command}`,
      last?.result === "pass",
      !record.integratedSha ? "waits for the integrated commit" : last ? `${last.result} at ${String(last.sha).slice(0, 12)}` : "not recorded at the integrated commit",
    );
  }
  for (const previewSpec of item.acceptance.preview) {
    const runs = (Array.isArray(record.preview) ? record.preview : []).filter((run) => run.spec === previewSpec && run.result === "pass");
    let passed;
    for (const run of runs) {
      if (!record.integratedSha || typeof run.releaseSha !== "string") continue;
      try {
        if (run.releaseSha === record.integratedSha || (await ancestor(repo, record.integratedSha, run.releaseSha))) passed = run;
      } catch {
        // an unknown release SHA cannot prove anything
      }
    }
    check(
      `preview: ${previewSpec}`,
      Boolean(passed),
      passed ? `passed on release ${passed.releaseSha.slice(0, 12)}` : "no pass recorded on a release containing the integrated commit",
    );
  }
  const failing = checks.find((item) => !item.ok);
  return { id: item.id, done: !failing, checks, ...(failing ? { failing } : {}) };
}

/** Verify every item; the loop's exit condition and the burn-down. */
export async function verifySpec(spec, state, options = {}) {
  const results = [];
  for (const item of spec.items) {
    const record = state.items?.[item.id];
    if (record?.state === "deferred") results.push({ id: item.id, done: false, deferred: true, checks: [] });
    else if (record?.state === "resolved")
      results.push({ id: item.id, done: true, resolved: true, checks: [{ name: "resolved", ok: true, detail: `by decision: ${record.resolution?.reason ?? "recorded"}` }] });
    else results.push(await verifyItem(spec, state, item, options));
  }
  const counted = results.filter((result) => !result.deferred);
  return {
    done: counted.filter((result) => result.done).length,
    byDecision: counted.filter((result) => result.resolved).length,
    total: counted.length,
    deferred: results.length - counted.length,
    results,
  };
}

export function finalReportPath(spec, report) {
  if (spec.defaults.finalReport === "replace") return report;
  const dot = report.lastIndexOf(".");
  return dot > report.lastIndexOf("/") ? `${report.slice(0, dot)}.final${report.slice(dot)}` : `${report}.final`;
}

/** The deployed commit from a release check: a JSON field (sha, commit,
 * gitSha, revision, version, and nested under build/git/release) or the
 * first full or abbreviated SHA in a text body. */
export function releaseShaFrom(body) {
  const hex = /^[0-9a-f]{7,40}$/i;
  try {
    const value = JSON.parse(body);
    const queue = [value];
    while (queue.length) {
      const current = queue.shift();
      if (!isRecord(current)) continue;
      for (const key of ["sha", "commit", "commitSha", "gitSha", "git_sha", "revision", "version"])
        if (typeof current[key] === "string" && hex.test(current[key].trim())) return current[key].trim().toLowerCase();
      for (const key of ["build", "git", "release", "deployment", "data"]) if (isRecord(current[key])) queue.push(current[key]);
    }
    return undefined;
  } catch {
    return /\b([0-9a-f]{40}|[0-9a-f]{7,12})\b/i.exec(String(body))?.[1]?.toLowerCase();
  }
}

/** Item stage for display: done only when the verifier says so. */
export function itemStage(state, id, verified) {
  if (verified?.resolved) return "resolved";
  if (verified?.done) return "done";
  const recorded = state.items?.[id]?.state ?? "pending";
  return recorded === "done" ? "verifying" : recorded;
}

/** The verifier line every digest starts with, e.g.
 * `spec 11/29 done · 4 building · 2 reviewing · 3 blocked(decision)`. */
export function specSummaryLine(spec, state, verification) {
  const byId = new Map(verification.results.map((result) => [result.id, result]));
  const counts = new Map();
  for (const item of spec.items) {
    const stage = itemStage(state, item.id, byId.get(item.id));
    if (stage === "done" || stage === "resolved") continue;
    const key = stage === "blocked" ? `blocked(${state.items?.[item.id]?.blockedReason})` : stage;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const order = [
    ...ITEM_STATES.filter((stage) => !["blocked", "done", "deferred", "resolved"].includes(stage)),
    ...BLOCK_REASONS.map((reason) => `blocked(${reason})`),
    "deferred",
  ];
  const parts = order.filter((key) => counts.has(key)).map((key) => `${counts.get(key)} ${key}`);
  const byDecision = verification.byDecision ? ` (${verification.byDecision} by decision)` : "";
  return [`spec ${verification.done}/${verification.total} done${byDecision}`, ...parts].join(" · ");
}

function age(since, now) {
  const at = Date.parse(since ?? "");
  if (!Number.isFinite(at)) return "-";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 90 ? `${minutes}m` : minutes < 2880 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
}

/** One status table: item, stage, lane, age, blocker. */
export function specStatusTable(spec, state, verification, now = Date.now()) {
  const byId = new Map(verification.results.map((result) => [result.id, result]));
  const rows = spec.items.map((item) => {
    const record = state.items?.[item.id] ?? {};
    const verified = byId.get(item.id);
    const stage = itemStage(state, item.id, verified);
    const blocker =
      stage === "resolved"
        ? `by decision: ${record.resolution?.reason ?? ""}`
        : stage === "done"
          ? ""
        : stage === "blocked"
          ? `${record.blockedReason}${record.note ? `: ${record.note}` : ""}`
          : record.note
            ? record.note
            : record.wait && (stage === "pending" || stage === "ready")
              ? `waits: ${record.wait}`
              : verified?.failing
            ? `${verified.failing.name}: ${verified.failing.detail}`
            : "";
    return [item.id, stage, record.lane ? `${record.lane.workflowId}/${record.lane.laneId}` : "-", age(record.since, now), blocker];
  });
  const header = ["item", "stage", "lane", "age", "blocker"];
  const widths = header.map((title, column) => Math.min(40, Math.max(title.length, ...rows.map((row) => row[column].length))));
  const format = (row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]))).join("  ").trimEnd();
  return [specSummaryLine(spec, state, verification), "", format(header), ...rows.map(format)].join("\n");
}

/** CLI: `node spec.mjs verify|status|adopt [project dir] [--dry-run] [--force]`; verify exits 0 only when every item is done. */
async function main(argv) {
  const [command = "status", ...rest] = argv;
  const directory = rest.find((arg) => !arg.startsWith("--")) ?? process.cwd();
  if (!["verify", "status", "adopt"].includes(command)) {
    process.stderr.write("usage: node spec.mjs verify|status|adopt [project dir] [--dry-run] [--force]\n");
    return 2;
  }
  const cwd = resolve(directory);
  if (command === "adopt") {
    // Loaded lazily: spec-adopt imports this module.
    const { adoptSpec, adoptionTable } = await import("./spec-adopt.mjs");
    const result = await adoptSpec({ cwd, dryRun: rest.includes("--dry-run"), force: rest.includes("--force") });
    process.stdout.write(`${adoptionTable(result.rows)}\n${result.written ? `Wrote ${SPEC_STATE_PATH}.` : "Dry run: nothing written."}\n`);
    return 0;
  }
  const spec = await loadSpec(cwd);
  if (!spec) {
    process.stderr.write(`No ${SPEC_PATH} in ${cwd}.\n`);
    return 2;
  }
  const state = await loadSpecState(cwd);
  const verification = await verifySpec(spec, state, { repo: targetRepo(spec, cwd) });
  if (command === "status") process.stdout.write(`${specStatusTable(spec, state, verification)}\n`);
  else {
    process.stdout.write(`${verification.done}/${verification.total} done\n`);
    for (const result of verification.results)
      if (!result.done) process.stdout.write(`${result.id}: ${result.failing.name}: ${result.failing.detail}\n`);
  }
  return command === "verify" && verification.done !== verification.total ? 1 : 0;
}

if (process.argv[1]) {
  const self = await realpath(fileURLToPath(import.meta.url)).catch(() => "");
  const invoked = await realpath(process.argv[1]).catch(() => "");
  if (self && self === invoked)
    main(process.argv.slice(2)).then(
      (code) => process.exit(code),
      (error) => {
        process.stderr.write(`${error.message}\n`);
        process.exit(2);
      },
    );
}
