const SAFE_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function canonicalRemote(value) {
  if (typeof value !== "string" || !value || /[\s\\]/.test(value)) throw new Error("Unsupported remote URL.");
  let host, path;
  const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(value);
  if (scp && !value.includes("://")) [, host, path] = scp;
  else {
    let url;
    try { url = new URL(value); } catch { throw new Error("Unsupported remote URL."); }
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) throw new Error("Unsupported remote protocol.");
    host = url.hostname; path = url.pathname.replace(/^\//, "");
  }
  path = path.replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path) || !host) throw new Error("Remote URL must identify one canonical host/repository.");
  return { host: host.toLowerCase(), repo: path.toLowerCase() };
}

function parseGhView(output) {
  const value = JSON.parse(output);
  const text = (v) => typeof v === "string" && v.trim() ? v.trim() : "";
  const owner = (v) => text(v?.login ?? v?.name);
  const number = Number(value.number);
  let baseRepo = "";
  try {
    const url = new URL(text(value.url));
    const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
    if (url.protocol === "https:" && match && Number(match[2]) === number) baseRepo = match[1].toLowerCase();
  } catch {}
  const result = {
    number,
    state: text(value.state).toUpperCase(),
    mergeStateStatus: text(value.mergeStateStatus).toUpperCase(),
    mergeable: text(value.mergeable).toUpperCase(),
    mergedAt: value.mergedAt ?? null,
    headRepo: `${owner(value.headRepositoryOwner)}/${text(value.headRepository?.name)}`.toLowerCase(),
    headOid: text(value.headRefOid).toLowerCase(),
    headBranch: text(value.headRefName),
    baseRepo,
    baseBranch: text(value.baseRefName),
    baseOid: text(value.baseRefOid).toLowerCase(),
  };
  if (!Number.isSafeInteger(number) || number < 1 || !["OPEN", "CLOSED", "MERGED"].includes(result.state) || !["CLEAN", "MERGEABLE"].includes(result.mergeStateStatus) || result.mergeable !== "MERGEABLE" || result.mergedAt !== null || !result.headRepo || !result.baseRepo || !SAFE_OID.test(result.headOid) || !SAFE_OID.test(result.baseOid) || !SAFE_BRANCH.test(result.headBranch) || !SAFE_BRANCH.test(result.baseBranch)) throw new Error("PR metadata is incomplete or unsupported.");
  return result;
}

function argValue(argv, name) {
  const index = argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  return index < 0 ? "" : argv[index].includes("=") ? argv[index].slice(argv[index].indexOf("=") + 1) : argv[index + 1] ?? "";
}
function optionValues(argv, name) {
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) values.push(argv[++i] ?? "");
    else if (argv[i].startsWith(`${name}=`)) values.push(argv[i].slice(name.length + 1));
  }
  return values;
}

export function createExternalApprovalResolver({ cwd, execFile, sessionFile, paneId }) {
  const run = async (program, args) => (await execFile(program, args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 })).stdout.trim();
  const git = async (args) => run("git", args);
  const gh = async (args) => run("gh", args);
  const localIdentity = async () => ({
    repo: await run("git", ["rev-parse", "--show-toplevel"]).then((v) => import("node:fs/promises").then(({ realpath }) => realpath(v))),
    head: (await git(["rev-parse", "HEAD"])).toLowerCase(),
    branch: await git(["symbolic-ref", "--quiet", "--short", "HEAD"]),
    sessionId: await import("node:fs/promises").then(({ realpath }) => realpath(sessionFile)),
  });
  const remoteBinding = async (operation) => {
    const urls = (await git(["remote", "get-url", "--push", "--all", operation.remoteName])).split(/\r?\n/).filter(Boolean);
    if (urls.length !== 1) throw new Error("Push remote must resolve to exactly one effective push URL.");
    const remote = canonicalRemote(urls[0]);
    for (const key of ["push.followTags", "push.recurseSubmodules", `remote.${operation.remoteName}.mirror`, `remote.${operation.remoteName}.tagOpt`]) {
      const configured = await git(["config", "--get", key]).catch(() => "");
      if (configured && (key.endsWith(".tagOpt") || !["false", "no", "off", "0"].includes(configured.toLowerCase()))) throw new Error(`Unsupported side-effecting Git configuration: ${key}.`);
    }
    const rows = (await git(["ls-remote", "--", urls[0], operation.destinationRef])).split(/\r?\n/).filter(Boolean);
    const matches = rows.map((line) => /^(\S+)\s+(\S+)$/.exec(line)).filter((m) => m && m[2] === operation.destinationRef);
    if (matches.length !== 1 || !SAFE_OID.test(matches[0][1])) throw new Error("Could not resolve one live destination OID.");
    return { remoteUrl: urls[0], host: remote.host, remoteRepo: remote.repo, destinationOid: matches[0][1].toLowerCase() };
  };
  const remoteForRepo = async (wanted) => {
    const names = (await git(["remote"])).split(/\r?\n/).filter(Boolean);
    const matches = [];
    for (const name of names) {
      const urls = (await git(["remote", "get-url", "--push", "--all", name])).split(/\r?\n/).filter(Boolean);
      if (urls.length !== 1) throw new Error(`Remote ${name} must resolve to exactly one effective push URL.`);
      for (const url of urls) {
        const remote = canonicalRemote(url);
        if (remote.repo === wanted.toLowerCase()) matches.push({ name, url, ...remote });
      }
    }
    if (matches.length !== 1) throw new Error("Explicit --repo must identify exactly one canonical local remote URL.");
    return matches[0];
  };
  return async (operation) => {
    let failurePhase = "local_identity";
    try {
    const local = await localIdentity();
    if (!SAFE_OID.test(local.head) || !SAFE_BRANCH.test(local.branch)) throw new Error("Local HEAD binding is unsupported.");
    const pane = paneId ?? "";
    if (operation.operation === "push") {
      const remote = await remoteBinding(operation);
      return { ...local, target: operation.branch, baseRef: operation.branch, headRef: operation.branch, headRefOid: operation.sourceRef, baseRefOid: remote.destinationOid, targetRepo: remote.remoteRepo, repo: local.repo, remoteName: operation.remoteName, host: remote.host, remoteRepo: remote.remoteRepo, remoteUrl: remote.remoteUrl, destinationRef: operation.destinationRef, destinationOid: remote.destinationOid, paneId: pane, caller: "root" };
    }
    failurePhase = "repo_remote";
    const remote = await remoteForRepo(operation.repo);
    failurePhase = "pr_arguments";
    const base = argValue(operation.argv, "--base");
    const prSelector = operation.operation === "merge" ? operation.argv[3] : "";
    const requestedHeads = operation.operation === "create" ? optionValues(operation.argv, "--head") : [];
    if (operation.operation === "create" && (!base || !SAFE_BRANCH.test(base) || requestedHeads.length > 1 || (requestedHeads.length === 1 && (!SAFE_BRANCH.test(requestedHeads[0]) || requestedHeads[0] !== local.branch)))) throw new Error("PR create requires an explicit supported --base and a head branch bound to local HEAD.");
    if (operation.operation === "merge" && !/^\d+$/.test(prSelector)) throw new Error("PR merge requires an exact numeric PR number.");
    let target = base;
    let pr;
    if (operation.operation === "merge") {
      failurePhase = "pr_metadata";
      const view = await gh(["pr", "view", prSelector, "--repo", operation.repo, "--json", "number,state,headRefOid,baseRefOid,mergeStateStatus,mergeable,mergedAt,url,headRefName,baseRefName,headRepositoryOwner,headRepository"]);
      pr = parseGhView(view);
      if (pr.state !== "OPEN" || String(pr.number) !== prSelector || pr.baseRepo !== operation.repo.toLowerCase()) throw new Error("PR is stale, closed, merged, or targets another repository.");
      const matchHead = argValue(operation.argv, "--match-head-commit");
      if (!matchHead || matchHead.toLowerCase() !== pr.headOid) throw new Error("PR merge requires --match-head-commit equal to the authoritative head OID.");
      target = pr.baseBranch;
    }
    if (!SAFE_BRANCH.test(target)) throw new Error("Unsupported base branch.");
    const headRef = operation.operation === "merge" ? pr.headBranch : local.branch;
    let sourceRemote = remote;
    if (operation.operation === "create") {
      failurePhase = "head_remote";
      const upstreamName = await git(["config", "--get", `branch.${local.branch}.remote`]).catch(() => "");
      if (!upstreamName || upstreamName === ".") throw new Error("PR create requires a configured remote for the current head branch.");
      const urls = (await git(["remote", "get-url", "--push", "--all", upstreamName])).split(/\r?\n/).filter(Boolean);
      if (urls.length !== 1) throw new Error("Head branch must resolve to exactly one effective push URL.");
      sourceRemote = { name: upstreamName, url: urls[0], ...canonicalRemote(urls[0]) };
    }
    const headRepo = operation.operation === "merge" ? pr.headRepo : sourceRemote.repo;
    const queryOid = async (repoRemote, ref) => {
      const rows = (await git(["ls-remote", "--", repoRemote.url, `refs/heads/${ref}`])).split(/\r?\n/).filter(Boolean);
      const found = rows.map((line) => /^(\S+)\s+(\S+)$/.exec(line)).filter((m) => m && m[2] === `refs/heads/${ref}`);
      if (found.length !== 1 || !SAFE_OID.test(found[0][1])) throw new Error("Could not resolve one live branch OID.");
      return found[0][1].toLowerCase();
    };
    failurePhase = "head_oid";
    const headRefOid = operation.operation === "merge" ? pr.headOid : await queryOid(sourceRemote, headRef);
    failurePhase = "base_oid";
    const baseRefOid = operation.operation === "merge" ? pr.baseOid : await queryOid(remote, target);
    return { ...local, target, baseRef: target, headRef, headRefOid, baseRefOid, targetRepo: remote.repo, remoteName: operation.operation === "merge" ? remote.name : sourceRemote.name, host: operation.operation === "merge" ? remote.host : sourceRemote.host, remoteRepo: operation.operation === "merge" ? remote.repo : sourceRemote.repo, remoteUrl: operation.operation === "merge" ? remote.url : sourceRemote.url, pr, paneId: pane, caller: "root" };
    } catch (error) {
      const safePhase = ["local_identity", "repo_remote", "pr_arguments", "pr_metadata", "head_remote", "head_oid", "base_oid"].includes(failurePhase) ? failurePhase : "resolver";
      throw Object.assign(new Error("External approval resolver failed."), { resolverPhase: safePhase });
    }
  };
}

export async function assertExternalApprovalBindingCurrent(operation, approved, resolveBinding) {
  const current = await resolveBinding(operation);
  if (!current || JSON.stringify(current) !== JSON.stringify(approved)) throw new Error("External approval binding changed during native confirmation.");
  return current;
}
