import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  toPersistenceHandle,
  type CapabilityCatalog,
  type Lane,
  type PersistenceHandle,
  type Workflow,
} from "./contract.js";
import {
  LAUNCH_PROFILE_SCHEMA_VERSION,
  validateLaunchProfile,
} from "./launch-profile.js";
import {
  STARTUP_PROOF_REQUIRED_OPERATIONS,
  missingRequiredAdapterCapabilities,
  type HarnessLaunchAdapter,
} from "./harness-adapter.js";

export type DispatchPorts = {
  directory: string;
  source: string;
  adapter(kind: string): HarnessLaunchAdapter;
  run(args: string[], signal?: AbortSignal, timeout?: number): Promise<any>;
  update(id: string, edit: (workflow: Workflow) => void): Promise<Workflow>;
  verifyRoot(workflow: Workflow): Promise<void>;
  authorize(workflow: Workflow): Promise<boolean>;
  register(
    workflow: Workflow,
    options?: { allowLaneRebind?: boolean },
  ): Promise<void>;
  contract(workflow: Workflow, lane: Lane): string;
  busyRetryDelayMs?: number;
};

export type ResumePorts = Omit<DispatchPorts, "contract">;

const RESUMABLE_SESSION_STATUSES = new Set(["done", "gone"]);

function persistedResumeHandle(lane: Lane, workflow: Workflow): PersistenceHandle {
  const log = lane.sessionLog;
  const logged = log?.sessionRef;
  const persisted = lane.persistenceHandle;
  if (!logged)
    throw new Error(
      `Lane ${lane.id} has no durable session-log entry; native session resume is unsupported without one.`,
    );
  if (
    persisted &&
    (persisted.provider !== logged.provider ||
      persisted.sessionId !== logged.sessionId)
  )
    throw new Error(
      `Lane ${lane.id} persistence handle differs from its authoritative session log; resume is refused.`,
    );
  if (
    log?.kind !== "lane" ||
    log.workflowId !== workflow.id ||
    log.laneId !== lane.id ||
    (log.workspaceId !== undefined &&
      log.workspaceId !== workflow.taskBinding?.workspaceId)
  )
    throw new Error(
      `Lane ${lane.id} session-log ownership or workspace scope does not match workflow ${workflow.id}; resume is refused.`,
    );
  return logged;
}

async function verifyRecordedWorktree(workflow: Workflow, lane: Lane): Promise<string> {
  const logged = lane.sessionLog?.worktree;
  const workflowPath = workflow.worktree;
  if (logged && workflowPath && resolvePath(logged) !== resolvePath(workflowPath))
    throw new Error(
      `Lane ${lane.id} session log worktree differs from workflow worktree; resume is refused.`,
    );
  const path = logged ?? workflowPath ?? workflow.cwd;
  if (!path)
    throw new Error(`Lane ${lane.id} has no recorded worktree for native resume.`);
  let details;
  try {
    details = await lstat(path);
  } catch {
    throw new Error(`Recorded worktree does not exist for lane ${lane.id}: ${path}`);
  }
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Error(`Recorded worktree is not a real directory for lane ${lane.id}: ${path}`);
  return path;
}

function resolvePath(path: string): string {
  // Resume only compares already-recorded paths. `resolve` intentionally does
  // not canonicalize a symlink that the lstat check will reject.
  return resolve(path);
}

function resumeCandidates(workflow: Workflow): Array<{ lane: Lane; index: number }> {
  return workflow.lanes
    .map((lane, index) => ({ lane, index }))
    .filter(({ lane }) => {
      if (lane.completionReceipt || lane.sessionLog?.status === "completed" || lane.sessionLog?.status === "retired")
        return false;
      return RESUMABLE_SESSION_STATUSES.has(lane.sessionLog?.status ?? lane.status);
    });
}

export type DispatchOptions = {
  /** Rebind each lane to a new, orchestrator-authorized incarnation. */
  restart?: boolean;
};

const MAX_LANE_SLUG_LENGTH = 32;
const SLUG_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "these",
  "those",
  "to",
  "via",
  "with",
]);

/**
 * Make a compact, deterministic tab slug from the first significant words of
 * a lane objective. ASCII output keeps labels portable across Herdr clients;
 * the hard cap leaves room for the role marker and tab chrome.
 */
export function laneSlug(objective: string): string {
  const words = (objective ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((word) => !SLUG_STOPWORDS.has(word)) ?? [];
  const selected = words.slice(0, 5);
  if (selected.length === 0) return "lane";
  return selected
    .join("-")
    .slice(0, MAX_LANE_SLUG_LENGTH)
    .replace(/-+$/, "") || "lane";
}

/** Herdr-generated workflow IDs are `herdr-<uuid-prefix>`; retain the
 * eight-character workflow discriminator in newly assigned agent names. */
export function workflowShortId(workflowId: string): string {
  const generated = workflowId.match(/^herdr-([a-z0-9]+)/i)?.[1];
  const normalized = (generated ?? workflowId.replace(/[^a-z0-9]/gi, ""))
    .toLowerCase()
    .slice(0, 8);
  return normalized || "workflow";
}

export function childAgentName(workflowId: string, laneNumber: number): string {
  return `child-${workflowShortId(workflowId)}-${laneNumber}`;
}

export function laneTabLabel(objective: string): string {
  return `🐑 ${laneSlug(objective)}`;
}

function nativeAgent(raw: any): any {
  return (raw?.result ?? raw)?.agent;
}

function nativeSession(
  agent: any,
): { kind: "path" | "id"; value: string } | undefined {
  const session = agent?.agent_session;
  if (session?.kind === "path" || session?.kind === "id") {
    return typeof session.value === "string" && session.value
      ? { kind: session.kind, value: session.value }
      : undefined;
  }
  return undefined;
}

function sameSession(
  left: { kind: "path" | "id"; value: string } | undefined,
  right: { kind: "path" | "id"; value: string } | undefined,
): boolean {
  return Boolean(
    left && right && left.kind === right.kind && left.value === right.value,
  );
}

function laneSessionLog(
  workflow: Workflow,
  lane: Lane,
  persistenceHandle: ReturnType<typeof toPersistenceHandle>,
  status: "dispatched" | "working" | "completed",
) {
  return {
    kind: "lane" as const,
    sessionRef: persistenceHandle,
    // agentStartedAt/incarnationStartedAt are the existing dispatch evidence;
    // workflow.createdAt is only the legacy recovery fallback.
    startedAt:
      lane.sessionLog?.startedAt ??
      lane.agentStartedAt ??
      lane.incarnationStartedAt ??
      workflow.dispatchedAt ??
      workflow.createdAt,
    ...(lane.incarnationStartedAt
      ? { incarnationStartedAt: lane.incarnationStartedAt }
      : lane.sessionLog?.incarnationStartedAt
        ? { incarnationStartedAt: lane.sessionLog.incarnationStartedAt }
        : {}),
    ...(lane.sessionLog?.lastResponseAt
      ? { lastResponseAt: lane.sessionLog.lastResponseAt }
      : {}),
    status,
    workflowId: workflow.id,
    laneId: lane.id,
    ...(lane.paneId ? { paneId: lane.paneId } : {}),
    ...(lane.tabId ? { tabId: lane.tabId } : {}),
    ...(workflow.ownership.workspaceId
      ? { workspaceId: workflow.ownership.workspaceId }
      : {}),
    ...(workflow.worktree ? { worktree: workflow.worktree } : {}),
  };
}

/** Herdr has no native wait-for-shell command. `pane process-info` is the
 * native readiness signal: a pane is startable when its interactive shell is
 * the only foreground process (shell_pid set and matching). Gating on it
 * removes the tab-create/agent-start race without prompt-string matching. */
async function waitForShellReady(
  port: Pick<DispatchPorts, "run">,
  paneId: string,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const raw = await port.run(
      ["pane", "process-info", "--pane", paneId],
      signal,
    );
    const info = (raw.result ?? raw).process_info;
    if (
      info?.shell_pid &&
      Array.isArray(info.foreground_processes) &&
      info.foreground_processes.length === 1 &&
      info.foreground_processes[0]?.pid === info.shell_pid
    )
      return;
    await delay(300, { signal });
  }
  throw new Error(
    `Pane ${paneId} shell did not become ready for agent start; inspect it before retrying.`,
  );
}

/** The only dispatch implementation. Never creates, moves, replaces or closes a workspace. */
export async function dispatchTask(
  workflow: Workflow,
  execute: boolean,
  port: DispatchPorts,
  signal?: AbortSignal,
  options: DispatchOptions = {},
) {
  if (!execute)
    return {
      dryRun: true,
      workflow,
      commands: [
        `Create lane tabs only in task workspace ${workflow.taskBinding?.workspaceId ?? "UNBOUND (dispatch refused)"}.`,
        "Verify exact profile, register routes, start and verify native incarnation/tools before assignment.",
      ],
    };
  await port.verifyRoot(workflow);
  const workflowProfile =
    workflow.launchProfile === undefined
      ? undefined
      : validateLaunchProfile(workflow.launchProfile, "workflow launchProfile");
  if (
    workflow.launchProfile !== undefined &&
    workflow.launchProfileVersion !== undefined &&
    workflow.launchProfileVersion !== LAUNCH_PROFILE_SCHEMA_VERSION
  )
    throw new Error("Unsupported workflow launchProfile schema version.");
  const profiles = workflow.lanes.map((lane) => {
    if (
      lane.launchProfile !== undefined &&
      lane.launchProfileVersion !== undefined &&
      lane.launchProfileVersion !== LAUNCH_PROFILE_SCHEMA_VERSION
    )
      throw new Error(
        `Unsupported launchProfile schema version for lane ${lane.id}.`,
      );
    return validateLaunchProfile(
      lane.launchProfile ?? workflowProfile,
      `Lane ${lane.id} launchProfile`,
    );
  });
  const adapters = workflow.lanes.map((lane) => port.adapter(lane.agentKind));
  const discoveries: Array<{
    laneId: string;
    profile: (typeof profiles)[number];
    catalog: CapabilityCatalog;
  }> = [];
  for (const [index, adapter] of adapters.entries()) {
    const missing = missingRequiredAdapterCapabilities(adapter);
    if (adapter.version !== 1 || missing.length > 0)
      throw new Error(
        `Harness lacks the required versioned capabilities${
          missing.length ? `: ${missing.join(", ")}` : ""
        }.`,
      );
    const catalog = adapter.discoverCatalog
      ? await adapter.discoverCatalog(profiles[index])
      : undefined;
    if (catalog)
      discoveries.push({
        laneId: workflow.lanes[index].id,
        profile: profiles[index],
        catalog,
      });
    await adapter.preflight(profiles[index], catalog);
  }
  const restart = options.restart === true;
  const workspaceId = workflow.taskBinding?.workspaceId;
  if (
    !workspaceId ||
    (workflow.ownership.workspaceId &&
      workflow.ownership.workspaceId !== workspaceId)
  )
    throw new Error(
      "Missing or mismatched task workspace binding; no replacement workspace will be created.",
    );
  // Controller observations can turn a failed startup into `blocked` during
  // a human trust prompt, then `unknown` when idle without a receipt. Only an unassigned startup
  // rejection may re-enter dispatch, and only with proof from its existing
  // native agent. Never answer the dialog, restart it, or manufacture readiness.
  const recoverObservedStartup = ["blocked", "unknown"].includes(workflow.status) && !restart &&
    workflow.retry?.failedStage === "agent-start" &&
    /\bagent_not_ready\b/.test(workflow.retry?.error ?? "") &&
    workflow.lanes.some(lane => lane.agentStartAttemptedAt) &&
    workflow.lanes.every(lane => !lane.promptAttemptedAt && !lane.promptedAt && !lane.completionReceipt);
  if (recoverObservedStartup) {
    for (const [index, lane] of workflow.lanes.entries()) {
      if (!lane.agentStartAttemptedAt) continue;
      if (!lane.paneId || !lane.startupIntentPath || !lane.startupNonce)
        throw new Error("Blocked startup lacks its original pane/intent identity; no recovery performed.");
      const raw = await port.run(["agent", "get", lane.paneId], signal);
      const agent = (raw.result ?? raw).agent;
      if (agent?.launch_pending || agent?.interactive_ready === false ||
        ["blocked", "working", "starting"].includes(agent?.agent_status) ||
        !(agent?.interactive_ready === true || ["idle", "done"].includes(agent?.agent_status)))
        throw new Error("Startup is still awaiting user approval or native readiness; leave the existing lane in place.");
      const intent = JSON.parse(await readFile(lane.startupIntentPath, "utf8"));
      const hello = await readFile(`${lane.startupIntentPath}.ready`, "utf8")
        .then(text => JSON.parse(text)).catch(() => null);
      if (!hello || (adapters[index].attestationComplete && !adapters[index].attestationComplete(hello)))
        throw new Error("Approved startup has no complete attestation yet; no recovery performed.");
      const proof = adapters[index].verifyStartup(agent, hello);
      if (intent.incarnationId !== lane.incarnationId || intent.nonce !== lane.startupNonce ||
        intent.paneId !== lane.paneId || intent.workspaceId !== workspaceId ||
        intent.source !== port.source || JSON.stringify(intent.profile) !== JSON.stringify(profiles[index]) ||
        agent.pane_id !== lane.paneId || agent.workspace_id !== workspaceId || agent.agent !== lane.agentKind ||
        proof.paneId !== lane.paneId || proof.workspaceId !== workspaceId ||
        proof.nonce !== lane.startupNonce || proof.source !== port.source ||
        JSON.stringify(proof.profile) !== JSON.stringify(profiles[index]) ||
        !STARTUP_PROOF_REQUIRED_OPERATIONS.every(operation => proof.operations?.includes(operation)) ||
        (lane.nativeSession && (lane.nativeSession.kind !== proof.session.kind || lane.nativeSession.value !== proof.session.value)))
        throw new Error("Blocked startup identity/profile/session proof mismatch; no recovery performed.");
    }
  }
  if (
    ![
      "planned",
      "dispatch-failed",
      "starting",
      ...(recoverObservedStartup ? [workflow.status] : []),
      ...(restart ? ["running"] : []),
    ].includes(workflow.status)
  )
    throw new Error(`Workflow cannot be dispatched from ${workflow.status}.`);
  if (!(await port.authorize(workflow))) return { cancelled: true, workflow };
  // Per-workflow effect serialization, not a global manifest transaction. The
  // lock records its owning pid: a killed dispatch leaves it behind, and a
  // later dispatch may reclaim it only when the recorded owner is verifiably
  // dead — a live or unverifiable owner still fails closed.
  await mkdir(port.directory, { recursive: true, mode: 0o700 });
  const lock = join(port.directory, `${workflow.id}.dispatch-lock`);
  const ownerPath = join(lock, "owner.json");
  const acquire = async (): Promise<void> => {
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: number } | null = null;
      try {
        owner = JSON.parse(await readFile(ownerPath, "utf8")) as {
          pid?: number;
        };
      } catch {
        owner = null;
      }
      if (typeof owner?.pid !== "number")
        throw new Error(
          "Dispatch lock exists without a verifiable owner (possibly a live mid-acquire race or a pre-owner lock); inspect it before retrying dispatch.",
        );
      let alive = false;
      try {
        process.kill(owner.pid, 0);
        alive = true;
      } catch (signalError) {
        alive = (signalError as NodeJS.ErrnoException).code === "EPERM";
      }
      if (alive)
        throw new Error(
          "Dispatch is already active; no duplicate start allowed.",
        );
      await rm(lock, { recursive: true, force: true });
      return acquire();
    }
    await writeFile(
      ownerPath,
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      { mode: 0o600 },
    );
  };
  await acquire();
  const update = async (edit: (workflow: Workflow) => void) => {
    workflow = await port.update(workflow.id, edit);
    return workflow;
  };
  let stage = "workspace-verify";
  try {
    await port.run(["workspace", "get", workspaceId], signal);
    if (restart) {
      for (let i = 0; i < workflow.lanes.length; i++) {
        let lane = workflow.lanes[i];
        if (
          lane.restart?.status === "requested" ||
          lane.restart?.status === "starting"
        )
          continue;
        if (!lane.paneId || !lane.nativeSession)
          throw new Error(
            `Lane ${lane.id} cannot be restarted without a recorded native incarnation.`,
          );
        let raw;
        try {
          raw = await port.run(["agent", "get", lane.paneId], signal);
        } catch (error) {
          if (!/agent_not_found/.test(String(error))) throw error;
        }
        if (raw) {
          const agent = nativeAgent(raw);
          const liveSession = nativeSession(agent);
          if (
            !agent ||
            agent.pane_id !== lane.paneId ||
            agent.workspace_id !== workspaceId ||
            agent.agent !== lane.agentKind ||
            !sameSession(liveSession, lane.nativeSession)
          )
            throw new Error(
              `Lane ${lane.id} has an unrelated or mismatched occupant; authorized rebind is refused.`,
            );
        }
        const incarnationId = `incarnation-${randomUUID().slice(0, 12)}`;
        const previousIncarnationId = lane.incarnationId;
        await update((w) => {
          const current = w.lanes[i];
          current.restart = {
            version: 1,
            status: "requested",
            requestedAt: new Date().toISOString(),
            ...(previousIncarnationId ? { previousIncarnationId } : {}),
            incarnationId,
          };
          current.incarnationId = incarnationId;
          current.incarnationRevision = (current.incarnationRevision ?? 0) + 1;
          delete current.incarnationStartedAt;
          delete current.agentStartedAt;
          delete current.agentStartAttemptedAt;
          delete current.startupIntentPath;
          delete current.startupNonce;
          delete current.startupHandshakeAttemptedAt;
          delete current.startupHandshakeSentAt;
          delete current.promptAttemptedAt;
          delete current.promptedAt;
          delete current.nativeSession;
          delete current.persistenceHandle;
          delete current.agentSessionPath;
          delete current.agentSessionId;
          delete current.piSessionPath;
          delete current.piSessionId;
          delete current.completionReceipt;
          if (current.sessionLog)
            current.sessionLog = { ...current.sessionLog, status: "planned" };
          current.status = "planned";
          const goal = w.goals?.find((item) => item.id === current.goalId);
          if (goal) {
            goal.revision += 1;
            goal.status = "planned";
            goal.outcome = "unresolved";
            goal.updatedAt = new Date().toISOString();
            current.goalRevision = goal.revision;
          }
        });
        lane = workflow.lanes[i];
        if (raw)
          await port.run(
            ["agent", "send-keys", lane.paneId!, "ctrl+c"],
            signal,
          );
        await update((w) => {
          const current = w.lanes[i];
          if (current.restart?.incarnationId === incarnationId)
            current.restart.status = "starting";
        });
        workflow = await port.update(workflow.id, (w) => {
          w.status = "starting";
        });
      }
    }
    await update((w) => {
      w.status = "starting";
      w.ownership.workspaceId = workspaceId;
      if (recoverObservedStartup) w.evidence.push({
        at: new Date().toISOString(),
        kind: "blocked-startup-requalified",
        text: "Existing native startup passed readiness and identity/profile proof; no approval input or replacement launch was sent for the blocked agent.",
      });
      w.retry = {
        state: "dispatching",
        attempt: (w.retry?.attempt ?? 0) + 1,
        retryCommand: `herdr_dispatch ${w.id} execute=true`,
      };
      for (const discovery of discoveries)
        w.evidence.push({
          at: new Date().toISOString(),
          kind: "capability-discovery",
          text: JSON.stringify(discovery),
        });
    });
    // Establish all routing before any assignment. Cwd only selects code location.
    for (let i = 0; i < workflow.lanes.length; i++) {
      let lane = workflow.lanes[i];
      const profile = profiles[i];
      if (!lane.startupIntentPath) {
        const intentPath = join(
          port.directory,
          `${workflow.id}-${lane.id}-startup.json`,
        );
        const nonce = randomUUID();
        const incarnationId =
          lane.incarnationId ?? `incarnation-${randomUUID().slice(0, 12)}`;
        await writeFile(
          intentPath,
          JSON.stringify({
            version: 1,
            workflowId: workflow.id,
            laneId: lane.id,
            manifestDirectory: port.directory,
            workspaceId,
            profile,
            profileVersion: LAUNCH_PROFILE_SCHEMA_VERSION,
            incarnationId,
            nonce,
            source: port.source,
          }),
          { mode: 0o600 },
        );
        await update((w) => {
          const current = w.lanes[i];
          current.incarnationId = incarnationId;
          current.incarnationRevision = current.incarnationRevision ?? 1;
          w.lanes[i].startupIntentPath = intentPath;
          w.lanes[i].startupNonce = nonce;
        });
        lane = workflow.lanes[i];
      }
      if (!lane.paneId) {
        stage = "tab-create";
        if (lane.tabCreateAttemptedAt)
          throw new Error(
            "Tab creation response was lost; reconcile the recorded intent before retrying.",
          );
        await update((w) => {
          w.lanes[i].tabCreateAttemptedAt = new Date().toISOString();
        });
        const created = await port.run(
          [
            "tab",
            "create",
            "--workspace",
            workspaceId,
            "--cwd",
            workflow.cwd,
            "--label",
            laneTabLabel(lane.objective ?? lane.id),
            "--env",
            `BAA_STARTUP_INTENT=${lane.startupIntentPath}`,
            "--no-focus",
          ],
          signal,
        );
        const result = created.result ?? created;
        const tab = result.tab,
          pane = result.root_pane;
        if (
          !tab?.tab_id ||
          !pane?.pane_id ||
          (tab.workspace_id && tab.workspace_id !== workspaceId) ||
          (pane.workspace_id && pane.workspace_id !== workspaceId)
        )
          throw new Error(
            "Native tab response lacks a matching task workspace/pane binding.",
          );
        // Verify opaque native IDs, never derive membership from their spelling.
        const live = await port.run(["pane", "get", pane.pane_id], signal);
        const info = (live.result ?? live).pane;
        if (
          info?.workspace_id !== workspaceId ||
          info?.tab_id !== tab.tab_id ||
          info?.pane_id !== pane.pane_id
        )
          throw new Error(
            "Created lane is outside its designated task workspace.",
          );
        await update((w) => {
          const l = w.lanes[i];
          l.paneId = pane.pane_id;
          l.tabId = tab.tab_id;
          l.agentName = childAgentName(w.id, i + 1);
          l.relationshipId = `herdr-rel-${randomUUID()}`;
          w.ownership.tabIds ??= [];
          w.ownership.tabIds.push(tab.tab_id);
          w.ownership.paneIds.push(pane.pane_id);
        });
      }
    }
    stage = "routing";
    await port.register(workflow);
    for (let i = 0; i < workflow.lanes.length; i++) {
      let lane = workflow.lanes[i];
      const profile = profiles[i];
      // Preserve names recorded by older manifests, but assign the new scheme
      // whenever this dispatch is about to start an unnamed lane.
      if (!lane.agentName) {
        await update((w) => {
          w.lanes[i].agentName = childAgentName(w.id, i + 1);
        });
        lane = workflow.lanes[i];
      }
      const intent = JSON.parse(
        await readFile(lane.startupIntentPath!, "utf8"),
      );
      const intentProfile = validateLaunchProfile(
        intent.profile,
        `Lane ${lane.id} startup intent profile`,
      );
      if (JSON.stringify(intentProfile) !== JSON.stringify(profile))
        throw new Error(
          `Lane ${lane.id} startup intent profile differs from its current launchProfile.`,
        );
      if (intent.incarnationId !== lane.incarnationId)
        throw new Error(
          `Lane ${lane.id} startup intent is not bound to its recorded incarnation.`,
        );
      await writeFile(
        lane.startupIntentPath!,
        JSON.stringify({ ...intent, paneId: lane.paneId }),
        { mode: 0o600 },
      );
      stage = "agent-start";
      if (lane.agentStartedAt) {
        // A recorded start whose pane no longer holds any agent (crash after
        // detection) may be restarted once per dispatch attempt. An attested
        // agent that vanished, or any occupied pane, fails closed instead.
        let present = true;
        try {
          await port.run(["agent", "get", lane.paneId!], signal);
        } catch (error) {
          present = !/agent_not_found/.test(String(error));
        }
        if (!present) {
          const prior = await readFile(
            `${lane.startupIntentPath}.ready`,
            "utf8",
          )
            .then((text) => JSON.parse(text))
            .catch(() => null);
          if (prior && prior.nonce === lane.startupNonce)
            throw new Error(
              "Lane attested but its agent vanished; inspect the pane before retrying dispatch.",
            );
          await update((w) => {
            delete w.lanes[i].agentStartedAt;
            delete w.lanes[i].agentStartAttemptedAt;
          });
          lane = workflow.lanes[i];
        }
      }
      if (!lane.agentStartedAt) {
        if (lane.agentStartAttemptedAt) {
          // A previous start was rejected mid-startup, crashed, or lost its
          // response. Adopt it only when the attestation now exists and matches
          // the lane's intent nonce. Without an attestation, a pane holding no
          // live agent may be started fresh (the launch never took); an
          // occupied pane is genuinely uncertain and needs operator review.
          const recovered = await readFile(
            `${lane.startupIntentPath}.ready`,
            "utf8",
          )
            .then((text) => JSON.parse(text))
            .catch(() => null);
          if (recovered && recovered.nonce === lane.startupNonce) {
            await update((w) => {
              w.lanes[i].agentStartedAt = new Date().toISOString();
            });
          } else {
            let paneAgent: unknown = null;
            try {
              const live = await port.run(
                ["agent", "get", lane.paneId!],
                signal,
              );
              paneAgent = (live.result ?? live).agent ?? null;
            } catch {
              paneAgent = null;
            }
            if (paneAgent)
              throw new Error(
                "Agent start outcome is uncertain and the pane is occupied; inspect it and reconcile before retrying dispatch.",
              );
            await update((w) => {
              delete w.lanes[i].agentStartAttemptedAt;
            });
          }
          lane = workflow.lanes[i];
        }
        if (!lane.agentStartedAt && !lane.agentStartAttemptedAt) {
          await update((w) => {
            w.lanes[i].agentStartAttemptedAt = new Date().toISOString();
          });
          await waitForShellReady(port, lane.paneId!, signal);
          for (let attempt = 0; ; attempt++) {
            try {
              await port.run(
                [
                  "agent",
                  "start",
                  lane.agentName!,
                  "--kind",
                  lane.agentKind,
                  "--pane",
                  lane.paneId!,
                  "--timeout",
                  "60000",
                  "--",
                  ...adapters[i].launchArguments(profile, port.source, {
                    startupIntentPath: lane.startupIntentPath!,
                  }),
                ],
                signal,
                65_000,
              );
              break;
            } catch (error) {
              // Native busy rejection is before launch, unlike timeout after submission.
              if (attempt < 2 && /agent_pane_busy/.test(String(error))) {
                await delay(port.busyRetryDelayMs ?? 1_500, { signal });
                continue;
              }
              if (/agent_pane_busy/.test(String(error)))
                await update((w) => {
                  delete w.lanes[i].agentStartAttemptedAt;
                });
              throw error;
            }
          }
          await update((w) => {
            w.lanes[i].agentStartedAt = new Date().toISOString();
          });
        }
      }
      const startupHandshake = adapters[i].startupHandshake;
      if (startupHandshake !== undefined && !lane.startupHandshakeSentAt) {
        if (lane.startupHandshakeAttemptedAt)
          throw new Error(
            "Startup handshake submission is uncertain; do not repeat terminal input.",
          );
        stage = "startup-handshake";
        await update((w) => {
          w.lanes[i].startupHandshakeAttemptedAt = new Date().toISOString();
        });
        await port.run(
          ["agent", "prompt", lane.paneId!, startupHandshake],
          signal,
        );
        await update((w) => {
          w.lanes[i].startupHandshakeSentAt = new Date().toISOString();
        });
        lane = workflow.lanes[i];
      }
      stage = "startup-proof";
      lane = workflow.lanes[i];
      const raw = await port.run(["agent", "get", lane.paneId!], signal);
      const agent = (raw.result ?? raw).agent;
      // Some harnesses attest asynchronously (e.g. a handshake turn completing,
      // or an MCP server merging operations — codex may spawn it lazily). Wait
      // for a COMPLETE attestation: identity fields plus merged operations.
      // Bounded readiness gate, never an unbounded loop, never an early break
      // on a partial attestation.
      let hello: any = null;
      const attestationDeadline = Date.now() + 90_000;
      const complete = (value: unknown) =>
        adapters[i].attestationComplete?.(value) ?? true;
      while (Date.now() < attestationDeadline) {
        hello = await readFile(`${lane.startupIntentPath}.ready`, "utf8")
          .then((text) => JSON.parse(text))
          .catch(() => null);
        if (hello && complete(hello)) break;
        await delay(500, { signal });
      }
      if (!hello || !complete(hello))
        throw new Error(
          "Startup attestation incomplete or unavailable; no work assigned. Verify the harness handshake and MCP bridge serve the protocol tools.",
        );
      const proof = adapters[i].verifyStartup(agent, hello);
      if (
        agent?.pane_id !== lane.paneId ||
        agent?.workspace_id !== workspaceId ||
        agent?.agent !== lane.agentKind ||
        proof.paneId !== lane.paneId ||
        proof.workspaceId !== workspaceId ||
        proof.nonce !== lane.startupNonce ||
        proof.source !== port.source ||
        JSON.stringify(proof.profile) !== JSON.stringify(profile) ||
        !STARTUP_PROOF_REQUIRED_OPERATIONS.every((operation) =>
          proof.operations?.includes(operation),
        )
      )
        throw new Error(
          "Startup workspace/native-session/profile/tools mismatch; no work assigned.",
        );
      if (
        lane.nativeSession &&
        (lane.nativeSession.kind !== proof.session.kind ||
          lane.nativeSession.value !== proof.session.value)
      )
        throw new Error(
          "Unrelated replacement cannot inherit this lane; authorized incarnation recovery is required.",
        );
      await update((w) => {
        const current = w.lanes[i];
        current.nativeSession = proof.session;
        const persistenceHandle = toPersistenceHandle(
          proof.persistence ?? proof.session,
          profile.provider,
        );
        current.persistenceHandle = persistenceHandle;
        current.incarnationStartedAt = new Date().toISOString();
        current.sessionLog = laneSessionLog(
          w,
          current,
          persistenceHandle,
          current.completionReceipt ? "completed" : "dispatched",
        );
        if (proof.session.kind === "path")
          current.agentSessionPath = proof.session.value;
        else current.agentSessionId = proof.session.value;
        if (current.restart) current.restart.status = "bound";
        if (!current.completionReceipt) current.status = "agent-ready";
      });
    }
    // No lane receives work until every lane is verified. Routing already exists.
    for (let i = 0; i < workflow.lanes.length; i++) {
      const lane = workflow.lanes[i];
      if (lane.promptedAt) continue;
      if (lane.promptAttemptedAt)
        throw new Error(
          "Assignment submission is uncertain; do not repeat terminal input.",
        );
      stage = "assignment";
      await port.verifyRoot(workflow);
      await update((w) => {
        w.lanes[i].promptAttemptedAt = new Date().toISOString();
      });
      await port.run(
        ["agent", "prompt", lane.paneId!, port.contract(workflow, lane)],
        signal,
      );
      await update((w) => {
        const current = w.lanes[i];
        current.promptedAt = new Date().toISOString();
        if (!current.completionReceipt) {
          current.status = "running";
          if (current.sessionLog)
            current.sessionLog = { ...current.sessionLog, status: "working" };
        }
        const goal = w.goals?.find((item) => item.id === current.goalId);
        if (goal && goal.outcome === "unresolved") {
          goal.revision += 1;
          goal.status = "running";
          goal.updatedAt = new Date().toISOString();
          current.goalRevision = goal.revision;
        }
      });
    }
    await update((w) => {
      w.status = "running";
      w.outcome = "running";
      w.retry = undefined;
      w.dispatchedAt = new Date().toISOString();
    });
    return { dispatched: true, workflow };
  } catch (error) {
    await update((w) => {
      w.status = "dispatch-failed";
      w.outcome = "unknown";
      w.retry = {
        state: "retryable",
        attempt: w.retry?.attempt ?? 1,
        retryCommand: `herdr_dispatch ${w.id} execute=true`,
        failedStage: stage,
        error: String(error),
      };
      w.evidence.push({
        at: new Date().toISOString(),
        kind: "dispatch-error",
        text: `${stage}: ${error}`,
      });
    });
    throw error;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** Reattach lanes to their provider-native persisted sessions. This is kept
 * separate from dispatch/restart: it never creates a new provider session and
 * never sends the original assignment again. */
export async function resumeTask(
  workflow: Workflow,
  execute: boolean,
  port: ResumePorts,
  signal?: AbortSignal,
) {
  const candidates = resumeCandidates(workflow);
  const preview = candidates.map(({ lane }) => ({
    laneId: lane.id,
    agentKind: lane.agentKind,
    status: lane.sessionLog?.status ?? lane.status,
    sessionId: lane.sessionLog?.sessionRef.sessionId,
    worktree: lane.sessionLog?.worktree ?? workflow.worktree ?? workflow.cwd,
  }));
  if (!execute)
    return {
      dryRun: true,
      workflow,
      resumableLanes: preview,
      commands: preview.map(
        (item) =>
          `${item.agentKind} native resume for lane ${item.laneId}: session ${item.sessionId ?? "UNAVAILABLE"} in ${item.worktree ?? "UNAVAILABLE"}`,
      ),
    };
  await port.verifyRoot(workflow);
  const workspaceId = workflow.taskBinding?.workspaceId;
  if (
    !workspaceId ||
    (workflow.ownership.workspaceId &&
      workflow.ownership.workspaceId !== workspaceId)
  )
    throw new Error(
      "Missing or mismatched task workspace binding; native resume cannot choose a replacement workspace.",
    );
  if (candidates.length === 0)
    throw new Error(
      `Workflow ${workflow.id} has no done or gone lane session in its durable session log; nothing can be natively resumed.`,
    );
  const infos = candidates.map(({ lane, index }) => {
    const session = persistedResumeHandle(lane, workflow);
    const profile = validateLaunchProfile(
      lane.launchProfile ?? workflow.launchProfile,
      `Lane ${lane.id} launchProfile`,
    );
    if (session.provider !== profile.provider)
      throw new Error(
        `Lane ${lane.id} persisted session provider ${session.provider} does not match its exact launch profile provider ${profile.provider}; native resume is refused.`,
      );
    const adapter = port.adapter(lane.agentKind);
    const missing = missingRequiredAdapterCapabilities(adapter);
    if (adapter.version !== 1 || missing.length > 0)
      throw new Error(
        `Harness ${lane.agentKind} lacks the required versioned capabilities${
          missing.length ? `: ${missing.join(", ")}` : ""
        }; native resume is refused.`,
      );
    if (
      adapter.capabilities.supportsSessionResume !== true ||
      typeof adapter.resumeSessionId !== "function" ||
      typeof adapter.resumeArguments !== "function"
    )
      throw new Error(
        `Harness ${lane.agentKind} native session resume is unsupported: its adapter does not declare and implement an exact resume invocation.`,
      );
    const resumeSessionId = adapter.resumeSessionId;
    const resumeArguments = adapter.resumeArguments;
    const sessionId = resumeSessionId(session);
    return {
      lane,
      index,
      session,
      sessionId,
      profile,
      adapter,
      resumeSessionId,
      resumeArguments,
    };
  });
  for (const info of infos) {
    await verifyRecordedWorktree(workflow, info.lane);
    await info.adapter.preflight(info.profile);
    if (info.lane.sessionLog?.status === "done" && info.lane.paneId) {
      try {
        const existing = await port.run(["agent", "get", info.lane.paneId], signal);
        if (existing)
          throw new Error(
            `Lane ${info.lane.id} still has a live terminal agent; native resume will not duplicate its session.`,
          );
      } catch (error) {
        if (/still has a live terminal/.test(String(error))) throw error;
        if (!/agent_not_found/.test(String(error))) throw error;
      }
    }
  }
  if (!(await port.authorize(workflow))) return { cancelled: true, workflow };
  const workspaceResponse = await port.run(
    ["workspace", "get", workspaceId],
    signal,
  );
  const workspace = (workspaceResponse.result ?? workspaceResponse).workspace;
  if (workspace?.workspace_id !== workspaceId)
    throw new Error(
      "Native resume workspace lookup did not return the designated task workspace; no topology mutation is trusted.",
    );

  await mkdir(port.directory, { recursive: true, mode: 0o700 });
  const lock = join(port.directory, `${workflow.id}.resume-lock`);
  const ownerPath = join(lock, "owner.json");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner: { pid?: number } | null = null;
    try {
      owner = JSON.parse(await readFile(ownerPath, "utf8")) as { pid?: number };
    } catch {
      owner = null;
    }
    if (typeof owner?.pid !== "number")
      throw new Error(
        "Native session resume lock exists without a verifiable owner; inspect it before retrying.",
      );
    let alive = false;
    try {
      process.kill(owner.pid, 0);
      alive = true;
    } catch (signalError) {
      alive = (signalError as NodeJS.ErrnoException).code === "EPERM";
    }
    if (alive)
      throw new Error("Native session resume is already active; no duplicate start allowed.");
    await rm(lock, { recursive: true, force: true });
    await mkdir(lock, { mode: 0o700 });
  }
  await writeFile(
    ownerPath,
    JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    { mode: 0o600 },
  );
  let currentWorkflow = workflow;
  const update = async (edit: (workflow: Workflow) => void) => {
    currentWorkflow = await port.update(currentWorkflow.id, edit);
    return currentWorkflow;
  };
  let stage = "resume-request";
  let staleSnapshot = false;
  try {
    // Preflight and authorization intentionally happen before the effect lock,
    // but the caller's snapshot may have gone stale while they were running.
    // Reconcile once under the lock so a second invocation cannot create
    // another pane from the same durable done/gone snapshot after the first
    // one landed.
    if (typeof workflow.updatedAt === "string") {
      await update((current) => {
        if (current.updatedAt !== workflow.updatedAt) {
          staleSnapshot = true;
          throw new Error(
            "Workflow changed while native resume was being authorized; retry from a fresh observation.",
          );
        }
      });
    }
    await update((w) => {
      w.status = "starting";
      w.outcome = "unknown";
      w.evidence.push({
        at: new Date().toISOString(),
        kind: "native-session-resume-requested",
        text: `Reattaching ${infos.map((info) => `${info.lane.id}=${info.sessionId}`).join(", ")} in task workspace ${workspaceId}.`,
      });
    });

    // Bind every replacement pane and route before starting any harness. A
    // lost tab-create response is fenced by resumeTabCreateAttemptedAt.
    for (const info of infos) {
      const { lane, index, profile } = info;
      let currentLane = currentWorkflow.lanes[index];
      if (!currentLane.resume || currentLane.resume.status === "bound") {
        const incarnationId = `incarnation-${randomUUID().slice(0, 12)}`;
        await update((w) => {
          const current = w.lanes[index];
          current.resume = {
            version: 1,
            status: "requested",
            requestedAt: new Date().toISOString(),
            ...(current.incarnationId
              ? { previousIncarnationId: current.incarnationId }
              : {}),
            ...(current.paneId ? { previousPaneId: current.paneId } : {}),
            ...(current.tabId ? { previousTabId: current.tabId } : {}),
            incarnationId,
          };
          current.incarnationId = incarnationId;
          delete current.incarnationStartedAt;
          delete current.agentStartedAt;
          delete current.resumeTabCreateAttemptedAt;
          delete current.resumeAgentStartAttemptedAt;
          delete current.resumeStartupHandshakeAttemptedAt;
          delete current.resumeStartupHandshakeSentAt;
          delete current.startupIntentPath;
          delete current.startupNonce;
          current.status = "resuming";
        });
        currentLane = currentWorkflow.lanes[index];
      }
      const recordedWorktree = await verifyRecordedWorktree(
        currentWorkflow,
        currentLane,
      );
      if (!currentLane.startupIntentPath) {
        const intentPath = join(
          port.directory,
          `${currentWorkflow.id}-${currentLane.id}-resume-${randomUUID().slice(0, 8)}-startup.json`,
        );
        const nonce = randomUUID();
        await writeFile(
          intentPath,
          JSON.stringify({
            version: 1,
            workflowId: currentWorkflow.id,
            laneId: currentLane.id,
            manifestDirectory: port.directory,
            workspaceId,
            worktree: recordedWorktree,
            profile,
            profileVersion: LAUNCH_PROFILE_SCHEMA_VERSION,
            incarnationId: currentLane.resume!.incarnationId,
            resumeSessionId: info.sessionId,
            nonce,
            source: port.source,
          }),
          { mode: 0o600 },
        );
        await update((w) => {
          const current = w.lanes[index];
          current.startupIntentPath = intentPath;
          current.startupNonce = nonce;
        });
        currentLane = currentWorkflow.lanes[index];
      }
      if (!currentLane.resumeTabCreateAttemptedAt) {
        stage = "resume-tab-create";
        await update((w) => {
          w.lanes[index].resumeTabCreateAttemptedAt = new Date().toISOString();
        });
        const created = await port.run(
          [
            "tab",
            "create",
            "--workspace",
            workspaceId,
            "--cwd",
            recordedWorktree,
            "--label",
            laneTabLabel(currentLane.objective ?? currentLane.id),
            "--env",
            `BAA_STARTUP_INTENT=${currentLane.startupIntentPath}`,
            "--no-focus",
          ],
          signal,
        );
        const result = created.result ?? created;
        const tab = result.tab;
        const pane = result.root_pane;
        if (
          !tab?.tab_id ||
          !pane?.pane_id ||
          (tab.workspace_id && tab.workspace_id !== workspaceId) ||
          (pane.workspace_id && pane.workspace_id !== workspaceId)
        )
          throw new Error(
            `Resumed lane ${currentLane.id} tab response lacks a matching task workspace/pane binding.`,
          );
        const live = await port.run(["pane", "get", pane.pane_id], signal);
        const details = (live.result ?? live).pane;
        if (
          details?.workspace_id !== workspaceId ||
          details?.tab_id !== tab.tab_id ||
          details?.pane_id !== pane.pane_id
        )
          throw new Error("Created resume lane is outside its designated task workspace.");
        await update((w) => {
          const current = w.lanes[index];
          current.paneId = pane.pane_id;
          current.tabId = tab.tab_id;
          current.agentName ??= childAgentName(w.id, index + 1);
          w.ownership.tabIds ??= [];
          w.ownership.tabIds.push(tab.tab_id);
          w.ownership.paneIds.push(pane.pane_id);
        });
      } else if (!currentLane.paneId || !currentLane.tabId) {
        throw new Error(
          `Lane ${currentLane.id} resume tab creation outcome is uncertain; inspect before retrying.`,
        );
      } else {
        const live = await port.run(["pane", "get", currentLane.paneId], signal);
        const details = (live.result ?? live).pane;
        if (
          details?.workspace_id !== workspaceId ||
          details?.tab_id !== currentLane.tabId ||
          details?.pane_id !== currentLane.paneId
        )
          throw new Error("Recorded resume pane is outside its designated task workspace.");
      }
    }
    await update((w) => {
      for (const info of infos) {
        const current = w.lanes[info.index];
        if (current.resume) current.resume.status = "starting";
      }
    });
    await port.register(currentWorkflow, { allowLaneRebind: true });

    for (const info of infos) {
      const {
        index,
        profile,
        adapter,
        sessionId,
        resumeSessionId,
        resumeArguments,
      } = info;
      let lane = currentWorkflow.lanes[index];
      const intent = JSON.parse(await readFile(lane.startupIntentPath!, "utf8"));
      const intentProfile = validateLaunchProfile(
        intent.profile,
        `Lane ${lane.id} resume startup intent profile`,
      );
      if (
        JSON.stringify(intentProfile) !== JSON.stringify(profile) ||
        intent.incarnationId !== lane.resume?.incarnationId ||
        intent.resumeSessionId !== sessionId
      )
        throw new Error(`Lane ${lane.id} resume startup intent is not bound to its exact session/profile.`);

      let rawAgent: any = null;
      try {
        rawAgent = await port.run(["agent", "get", lane.paneId!], signal);
      } catch (error) {
        if (!/agent_not_found/.test(String(error))) throw error;
      }
      if (rawAgent) {
        const occupied = nativeAgent(rawAgent);
        if (
          !occupied ||
          occupied.agent !== lane.agentKind ||
          occupied.pane_id !== lane.paneId ||
          occupied.workspace_id !== workspaceId
        )
          throw new Error(`Lane ${lane.id} resume pane is occupied by an unrelated agent.`);
      }
      if (lane.resumeAgentStartAttemptedAt && !rawAgent) {
        const priorReady = await readFile(`${lane.startupIntentPath}.ready`, "utf8")
          .then((text) => JSON.parse(text))
          .catch(() => null);
        if (priorReady)
          throw new Error(
            `Lane ${lane.id} resume agent vanished after startup attestation; inspect before retrying.`,
          );
        await update((w) => {
          delete w.lanes[index].resumeAgentStartAttemptedAt;
        });
        lane = currentWorkflow.lanes[index];
      }
      if (!lane.resumeAgentStartAttemptedAt) {
        stage = "resume-agent-start";
        await update((w) => {
          w.lanes[index].resumeAgentStartAttemptedAt = new Date().toISOString();
        });
        await waitForShellReady(port, lane.paneId!, signal);
        const argumentsForResume = resumeArguments(
          profile,
          info.session,
          port.source,
          { startupIntentPath: lane.startupIntentPath },
        );
        await port.run(
          [
            "agent",
            "start",
            lane.agentName!,
            "--kind",
            lane.agentKind,
            "--pane",
            lane.paneId!,
            "--timeout",
            "60000",
            "--",
            ...argumentsForResume,
          ],
          signal,
          65_000,
        );
        await update((w) => {
          w.lanes[index].agentStartedAt = new Date().toISOString();
        });
        lane = currentWorkflow.lanes[index];
      }
      const startupHandshake = adapter.startupHandshake;
      if (startupHandshake !== undefined && !lane.resumeStartupHandshakeSentAt) {
        if (lane.resumeStartupHandshakeAttemptedAt)
          throw new Error("Resume startup handshake submission is uncertain; do not repeat terminal input.");
        stage = "resume-startup-handshake";
        await update((w) => {
          w.lanes[index].resumeStartupHandshakeAttemptedAt = new Date().toISOString();
        });
        await port.run(["agent", "prompt", lane.paneId!, startupHandshake], signal);
        await update((w) => {
          w.lanes[index].resumeStartupHandshakeSentAt = new Date().toISOString();
        });
        lane = currentWorkflow.lanes[index];
      }
      stage = "resume-startup-proof";
      const raw = await port.run(["agent", "get", lane.paneId!], signal);
      const agent = nativeAgent(raw);
      let hello: any = null;
      const deadline = Date.now() + 90_000;
      const complete = (value: unknown) => adapter.attestationComplete?.(value) ?? true;
      while (Date.now() < deadline) {
        hello = await readFile(`${lane.startupIntentPath}.ready`, "utf8")
          .then((text) => JSON.parse(text))
          .catch(() => null);
        if (hello && complete(hello)) break;
        await delay(500, { signal });
      }
      if (!hello || !complete(hello))
        throw new Error(`Lane ${lane.id} resume startup attestation is incomplete; native reattachment is refused.`);
      const proof = adapter.verifyStartup(agent, hello);
      const proofPersistence = toPersistenceHandle(
        proof.persistence ?? proof.session,
        profile.provider,
      );
      if (
        proofPersistence.provider !== profile.provider ||
        proofPersistence.provider !== info.session.provider
      )
        throw new Error(
          `Lane ${lane.id} startup proof reports provider ${proofPersistence.provider}, not its persisted ${info.session.provider} session; native resume is refused.`,
        );
      const proofSessionId = resumeSessionId(proofPersistence);
      if (
        agent?.pane_id !== lane.paneId ||
        agent?.workspace_id !== workspaceId ||
        agent?.agent !== lane.agentKind ||
        proof.paneId !== lane.paneId ||
        proof.workspaceId !== workspaceId ||
        proof.nonce !== lane.startupNonce ||
        proof.source !== port.source ||
        JSON.stringify(proof.profile) !== JSON.stringify(profile) ||
        proofSessionId !== sessionId ||
        !STARTUP_PROOF_REQUIRED_OPERATIONS.every((operation) =>
          proof.operations?.includes(operation),
        )
      )
        throw new Error(
          `Lane ${lane.id} native resume startup proof does not match its exact persisted session; no reattachment was recorded.`,
        );
      const incarnationStartedAt = new Date().toISOString();
      await update((w) => {
        const current = w.lanes[index];
        current.nativeSession = proof.session;
        current.persistenceHandle = proofPersistence;
        current.incarnationStartedAt = incarnationStartedAt;
        current.sessionLog = {
          ...current.sessionLog!,
          sessionRef: proofPersistence,
          startedAt: current.sessionLog!.startedAt,
          incarnationStartedAt,
          status: "dispatched",
          paneId: current.paneId,
          tabId: current.tabId,
          workspaceId,
          worktree: info.lane.sessionLog?.worktree ?? w.worktree ?? w.cwd,
        };
        current.resume!.status = "bound";
        current.status = "agent-ready";
        if (proof.session.kind === "path") {
          current.agentSessionPath = proof.session.value;
          delete current.agentSessionId;
        } else {
          current.agentSessionId = proof.session.value;
          delete current.agentSessionPath;
        }
        w.evidence.push({
          at: incarnationStartedAt,
          kind: "native-session-resumed",
          text: `Lane ${current.id} reattached to ${sessionId} in pane ${current.paneId}.`,
        });
      });
      currentWorkflow = await port.update(currentWorkflow.id, (w) => {
        w.status = "running";
        w.outcome = "running";
      });
    }
    return { resumed: true, workflow: currentWorkflow, resumedLanes: infos.map(({ lane, sessionId }) => ({ laneId: lane.id, sessionId })) };
  } catch (error) {
    if (!staleSnapshot) {
      try {
        await update((w) => {
          w.status = "resume-failed";
          w.outcome = "unknown";
          w.evidence.push({
            at: new Date().toISOString(),
            kind: "native-session-resume-error",
            text: `${stage}: ${error}`,
          });
        });
      } catch {
        // Preserve the original failure if the manifest itself became unavailable.
      }
    }
    throw error;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
