export type ChildMessageHerdrClient = {
  request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
};

export function routeChildMessage(options: {
  configDir?: string;
  stateDir?: string;
  workflowId: string;
  laneId: string;
  messageId: string;
  herdr?: ChildMessageHerdrClient;
}): Promise<{
  accepted: boolean;
  delivery: "pending" | "delivered" | "uncertain";
  request: { id: string; delivery: { status: string } };
}>;

export type CapacitySample = {
  freeMemoryGb?: number;
  swapUsedGb?: number;
  load1PerCpu?: number;
};

export function sampleCapacity(): Promise<CapacitySample>;
