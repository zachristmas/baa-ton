import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapabilityCatalog } from "./contract.js";
import type { LaunchProfile } from "./launch-profile.js";
import {
  PROTOCOL_OPERATIONS,
  type HarnessLaunchAdapter,
  type ProtocolOperation,
  type StartupProof,
} from "./harness-adapter.js";

export const PI_CODEX_PROVIDER = "openai-codex";
export const PI_ZAI_PROVIDER = "zai";

const PI_TOOL_TO_PROTOCOL_OPERATION: Readonly<
  Record<string, ProtocolOperation>
> = {
  herdr_plan: PROTOCOL_OPERATIONS.plan,
  herdr_dispatch: PROTOCOL_OPERATIONS.dispatch,
  herdr_complete: PROTOCOL_OPERATIONS.complete,
};

/** Convert Pi's exposed tool names at the process boundary to neutral operations. */
export function mapPiToolNamesToProtocolOperations(
  toolNames: unknown,
): ProtocolOperation[] {
  if (!Array.isArray(toolNames)) return [];
  const operations = new Set<ProtocolOperation>();
  for (const toolName of toolNames) {
    if (typeof toolName !== "string") continue;
    const operation = PI_TOOL_TO_PROTOCOL_OPERATION[toolName];
    if (operation) operations.add(operation);
  }
  return [...operations];
}

const LIVE_DISCOVERY_SOURCE = "pi.modelRegistry.live-provider-refresh.v1";

type DiscoveryDetails = {
  reasoning: boolean;
  explicitlyUnsupportedThinking: boolean;
};
type DiscoveryResult = {
  catalog: CapabilityCatalog;
  details: DiscoveryDetails;
};

type ModelRegistryLike = NonNullable<ExtensionContext["modelRegistry"]> & {
  refresh?: (options?: { providers?: readonly string[] }) => Promise<unknown>;
};

/**
 * Return the cache identity documented by CapabilityCatalog. Keep this helper
 * exported so bridge and adapter tests can prove that resolvedAt and the
 * enumerated options do not accidentally become cache identity.
 */
export function capabilityCatalogCacheKey(
  catalog: Pick<CapabilityCatalog, "provider" | "model" | "auth" | "source">,
): string {
  const identity = JSON.stringify({
    provider: catalog.provider,
    model: catalog.model,
    auth: {
      subscriptionConfigured: catalog.auth.subscriptionConfigured,
      usingOAuth: catalog.auth.usingOAuth,
    },
    source: catalog.source,
  });
  return `sha256:${createHash("sha256").update(identity, "utf8").digest("hex")}`;
}

function stringOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((item): item is string => typeof item === "string")),
  ].sort();
}

function discoveryError(profile: LaunchProfile, detail: unknown): Error {
  const message = detail instanceof Error ? detail.message : String(detail);
  return new Error(
    `Capability discovery failed for ${profile.provider}/${profile.model}: ${message}`,
  );
}

function providerRefreshError(result: any, provider: string): unknown {
  const errors = result?.errors;
  if (errors instanceof Map) return errors.get(provider);
  if (errors && typeof errors === "object") return errors[provider];
  return undefined;
}

async function discoverPiCatalog(
  profile: LaunchProfile,
  ctx: ExtensionContext,
): Promise<DiscoveryResult> {
  if (
    profile.provider !== PI_CODEX_PROVIDER &&
    profile.provider !== PI_ZAI_PROVIDER
  )
    throw new Error(
      "Only the openai-codex OAuth or zai Coding Plan Pi launch adapter is qualified.",
    );
  const registry = ctx.modelRegistry as ModelRegistryLike | undefined;
  if (!registry || typeof registry.refresh !== "function")
    throw discoveryError(
      profile,
      "the live model registry refresh operation is unavailable; refusing a static registry snapshot",
    );

  let refreshed: any;
  try {
    // A provider-scoped refresh is the live runtime boundary. In particular,
    // do not read find() until this completes and never use a prior snapshot
    // when it reports an error.
    refreshed = await registry.refresh({ providers: [profile.provider] });
  } catch (error) {
    throw discoveryError(profile, error);
  }
  const refreshFailure = providerRefreshError(refreshed, profile.provider);
  if (refreshFailure)
    throw discoveryError(profile, refreshFailure);
  if (refreshed?.aborted)
    throw discoveryError(profile, "the live provider refresh was aborted");

  let model: any;
  try {
    model = registry.find(profile.provider, profile.model);
  } catch (error) {
    throw discoveryError(profile, error);
  }
  if (!model)
    throw discoveryError(
      profile,
      `Exact installed model not found in the live provider runtime`,
    );
  if (
    typeof registry.hasConfiguredAuth !== "function" ||
    typeof registry.isUsingOAuth !== "function"
  )
    throw discoveryError(
      profile,
      "live authentication state is unavailable; refusing to guess the billing route",
    );

  let subscriptionConfigured: boolean;
  let usingOAuth: boolean;
  try {
    subscriptionConfigured = Boolean(registry.hasConfiguredAuth(model));
    usingOAuth = Boolean(registry.isUsingOAuth(model));
  } catch (error) {
    throw discoveryError(profile, error);
  }
  const map = model.thinkingLevelMap;
  const thinkingOptions = Object.keys(map ?? {}).filter(
    (level) => map[level] !== null,
  );
  const modes = stringOptions(model.modes);
  const catalog: CapabilityCatalog = {
    provider: profile.provider,
    model: profile.model,
    thinkingOptions: stringOptions(thinkingOptions),
    ...(modes.length ? { modes } : {}),
    auth: { subscriptionConfigured, usingOAuth },
    resolvedAt: new Date().toISOString(),
    cacheKey: capabilityCatalogCacheKey({
      provider: profile.provider,
      model: profile.model,
      auth: { subscriptionConfigured, usingOAuth },
      source: LIVE_DISCOVERY_SOURCE,
    }),
    source: LIVE_DISCOVERY_SOURCE,
  };
  return {
    catalog,
    details: {
      reasoning: Boolean(model.reasoning),
      explicitlyUnsupportedThinking:
        map?.[profile.thinking] === null,
    },
  };
}

function validateCatalog(
  profile: LaunchProfile,
  catalog: CapabilityCatalog,
  details: DiscoveryDetails,
): void {
  if (
    catalog.provider !== profile.provider ||
    catalog.model !== profile.model ||
    catalog.source !== LIVE_DISCOVERY_SOURCE ||
    catalog.cacheKey !== capabilityCatalogCacheKey(catalog)
  )
    throw new Error(
      "Capability discovery cache key does not match the current provider/model/auth/source inputs; refusing stale discovery.",
    );
  // Empirically settled by a 2026-09-15 live probe: Pi and the backend
  // accept thinking levels absent from the catalog map (gpt-5.6-luna served
  // a turn at "high" though its map lists only minimal/xhigh/max). The map is
  // an enumeration for UI cycling, not a support boundary. Only an explicit
  // null entry declares a level unsupported; absent levels are trusted to
  // runtime attestation, which fails the startup handshake unless the session
  // actually reports the requested level.
  if (
    (!details.reasoning && profile.thinking !== "off") ||
    details.explicitlyUnsupportedThinking
  )
    throw new Error(
      `Thinking level ${profile.thinking} is unsupported by ${profile.model}.`,
    );
  const authAccepted =
    catalog.auth.subscriptionConfigured &&
    (profile.provider === PI_CODEX_PROVIDER
      ? catalog.auth.usingOAuth
      : profile.provider === PI_ZAI_PROVIDER
        ? !catalog.auth.usingOAuth
        : false);
  if (!authAccepted)
    throw new Error(
      profile.provider === PI_ZAI_PROVIDER
        ? catalog.auth.subscriptionConfigured
          ? "ZAI Coding Plan requires configured non-OAuth authentication; OAuth is forbidden."
          : "Requested ZAI Coding Plan authentication is not configured; OAuth is forbidden."
        : "Requested subscription authentication is not configured; API-key fallback is forbidden.",
    );
}

export async function verifyAvailableProfile(
  profile: LaunchProfile,
  ctx: ExtensionContext,
): Promise<void> {
  const result = await discoverPiCatalog(profile, ctx);
  validateCatalog(profile, result.catalog, result.details);
}

export async function verifyActualProfile(
  profile: LaunchProfile,
  ctx: ExtensionContext,
): Promise<void> {
  await verifyAvailableProfile(profile, ctx);
  if (
    ctx.model?.provider !== profile.provider ||
    ctx.model?.id !== profile.model ||
    ctx.thinkingLevel !== profile.thinking
  )
    throw new Error(
      "Startup provider/model/thinking mismatch; no assignment may be delivered.",
    );
}

export function piLaunchAdapter(
  ctx: ExtensionContext,
  nativeIntegration: string,
): HarnessLaunchAdapter {
  const discoveryDetails = new Map<string, DiscoveryDetails>();
  const discoverCatalog = async (
    profile: LaunchProfile,
  ): Promise<CapabilityCatalog> => {
    const result = await discoverPiCatalog(profile, ctx);
    discoveryDetails.set(result.catalog.cacheKey, result.details);
    return result.catalog;
  };
  const launchArguments = (profile: LaunchProfile, source: string): string[] => [
    "--provider",
    profile.provider,
    "--model",
    profile.model,
    "--thinking",
    profile.thinking,
    "--no-extensions",
    "-e",
    nativeIntegration,
    "-e",
    source,
  ];
  const resumeSessionId = (session: import("./contract.js").PersistenceHandle): string => {
    if (!session || typeof session.sessionId !== "string" || !session.sessionId)
      throw new Error("Pi native resume requires a persisted session path or id.");
    return session.sessionId;
  };
  return {
    version: 1,
    kind: "pi",
    capabilities: {
      startupAttestation: true,
      supportsSessionPersistence: true,
      supportsNativeSessionIdentity: true,
      supportsSessionResume: true,
      supportsStartupHandshake: false,
    },
    lifecycle: "native",
    discoverCatalog,
    preflight: async (profile, discovered) => {
      let catalog = discovered;
      let details = catalog ? discoveryDetails.get(catalog.cacheKey) : undefined;
      if (catalog) {
        if (
          catalog.provider !== profile.provider ||
          catalog.model !== profile.model ||
          catalog.source !== LIVE_DISCOVERY_SOURCE ||
          catalog.cacheKey !== capabilityCatalogCacheKey(catalog)
        )
          throw new Error(
            "Capability discovery cache key does not match the current provider/model/auth/source inputs; refusing stale discovery.",
          );
        // A catalog supplied by an unrelated adapter or an older adapter
        // incarnation is not trusted merely because its shape looks valid.
        // Re-discover and compare identities before using it as a cache hit.
        if (!details) {
          const fresh = await discoverCatalog(profile);
          if (fresh.cacheKey !== catalog.cacheKey)
            throw new Error(
              "Capability discovery cache key does not match the current live inputs; refusing stale discovery.",
            );
          catalog = fresh;
          details = discoveryDetails.get(catalog.cacheKey);
        }
      } else {
        catalog = await discoverCatalog(profile);
        details = discoveryDetails.get(catalog.cacheKey);
      }
      validateCatalog(profile, catalog, details!);
    },
    launchArguments,
    resumeSessionId,
    resumeArguments: (profile, session, source) => [
      "--session",
      resumeSessionId(session),
      ...launchArguments(profile, source),
    ],
    verifyStartup(nativeAgent: unknown, attestation: unknown): StartupProof {
      const agent = nativeAgent as {
        agent?: string;
        pane_id?: string;
        workspace_id?: string;
        agent_session?: { kind?: string; value?: string };
      };
      const hello = attestation as {
        paneId: string;
        workspaceId: string;
        nonce: string;
        source: string;
        profile: LaunchProfile;
        tools?: unknown;
        sessionPath?: unknown;
      };
      if (
        !agent ||
        !hello ||
        agent.agent !== "pi" ||
        agent.agent_session?.kind !== "path" ||
        typeof hello.sessionPath !== "string" ||
        agent.agent_session.value !== hello.sessionPath ||
        agent.pane_id !== hello.paneId ||
        agent.workspace_id !== hello.workspaceId
      )
        throw new Error(
          "Pi native-session/startup attestation mismatch; no work assigned.",
        );
      return {
        paneId: hello.paneId,
        workspaceId: hello.workspaceId,
        nonce: hello.nonce,
        source: hello.source,
        profile: hello.profile,
        operations: mapPiToolNamesToProtocolOperations(hello.tools),
        session: { kind: "path", value: hello.sessionPath },
        persistence: {
          provider: hello.profile.provider,
          sessionId: hello.sessionPath,
          nativeHandle: { kind: "path", value: hello.sessionPath },
        },
      };
    },
  };
}
