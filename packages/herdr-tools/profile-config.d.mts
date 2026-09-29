export type ResolvedTaskProfile = {
  name: string;
  description: string;
  readOnly: boolean;
  thinking: string;
  costPreference: string;
  contextPreference: string;
  preferredHarnesses: string[];
  agentKind?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions";
  allowArtifact?: boolean;
  launchProfile: {
    provider: string;
    model: string;
    thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    auth: "subscription";
  };
};

export function taskProfileConfigPath(cwd: string): string;
export function loadTaskProfileConfig(cwd: string): Record<string, unknown> | undefined;
export function resolveTaskProfile(cwd: string, name: string): ResolvedTaskProfile;
export function defaultTaskProfiles(): Record<string, Record<string, unknown>>;
