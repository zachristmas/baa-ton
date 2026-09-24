import type { LaunchProfile } from "./launch-profile.js";
import type {
  CapabilityCatalog,
  NativeSessionRef,
  PersistenceHandle,
} from "./contract.js";

export type {
  CapabilityCatalog,
  NativeSessionRef,
  PersistenceHandle,
} from "./contract.js";

export const PROTOCOL_OPERATIONS = {
  plan: "plan",
  dispatch: "dispatch",
  complete: "complete",
} as const;
export type ProtocolOperation =
  (typeof PROTOCOL_OPERATIONS)[keyof typeof PROTOCOL_OPERATIONS];

/** Operations every verified lane must expose before it can receive work. */
export const STARTUP_PROOF_REQUIRED_OPERATIONS = [
  PROTOCOL_OPERATIONS.plan,
  PROTOCOL_OPERATIONS.dispatch,
  PROTOCOL_OPERATIONS.complete,
] as const satisfies readonly ProtocolOperation[];

export type HarnessLifecycle = "native" | "screen" | "unavailable";

/**
 * Boolean capabilities are intentionally open-ended so a harness can publish
 * new provider features without changing this contract version. The lifecycle
 * tier is metadata rather than a boolean and stays explicit on the adapter.
 * Optional operation flags make an omitted optional operation deliberate:
 * `false` means unsupported (and must have a reason in the adapter audit), not
 * an accidental omission.
 */
export type HarnessCapabilityFlags = Record<string, boolean | undefined> & {
  startupAttestation: boolean;
  supportsSessionPersistence: boolean;
  /** Native exact-session reattachment is explicit; false is fail-closed. */
  supportsSessionResume?: boolean;
  supportsLiveCapabilityDiscovery?: boolean;
  supportsStartupHandshake?: boolean;
};

/** Arguments are appended after `herdr agent start ... --`. The adapter owns
 * the exact native invocation; callers must never invent provider flags. */
export type ResumeLaunchContext = LaunchContext;

export type ResumeLaunchAdapter = {
  /** Return the exact native identity accepted by the provider's resume CLI. */
  resumeSessionId(session: PersistenceHandle): string;
  /** Build native resume arguments, including any proof/config wiring. */
  resumeArguments(
    profile: LaunchProfile,
    session: PersistenceHandle,
    source: string,
    context?: ResumeLaunchContext,
  ): string[];
};

export type StartupProof = {
  paneId: string;
  workspaceId: string;
  nonce: string;
  source: string;
  profile: LaunchProfile;
  operations: ProtocolOperation[];
  /** Legacy native view; generalized persistence is stored alongside it. */
  session: NativeSessionRef;
  persistence?: PersistenceHandle;
};

/** Versioned boundary. No Pi context, TUI or screen-parser types in this contract. */
export interface HarnessLaunchAdapter {
  version: 1;
  kind: string;
  capabilities: HarnessCapabilityFlags;
  /** Honest lifecycle reporting: native, screen-derived, or unavailable. */
  lifecycle: HarnessLifecycle;
  /**
   * Optional live capability discovery. Implementations must not return a
   * static registry snapshot as a substitute when discovery fails.
   */
  discoverCatalog?(
    profile: LaunchProfile,
  ): CapabilityCatalog | Promise<CapabilityCatalog>;
  preflight(
    profile: LaunchProfile,
    discovered?: CapabilityCatalog,
  ): void | Promise<void>;
  /** Optional first turn needed to materialize lazy harness sessions. The
   * dispatcher submits this exact text after the native agent starts, with
   * the same durable terminal-input fence as assignment prompts. */
  startupHandshake?: string;
  /** Optional: when the harness's attestation is assembled from multiple
   * writers, reports whether it is complete enough to verify (identity plus
   * tool/operation evidence). Default: any parseable attestation. */
  attestationComplete?(attestation: unknown): boolean;
  launchArguments(
    profile: LaunchProfile,
    source: string,
    context?: LaunchContext,
  ): string[];
  /** Required when supportsSessionResume is true. Omission is unsupported,
   * never a guessed provider invocation. */
  resumeSessionId?: ResumeLaunchAdapter["resumeSessionId"];
  resumeArguments?: ResumeLaunchAdapter["resumeArguments"];
  /** Must compare native identity with the harness's startup attestation.
   * Screen-derived idle alone is never startup attestation. */
  verifyStartup(nativeAgent: unknown, attestation: unknown): StartupProof;
}

/*
 * SOURCE PARITY AUDIT
 *
 * Every operation in the version-1 adapter surface is either present or
 * explicitly unsupported below. `GAP-fixed-now` records work done by this
 * parity pass; an unsupported discovery operation is represented by the
 * adapter's `capabilities.supportsLiveCapabilityDiscovery: false`, with its
 * reason next to that declaration. The startup-handshake flag follows the
 * same rule for harnesses that do not need a first turn.
 *
 * | harness  | preflight  | launchArguments | verifyStartup | resumeArguments | startupHandshake                                      | discoverCatalog                                                    | capabilities flags |
 * | pi       | implemented | implemented     | implemented   | implemented (`pi --session <path|id>`) | explicitly unsupported (session_start is the proof) | implemented (live Pi model registry) | resume=true |
 * | codex    | implemented | implemented     | implemented   | implemented (`codex resume <session-id>`; `exec resume` is non-interactive) | implemented (READY turn) | explicitly unsupported (no stable live catalog API) | resume=true |
 * | claude   | implemented | implemented     | implemented   | implemented (`claude --resume <session-id>`) | explicitly unsupported (SessionStart) | explicitly unsupported (no stable live catalog API) | resume=true |
 * | opencode | implemented | implemented     | implemented   | implemented (`opencode --session <session-id>`) | implemented (READY turn) | explicitly unsupported (no authoritative live catalog) | resume=true |
 *
 * Resume support is a native provider operation, not `/goal-resume`. An
 * adapter that does not implement both resume methods is unsupported and the
 * root executor fails closed before topology mutation. See each adapter for
 * the exact invocation and fail-closed identity checks.
 */
export const REQUIRED_ADAPTER_CAPABILITIES = [
  "startupAttestation",
  "supportsSessionPersistence",
] as const;

/** Extra per-lane launch facts adapters may need. Optional so existing v1
 * adapters are unaffected; versioned with the contract. */
export type LaunchContext = {
  startupIntentPath?: string;
  /** Extra MCP servers (raw --mcp-config entries) a lane needs beyond the
   * harness's baseline. Adapters that scope their MCP config (e.g. Claude's
   * --strict-mcp-config) must merge these in; others may ignore the field. */
  extraMcpServers?: Record<string, unknown>;
  /** A spec integration lane: lift the harness's own ban on local merges
   * (push, PR and every other deny stay). */
  allowLocalMerge?: boolean;
};

export type RequiredAdapterCapability =
  (typeof REQUIRED_ADAPTER_CAPABILITIES)[number];

export function missingRequiredAdapterCapabilities(
  adapter: Pick<HarnessLaunchAdapter, "capabilities"> | undefined,
): RequiredAdapterCapability[] {
  if (!adapter?.capabilities) return [...REQUIRED_ADAPTER_CAPABILITIES];
  return REQUIRED_ADAPTER_CAPABILITIES.filter(
    (name) => adapter.capabilities[name] !== true,
  );
}

export class HarnessAdapterRegistry {
  private readonly adapters = new Map<string, HarnessLaunchAdapter>();
  register(adapter: HarnessLaunchAdapter): void {
    if (
      adapter.version !== 1 ||
      !adapter.kind ||
      this.adapters.has(adapter.kind)
    )
      throw new Error("Invalid or duplicate harness launch adapter.");
    this.adapters.set(adapter.kind, adapter);
  }
  resolve(kind: string): HarnessLaunchAdapter {
    const adapter = this.adapters.get(kind);
    const missing = missingRequiredAdapterCapabilities(adapter);
    if (!adapter || adapter.version !== 1 || missing.length > 0)
      throw new Error(
        `Harness ${kind} has no qualified startup adapter; detection support is not launch qualification${
          missing.length
            ? ` (missing required capability flags: ${missing.join(", ")})`
            : ""
        }.`,
      );
    return adapter;
  }
  capabilities() {
    return [...this.adapters.values()].map(
      ({ kind, version, capabilities, lifecycle }) => ({
        kind,
        version,
        ...capabilities,
        lifecycle,
      }),
    );
  }
}
