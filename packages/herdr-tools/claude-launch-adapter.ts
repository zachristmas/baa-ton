import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LaunchProfile } from "./launch-profile.js";
import type { PersistenceHandle } from "./contract.js";
import {
  PROTOCOL_OPERATIONS,
  STARTUP_PROOF_REQUIRED_OPERATIONS,
  type HarnessLaunchAdapter,
  type LaunchContext,
  type ProtocolOperation,
  type StartupProof,
} from "./harness-adapter.js";

export const CLAUDE_PROVIDER = "claude-code";
export const CLAUDE_PERMISSION_PROMPT_TOOL =
  "mcp__herdr-orchestrator__herdr_permission_prompt";

export type ClaudeAdapterPaths = {
  /** Absolute path to the shared stdio MCP bridge. */
  bridge: string;
  /** Absolute path to the SessionStart attestation helper. */
  attestHelper: string;
  /** Writable directory for generated launch configuration files. */
  scratchDirectory: string;
  /**
   * Optional Claude permission broker tool. Omitted by default so ordinary
   * Claude launches keep their native permission flow.
   */
  permissionPromptTool?: string | false;
};

function claudeBinaryCandidates(
  platform: NodeJS.Platform | string,
  pathExt = process.env.PATHEXT,
): string[] {
  if (platform !== "win32") return ["claude"];
  const extensions = (pathExt ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => /^\.[a-z0-9]+$/.test(extension));
  return [
    ...new Set([
      ...extensions.map((extension) => `claude${extension}`),
      "claude.exe",
      "claude.cmd",
      "claude",
    ]),
  ];
}

export function claudeBinaryAvailable(options: {
  platform?: NodeJS.Platform | string;
  pathValue?: string;
  pathExt?: string;
  fileExists?: (path: string) => boolean;
} = {}): boolean {
  const platform = options.platform ?? process.platform;
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const fileExists = options.fileExists ?? existsSync;
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const candidates = claudeBinaryCandidates(platform, options.pathExt);
  for (const entry of pathValue.split(pathDelimiter)) {
    if (
      entry &&
      candidates.some((name) => fileExists(join(resolve(entry), name)))
    )
      return true;
  }
  return false;
}

function claudeResumeSessionId(session: PersistenceHandle): string {
  const metadataId = session.metadata?.sessionId;
  if (typeof metadataId === "string" && metadataId) return metadataId;
  const native = session.nativeHandle;
  if (
    native &&
    typeof native === "object" &&
    (native as { kind?: unknown }).kind === "id" &&
    typeof (native as { value?: unknown }).value === "string" &&
    (native as { value: string }).value
  )
    return (native as { value: string }).value;
  // Older logs used the transcript path as PersistenceHandle.sessionId. A
  // path is not accepted by Claude's --resume flag, so fail closed rather
  // than silently choosing the most recent conversation.
  if (
    typeof session.sessionId === "string" &&
    session.sessionId &&
    !session.sessionId.includes("/")
  )
    return session.sessionId;
  throw new Error(
    "Claude native resume requires the persisted Claude session id; a transcript path alone is not a valid --resume target.",
  );
}

/** Conservative lane permissions: read/edit plus foreground test/build/git-read
 * and local commits. Push, merge, and PR creation stay denied — those are the
 * orchestrator's standing policy, not something a lane may self-grant. */
const LANE_PERMISSIONS = {
  allow: [
    "Read",
    "Edit",
    "Glob",
    "Grep",
    "Bash(node:*)",
    "Bash(npm test:*)",
    "Bash(npm run:*)",
    "Bash(npm install:*)",
    "Bash(npx tsc:*)",
    "Bash(tsc:*)",
    "Bash(env:*)",
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git add:*)",
    "Bash(git commit:*)",
    "Bash(ls:*)",
    "Bash(mkdir:*)",
    "Bash(cat:*)",
    "Bash(head:*)",
    "Bash(tail:*)",
    "Bash(wc:*)",
    "Bash(rg:*)",
    "Bash(grep:*)",
    "Bash(sed:*)",
    // Without these, a dispatched lane's own contract (report via
    // herdr_message, file the one lane receipt via herdr_complete) is
    // impossible to fulfil unattended: Claude Code prompts for permission
    // on every MCP tool call not in this allow-list, and nobody is present
    // to answer it for a headless dispatched lane.
    "mcp__herdr-orchestrator__herdr_message",
    "mcp__herdr-orchestrator__herdr_complete",
    // Leases are enforced by the tool itself (own lane only, policy-gated).
    "mcp__herdr-orchestrator__herdr_lease",
    "mcp__herdr-orchestrator__herdr_request",
    "mcp__herdr-orchestrator__herdr_service",
  ],
  deny: [
    "Bash(git push:*)",
    "Bash(git merge:*)",
    "Bash(gh pr create:*)",
    "Bash(herdr workspace close:*)",
  ],
};

/** PermissionRequest hook that approves known-safe Bash commands. */
export const KNOWN_SAFE_HOOK = fileURLToPath(new URL("./known-safe-hook.mjs", import.meta.url));
/** Audit log of the hook's decisions, next to the manifest. */
export const KNOWN_SAFE_LOG = "known-safe-approvals.jsonl";
/** How long a routed prompt waits for the root before the normal prompt shows. */
export const PERMISSION_ROUTE_WAIT_SECONDS = 600;

/** Auto-mode classifier allow rule for a dispatched lane's Baa-ton tools. */
export const LANE_AUTO_MODE_ALLOW =
  "This session is a Baa-ton child lane dispatched by the user's registered root. Calling its herdr-orchestrator MCP tools (herdr_complete, herdr_message, herdr_request, herdr_lease, herdr_service, herdr_permission_prompt) to report this lane's own progress, receipt, questions and resource requests to that parent root is the assigned contract and is expected; it does not bypass auto mode, grant new authority or reach external services.";

function buildClaudeLaunchArguments(
  paths: ClaudeAdapterPaths,
  profile: LaunchProfile,
  context?: LaunchContext,
): string[] {
  const intentPath = context?.startupIntentPath;
  if (!intentPath)
    throw new Error("Claude launch requires the startup intent path.");
  mkdirSync(paths.scratchDirectory, { recursive: true, mode: 0o700 });
  const tag = randomUUID().slice(0, 8);
  const settingsPath = join(
    paths.scratchDirectory,
    `claude-settings-${tag}.json`,
  );
  const mcpConfigPath = join(
    paths.scratchDirectory,
    `claude-mcp-${tag}.json`,
  );
  // --strict-mcp-config below makes this file the lane's *entire* MCP
  // surface, deliberately excluding every other configured server
  // (including claude.ai account connectors) for headless-lane determinism.
  // A lane that genuinely needs one, e.g. a domain MCP tool, gets it only
  // via an explicit extraMcpServers grant from the authorized root, never
  // by silently inheriting the operator's full config.
  const extraMcpServers = { ...(context?.extraMcpServers ?? {}) };
  delete extraMcpServers["herdr-orchestrator"];
  const extraServerKeys = Object.keys(extraMcpServers);
  const settings = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: `node ${JSON.stringify(paths.attestHelper)}`,
            },
          ],
        },
      ],
      // Answer permission prompts without a person at the pane: approve
      // commands the known-safe classifier accepts (temp-file cleanup,
      // feature-branch setup), and route everything else to the root as a
      // lane request, waiting a bounded time for its answer. This must be a
      // PermissionRequest hook: a PreToolUse "allow" does not override an
      // ask rule in the operator's settings, a PermissionRequest decision
      // does, and --permission-prompt-tool only applies to `-p` runs. Deny
      // rules still apply; on timeout the normal prompt shows.
      PermissionRequest: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: [
                `node ${JSON.stringify(KNOWN_SAFE_HOOK)}`,
                `--log ${JSON.stringify(join(paths.scratchDirectory, KNOWN_SAFE_LOG))}`,
                `--bridge ${JSON.stringify(paths.bridge)}`,
                `--intent ${JSON.stringify(intentPath)}`,
                `--wait-seconds ${PERMISSION_ROUTE_WAIT_SECONDS}`,
              ].join(" "),
              timeout: PERMISSION_ROUTE_WAIT_SECONDS + 60,
            },
          ],
        },
      ],
    },
    permissions: {
      ...LANE_PERMISSIONS,
      // A headless lane has nobody to answer a permission prompt. A granted
      // extra server's tools must be pre-allowed the same way the two fixed
      // herdr-orchestrator tools below already are, or every call hangs.
      allow: [
        ...LANE_PERMISSIONS.allow,
        ...extraServerKeys.map((key) => `mcp__${key}__*`),
      ],
    },
    // A lane inherits the user's default permission mode. In auto mode the
    // classifier reviews every tool call, and it denied a lane's own
    // herdr_complete/herdr_message as "Auto-Mode Bypass", so the result never
    // reached the root. These calls are the lane's assigned contract (report
    // to its parent, ask for leases and approvals), so say so to the
    // classifier while keeping its built-in rules.
    autoMode: {
      allow: ["$defaults", LANE_AUTO_MODE_ALLOW],
    },
  };
  const mcpConfig = {
    mcpServers: {
      ...extraMcpServers,
      "herdr-orchestrator": {
        command: "node",
        args: [paths.bridge],
        // Claude Code does not reliably inherit the Herdr pane environment
        // into stdio MCP children. Pass the startup contract explicitly so
        // mcp-server.mjs can publish the bridge's protocol operations before
        // the SessionStart identity attestation is verified.
        env: {
          BAA_STARTUP_INTENT: intentPath,
          HERDR_ENV: "1",
        },
      },
    },
  };
  writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), { mode: 0o600 });
  const args = [
    "--model",
    profile.model,
    "--effort",
    profile.thinking,
    "--settings",
    settingsPath,
    "--mcp-config",
    mcpConfigPath,
    "--strict-mcp-config",
  ];
  const permissionPromptTool =
    paths.permissionPromptTool === undefined
      ? process.env.BAA_CLAUDE_PERMISSION_PROMPT_TOOL === "1"
        ? CLAUDE_PERMISSION_PROMPT_TOOL
        : undefined
      : paths.permissionPromptTool;
  if (permissionPromptTool !== undefined && permissionPromptTool !== false) {
    if (
      typeof permissionPromptTool !== "string" ||
      permissionPromptTool.trim() === ""
    )
      throw new Error(
        "permissionPromptTool must be a non-empty string when enabled.",
      );
    args.push("--permission-prompt-tool", permissionPromptTool);
  }
  return args;
}

export function claudeLaunchAdapter(
  paths: ClaudeAdapterPaths,
): HarnessLaunchAdapter {
  return {
    version: 1,
    kind: "claude",
    capabilities: {
      startupAttestation: true,
      supportsSessionPersistence: true,
      supportsNativeSessionIdentity: true,
      supportsSessionResume: true,
      // Claude Code has no stable machine-readable live model/auth catalog API
      // at this adapter boundary; startup validity is still fail-closed.
      supportsLiveCapabilityDiscovery: false,
      // SessionStart emits the startup proof without a first turn. Do not send
      // an unnecessary prompt or imply that a handshake is supported.
      supportsStartupHandshake: false,
    },
    // Claude may start stdio MCP servers lazily. Do not accept the
    // SessionStart identity half as a complete proof before the bridge's
    // protocol contract has also been attested by the hook or MCP process.
    attestationComplete(attestation: unknown): boolean {
      const hello = attestation as {
        sessionPath?: unknown;
        sessionId?: unknown;
        operations?: unknown;
      };
      const operations = Array.isArray(hello?.operations)
        ? hello.operations.filter(
            (operation): operation is string => typeof operation === "string",
          )
        : [];
      return (
        (typeof hello?.sessionPath === "string" ||
          typeof hello?.sessionId === "string") &&
        STARTUP_PROOF_REQUIRED_OPERATIONS.every((operation) =>
          operations.includes(operation),
        )
      );
    },
    // Honest capability reporting: Herdr's Claude integration exposes session
    // identity, but lifecycle state is screen-derived, not native.
    lifecycle: "screen",
    preflight(profile: LaunchProfile): void {
      if (profile.provider !== CLAUDE_PROVIDER)
        throw new Error(
          "Only the claude-code subscription launch adapter is qualified in this prerequisite.",
        );
      if (!profile.model)
        throw new Error("Exact model id is required; no alias substitution.");
      if (!claudeBinaryAvailable())
        throw new Error(
          "claude CLI not found on PATH; install and authenticate Claude Code before dispatch.",
        );
      // Claude Code's --effort ladder matches our thinking vocabulary exactly.
      // Model validity is proven by runtime attestation: an unknown model makes
      // claude exit before its SessionStart hook writes the handshake, so
      // dispatch fails closed rather than silently substituting a model.
    },
    launchArguments: (profile, _source, context) =>
      buildClaudeLaunchArguments(paths, profile, context),
    resumeSessionId: claudeResumeSessionId,
    resumeArguments: (profile, session, _source, context) => [
      "--resume",
      claudeResumeSessionId(session),
      ...buildClaudeLaunchArguments(paths, profile, context),
    ],
    verifyStartup(nativeAgent: unknown, attestation: unknown): StartupProof {
      const agent = nativeAgent as {
        agent?: string;
        pane_id?: string;
        workspace_id?: string;
        agent_session?: { kind?: string; value?: string };
      };
      const hello = attestation as {
        paneId?: string;
        workspaceId?: string;
        nonce?: string;
        source?: string;
        profile?: LaunchProfile;
        operations?: string[];
        sessionPath?: string;
        sessionId?: string;
      };
      if (!agent || !hello || agent.agent !== "claude")
        throw new Error("Claude native identity mismatch; no work assigned.");
      const kind = agent.agent_session?.kind;
      const value = agent.agent_session?.value;
      if (kind !== "path" && kind !== "id")
        throw new Error(
          "Claude native session reference missing; no work assigned.",
        );
      if (typeof value !== "string" || !value)
        throw new Error(
          "Claude native session reference missing; no work assigned.",
        );
      const attested = kind === "path" ? hello.sessionPath : hello.sessionId;
      if (attested !== value)
        throw new Error(
          "Claude session attestation does not match native identity; no work assigned.",
        );
      if (
        agent.pane_id !== hello.paneId ||
        agent.workspace_id !== hello.workspaceId
      )
        throw new Error("Claude startup binding mismatch; no work assigned.");
      const knownOperations = new Set<string>(
        Object.values(PROTOCOL_OPERATIONS),
      );
      const operations = (hello.operations ?? []).filter(
        (operation): operation is ProtocolOperation =>
          typeof operation === "string" && knownOperations.has(operation),
      );
      return {
        paneId: hello.paneId!,
        workspaceId: hello.workspaceId!,
        nonce: hello.nonce!,
        source: hello.source!,
        profile: hello.profile!,
        operations,
        session: { kind, value },
        persistence: {
          provider: CLAUDE_PROVIDER,
          sessionId: hello.sessionId ?? value,
          nativeHandle: { kind, value },
          ...(hello.sessionPath || hello.sessionId
            ? {
                metadata: {
                  ...(hello.sessionId ? { sessionId: hello.sessionId } : {}),
                  ...(hello.sessionPath ? { sessionPath: hello.sessionPath } : {}),
                },
              }
            : {}),
        },
      };
    },
  };
}
