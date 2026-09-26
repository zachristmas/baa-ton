export const OPERATOR_STORE_VERSION: number;
export const OPERATOR_AUTHORITY: string;
export type OperatorTarget = { kind: "root" | "lane" | "agent"; label: string; paneId: string; workspaceId?: string; agentKind?: string };
export type OperatorReply = { at: string; text: string; from?: string; read: boolean };
export type OperatorMessage = {
  id: string;
  from: string;
  target: string;
  resolved: OperatorTarget;
  text: string;
  createdAt: string;
  notify?: boolean;
  delivery: { status: "pending" | "delivered" | "uncertain"; attempts: number; updatedAt: string; reason?: string };
  replies: OperatorReply[];
};
export type OperatorStore = { version: number; agents: Record<string, { paneId: string; workspaceId?: string; agentKind?: string; cwd?: string; registeredAt: string }>; messages: OperatorMessage[]; prompts?: Array<Record<string, unknown>>; decisions?: Array<Record<string, unknown>> };
export function operatorStorePath(env?: Record<string, string | undefined>): string;
export function readOperatorStore(path?: string): Promise<OperatorStore>;
export function withOperatorStore<T>(path: string, mutate: (store: OperatorStore) => T | Promise<T>): Promise<T>;
export function readControllerConfig(env?: Record<string, string | undefined>): Promise<unknown>;
export function resolveOperatorTarget(target: string, context?: { config?: unknown; agents?: OperatorStore["agents"] }): OperatorTarget;
export function registerOperatorAgent(store: OperatorStore, input: { name: string; paneId?: string; workspaceId?: string; agentKind?: string; cwd?: string; at?: string }): OperatorStore["agents"][string];
export function operatorMessageText(message: OperatorMessage): string;
export function addOperatorMessage(store: OperatorStore, input: { target: string; resolved: OperatorTarget; text: string; from?: string; notify?: boolean; at?: string }): OperatorMessage;
export function addOperatorReply(store: OperatorStore, input: { id: string; text: string; from?: string; at?: string }): { message: OperatorMessage; reply: OperatorReply };
export function operatorInbox(store: OperatorStore, options?: { all?: boolean; unread?: boolean; limit?: number }): OperatorMessage[];
export type RunState = { state: "running" | "paused"; reason?: string; by?: string; at?: string; implicit?: boolean };
export function runState(store: unknown): RunState;
export function setRunState(store: OperatorStore, input: { state: "running" | "paused"; reason?: string; by?: string; at?: string }): RunState;
export function runStateFromText(text: unknown): "running" | "paused" | undefined;
export function runStateLine(state: RunState): string;
export function deliverOperatorMessages(
  store: OperatorStore,
  effects: {
    ready(paneId: string, expected: Record<string, string>): Promise<{ ok: boolean; agent?: { agent_status?: string }; reason?: string }>;
    prompt(paneId: string, text: string): Promise<unknown>;
    at?: string;
  },
): Promise<string[]>;
