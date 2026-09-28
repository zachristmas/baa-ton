import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const toolsDirectory = dirname(fileURLToPath(import.meta.url));
const defaultsPath = join(toolsDirectory, "task-profiles.json");
const CONFIG_DIRECTORY = ".baa-ton";
const CONFIG_NAME = "config.json";
const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function loadDefaults() {
  return JSON.parse(readFileSync(defaultsPath, "utf8"));
}

export function taskProfileConfigPath(cwd) {
  return join(cwd, CONFIG_DIRECTORY, CONFIG_NAME);
}

export function loadTaskProfileConfig(cwd) {
  const path = taskProfileConfigPath(cwd);
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(config) || config.version !== 1)
    throw new Error(`Invalid Baa-ton config at ${path}: expected version 1.`);
  return config;
}

function exactLaunchProfile(value, name) {
  if (!isRecord(value))
    throw new Error(`Task profile ${name} has no exact launchProfile. Configure provider, model, thinking, and auth in .baa-ton/config.json.`);
  if (
    typeof value.provider !== "string" ||
    !value.provider ||
    typeof value.model !== "string" ||
    !value.model ||
    !THINKING_LEVELS.has(value.thinking) ||
    value.auth !== "subscription"
  )
    throw new Error(`Task profile ${name} has an invalid exact launchProfile in .baa-ton/config.json.`);
  return {
    provider: value.provider,
    model: value.model,
    thinking: value.thinking,
    auth: value.auth,
  };
}

export function resolveTaskProfile(cwd, name) {
  if (typeof name !== "string" || !name.trim())
    throw new Error("taskProfile must be a non-empty profile name.");
  const defaults = loadDefaults().profiles;
  const defaultsForName = defaults[name];
  if (!defaultsForName)
    throw new Error(`Unknown task profile ${JSON.stringify(name)}. Available profiles: ${Object.keys(defaults).join(", ")}.`);
  const config = loadTaskProfileConfig(cwd);
  const configured = config?.profiles?.[name];
  if (!isRecord(configured) || !configured.launchProfile)
    throw new Error(`Task profile ${name} has no exact launchProfile. Configure provider, model, thinking, and auth in ${taskProfileConfigPath(cwd)}.`);
  // permissionMode may sit in launchProfile too; the exact profile itself
  // keeps only provider, model, thinking and auth.
  const { permissionMode: _profileMode, ...exactFields } = isRecord(configured.launchProfile) ? configured.launchProfile : {};
  const launchProfile = exactLaunchProfile(isRecord(configured.launchProfile) ? exactFields : configured.launchProfile, name);
  const agentKind = configured.agentKind;
  if (agentKind !== undefined && (typeof agentKind !== "string" || !agentKind))
    throw new Error(`Task profile ${name} has an invalid agentKind.`);
  // The harness permission mode for its lanes (Claude): bypassPermissions
  // unless the profile names another; the deny rules and lane guard apply in
  // every mode.
  const permissionMode = configured.permissionMode ?? configured.launchProfile?.permissionMode;
  if (permissionMode !== undefined && !["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"].includes(permissionMode))
    throw new Error(`Task profile ${name} has an invalid permissionMode ${JSON.stringify(permissionMode)}.`);
  return {
    name,
    description: typeof configured.description === "string" ? configured.description : defaultsForName.description,
    readOnly: configured.readOnly === true || defaultsForName.readOnly === true,
    thinking: defaultsForName.thinking,
    costPreference: defaultsForName.costPreference,
    contextPreference: defaultsForName.contextPreference,
    preferredHarnesses: [...defaultsForName.preferredHarnesses],
    ...(agentKind ? { agentKind } : {}),
    permissionMode: permissionMode ?? "bypassPermissions",
    launchProfile,
  };
}

export function defaultTaskProfiles() {
  return loadDefaults().profiles;
}
