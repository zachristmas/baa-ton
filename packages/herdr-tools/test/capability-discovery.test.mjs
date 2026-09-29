import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const {
  capabilityCatalogCacheKey,
  PI_CODEX_PROVIDER,
  PI_ZAI_PROVIDER,
  piLaunchAdapter,
  verifyAvailableProfile,
} = await jiti.import("../pi-launch-adapter.ts");

const profile = {
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  thinking: "high",
  auth: "subscription",
};

function context({ thinkingLevelMap, oauth = true, configured = true, refresh } = {}) {
  const model = {
    reasoning: true,
    thinkingLevelMap: thinkingLevelMap ?? {
      minimal: "minimal",
      xhigh: "xhigh",
      max: "max",
    },
  };
  return {
    modelRegistry: {
      refresh: refresh ?? (async () => ({ errors: new Map() })),
      find: () => model,
      hasConfiguredAuth: () => configured,
      isUsingOAuth: () => oauth,
    },
  };
}

test("live capability cache keys are deterministic and include model/auth identity", async () => {
  const ctx = context();
  const adapter = piLaunchAdapter(ctx, "/native/pi.ts");
  const first = await adapter.discoverCatalog(profile);
  const second = await adapter.discoverCatalog(profile);
  assert.equal(first.cacheKey, second.cacheKey);
  assert.equal(
    first.cacheKey,
    capabilityCatalogCacheKey(first),
    "cacheKey is the documented canonical identity",
  );
  assert.equal(first.thinkingOptions.includes("high"), false);

  const otherModel = await adapter.discoverCatalog({
    ...profile,
    model: "gpt-5.6-other",
  });
  assert.notEqual(first.cacheKey, otherModel.cacheKey);

  const otherAuth = await piLaunchAdapter(
    context({ oauth: false }),
    "/native/pi.ts",
  ).discoverCatalog(profile);
  assert.notEqual(first.cacheKey, otherAuth.cacheKey);
});

test("explicit null rejects while an absent thinking level remains trusted to runtime attestation", async () => {
  await assert.rejects(
    verifyAvailableProfile(
      profile,
      context({ thinkingLevelMap: { high: null } }),
    ),
    /Thinking level high is unsupported/,
  );
  await assert.doesNotReject(
    verifyAvailableProfile(
      profile,
      context({
        thinkingLevelMap: { minimal: "minimal", xhigh: "xhigh", max: "max" },
      }),
    ),
  );
});

const zaiProfile = {
  provider: PI_ZAI_PROVIDER,
  model: "glm-5.3-flash",
  thinking: "low",
  auth: "subscription",
};

test("ZAI Coding Plan accepts configured non-OAuth auth only", async () => {
  const catalog = await piLaunchAdapter(
    context({ oauth: false }),
    "/native/pi.ts",
  ).discoverCatalog(zaiProfile);
  assert.equal(catalog.provider, PI_ZAI_PROVIDER);
  assert.equal(catalog.auth.subscriptionConfigured, true);
  assert.equal(catalog.auth.usingOAuth, false);
  await assert.doesNotReject(
    verifyAvailableProfile(zaiProfile, context({ oauth: false })),
  );
  await assert.rejects(
    verifyAvailableProfile(zaiProfile, context({ oauth: true })),
    /ZAI Coding Plan.*OAuth is forbidden/,
  );
  await assert.rejects(
    verifyAvailableProfile(
      zaiProfile,
      context({ oauth: false, configured: false }),
    ),
    /ZAI Coding Plan authentication is not configured/,
  );
});

test("OpenAI Codex still requires OAuth and unknown Pi providers remain unsupported", async () => {
  await assert.rejects(
    verifyAvailableProfile(profile, context({ oauth: false })),
    /Requested subscription authentication.*API-key fallback is forbidden/,
  );
  await assert.rejects(
    verifyAvailableProfile(
      { ...profile, provider: "unregistered-provider" },
      context(),
    ),
    /Only the openai-codex OAuth or zai Coding Plan Pi launch adapter is qualified/,
  );
});

test("live discovery failure fails closed instead of reading the old registry snapshot", async () => {
  let findCalls = 0;
  const ctx = context({
    refresh: async () => ({
      errors: new Map([[profile.provider, new Error("provider unavailable")]]),
    }),
  });
  ctx.modelRegistry.find = () => {
    findCalls += 1;
    return {
      reasoning: true,
      thinkingLevelMap: { high: "high" },
    };
  };
  await assert.rejects(
    piLaunchAdapter(ctx, "/native/pi.ts").discoverCatalog(profile),
    /Capability discovery failed.*provider unavailable/,
  );
  assert.equal(findCalls, 0, "a failed refresh never falls back to find()");

  await assert.rejects(
    verifyAvailableProfile(
      profile,
      context({ refresh: async () => { throw new Error("runtime offline"); } }),
    ),
    /Capability discovery failed.*runtime offline/,
  );
});

test("a supplied catalog is reused only when its cache key matches its current inputs", async () => {
  const ctx = context();
  const adapter = piLaunchAdapter(ctx, "/native/pi.ts");
  const catalog = await adapter.discoverCatalog(profile);
  await assert.doesNotReject(adapter.preflight(profile, catalog));
  await assert.rejects(
    adapter.preflight(profile, { ...catalog, cacheKey: "sha256:stale" }),
    /cache key.*stale/,
  );
  await assert.rejects(
    adapter.preflight({ ...profile, model: "gpt-5.6-other" }, catalog),
    /cache key.*stale/,
  );
});
