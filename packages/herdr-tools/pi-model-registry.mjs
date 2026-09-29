/**
 * The installed Pi model registry, for hosts that are not a Pi runtime (the
 * MCP bridge and the supervisor's spec host). The adapter's discovery calls
 * `refresh({providers})` itself before it reads anything, so the registry is
 * created without a refresh: a snapshot taken at creation must never
 * authorize a launch. The package exports map does not expose internals, so
 * they resolve by absolute file path.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export function findPiPackageRoot(from) {
  for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return null;
}

export async function createPiModelRegistry(from) {
  const packageRoot = findPiPackageRoot(from);
  if (!packageRoot) throw new Error("pi-coding-agent package not found for the model registry.");
  const importDist = (name) => import(pathToFileURL(join(packageRoot, "dist", name)).href);
  const { ModelRuntime } = await importDist("core/model-runtime.js");
  const { ModelRegistry } = await importDist("core/model-registry.js");
  return new ModelRegistry(await ModelRuntime.create({ refreshOnCreate: false }));
}
