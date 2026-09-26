/**
 * Fresh module loading for the Pi extension. Pi's /reload re-evaluates the
 * extension entry (and jiti re-transpiles its .ts imports), but Node keeps
 * every native ES module (.mjs) cached for the life of the process, including
 * the modules those import. Without this, each self-deploy left the root
 * running the old spec driver, controller helpers and policies.
 *
 * `freshImport(path)` imports a local .mjs module at ?baaton=<version>, where
 * the version changes whenever any code file under packages/ changes; the
 * resolve hook passes the query on to every local module it imports.
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { register } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** packages/, the root every versioned module lives under. */
export const MODULES_ROOT = resolve(here, "..");
const ROOT_URL = pathToFileURL(`${MODULES_ROOT}/`).href;

function codeFiles(directory, out = []) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "test" || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) codeFiles(path, out);
    else if (/\.(mjs|ts|json)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** A cheap version of the code on disk: paths, sizes and modification times. */
export function modulesVersion(root = MODULES_ROOT) {
  const hash = createHash("sha256");
  for (const path of codeFiles(root).sort()) {
    try {
      const details = statSync(path);
      hash.update(`${path}:${details.size}:${details.mtimeMs}\n`);
    } catch {
      hash.update(`${path}:missing\n`);
    }
  }
  return hash.digest("hex").slice(0, 12);
}

let registered = false;
function ensureHook() {
  if (registered || globalThis.__baatonFreshModulesHook) {
    registered = true;
    return;
  }
  register(new URL("./fresh-modules-hook.mjs", import.meta.url), { data: { root: ROOT_URL } });
  globalThis.__baatonFreshModulesHook = true;
  registered = true;
}

/**
 * Import `specifier` (relative to `fromUrl`) at the given version; the same
 * version returns the same module instances.
 */
export async function freshImport(specifier, fromUrl, version = modulesVersion()) {
  ensureHook();
  const url = new URL(specifier, fromUrl);
  url.searchParams.set("baaton", version);
  return import(url.href);
}
