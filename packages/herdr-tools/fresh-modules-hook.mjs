/**
 * Node module resolve hook (registered by fresh-modules.mjs). A module
 * imported with ?baaton=<version> passes the same query to every local
 * module it imports, so a new version loads a completely fresh module graph
 * while modules within one version are shared.
 */
let root = "";

export async function initialize(data) {
  root = data?.root ?? "";
}

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  const parent = context.parentURL;
  if (!root || !parent || !result.url.startsWith(root)) return result;
  let version;
  try {
    version = new URL(parent).searchParams.get("baaton");
  } catch {
    return result;
  }
  if (!version) return result;
  const url = new URL(result.url);
  if (url.searchParams.has("baaton")) return result;
  url.searchParams.set("baaton", version);
  return { ...result, url: url.href };
}
