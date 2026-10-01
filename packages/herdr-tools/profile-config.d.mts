export type ResolvedTaskProfile = {
  name: string;
  description: string;
  readOnly: boolean;
  thinking: string;
  costPreference: string;
  contextPreference: string;
  preferredHarnesses: string[];
  agentKind?: string;
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
export function findTaskProfile(cwd: string, launchProfile: unknown): string | undefined;
export function defaultTaskProfiles(): Record<string, Record<string, unknown>>;
