import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";

/** Runtime leases: ports, port blocks and service names handed to lanes from
 * the project's `runtime` config, recorded in the manifest's top-level
 * `leases` ledger. Every allocation runs inside one manifest-lock
 * transaction, so two active leases can never share a port or a name. */
export type PortResource = { kind: "port"; range: [number, number] };
export type PortBlockResource = {
  kind: "port-block";
  size: number;
  range: [number, number];
};
export type NameResource = { kind: "name"; prefix: string; maxLength: number };
export type LeaseResource = PortResource | PortBlockResource | NameResource;
export type RuntimeConfig = {
  leases: Record<string, LeaseResource>;
  dispatchLeases: string[];
  maxPerLane: Record<string, number>;
};

export type Lease = {
  id: string;
  resource: string;
  label: string;
  kind: LeaseResource["kind"];
  ports?: number[];
  name?: string;
  workflowId: string;
  laneId: string;
  state: "active" | "released";
  grantedBy: "dispatch" | "lane-policy" | "root";
  grantedAt: string;
  releasedAt?: string;
  releaseReason?: string;
};

export type LeaseRequest = {
  resource: string;
  label?: string;
  workflowId: string;
  laneId: string;
  grantedBy: Lease["grantedBy"];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length)
    throw new Error(`${label} has unsupported keys: ${extra.join(", ")}.`);
}

const RESOURCE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const LABEL = /^[a-z][a-z0-9-]{0,15}$/;

function portRange(value: unknown, label: string): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((port) => Number.isInteger(port) && port >= 1024 && port <= 65535) ||
    value[0] > value[1]
  )
    throw new Error(`${label} must be [low, high] with 1024 <= low <= high <= 65535.`);
  return [value[0], value[1]];
}

export function validateRuntimeConfig(input: unknown): RuntimeConfig {
  if (!isRecord(input)) throw new Error("runtime must be an object.");
  onlyKeys(input, ["leases", "dispatchLeases", "maxPerLane"], "runtime");
  if (!isRecord(input.leases) || Object.keys(input.leases).length === 0)
    throw new Error("runtime.leases must name at least one resource.");
  const leases: Record<string, LeaseResource> = {};
  for (const [name, raw] of Object.entries(input.leases)) {
    const label = `runtime.leases.${name}`;
    if (!RESOURCE_NAME.test(name))
      throw new Error(`${label}: resource names are short lowercase identifiers.`);
    if (!isRecord(raw)) throw new Error(`${label} must be an object.`);
    if (raw.kind === "port") {
      onlyKeys(raw, ["kind", "range"], label);
      leases[name] = { kind: "port", range: portRange(raw.range, `${label}.range`) };
    } else if (raw.kind === "port-block") {
      onlyKeys(raw, ["kind", "size", "range"], label);
      const range = portRange(raw.range, `${label}.range`);
      if (!Number.isInteger(raw.size) || (raw.size as number) < 1 || (raw.size as number) > 64)
        throw new Error(`${label}.size must be an integer from 1 to 64.`);
      if (range[1] - range[0] + 1 < (raw.size as number))
        throw new Error(`${label}.range is smaller than one block.`);
      leases[name] = { kind: "port-block", size: raw.size as number, range };
    } else if (raw.kind === "name") {
      onlyKeys(raw, ["kind", "prefix", "maxLength"], label);
      if (typeof raw.prefix !== "string" || !/^[a-z][a-z0-9_]{0,15}$/.test(raw.prefix))
        throw new Error(`${label}.prefix must be 1-16 characters of [a-z0-9_], starting with a letter.`);
      const maxLength = raw.maxLength ?? 63;
      if (!Number.isInteger(maxLength) || (maxLength as number) < 24 || (maxLength as number) > 63)
        throw new Error(`${label}.maxLength must be an integer from 24 to 63.`);
      leases[name] = { kind: "name", prefix: raw.prefix, maxLength: maxLength as number };
    } else throw new Error(`${label}.kind must be port, port-block or name.`);
  }
  const ported = Object.entries(leases).filter(
    (entry): entry is [string, PortResource | PortBlockResource] => entry[1].kind !== "name",
  );
  for (let i = 0; i < ported.length; i += 1)
    for (let j = i + 1; j < ported.length; j += 1) {
      const [a, ra] = ported[i];
      const [b, rb] = ported[j];
      if (ra.range[0] <= rb.range[1] && rb.range[0] <= ra.range[1])
        throw new Error(`runtime.leases.${a} and runtime.leases.${b} have overlapping port ranges.`);
    }
  const dispatchLeases = input.dispatchLeases ?? [];
  if (
    !Array.isArray(dispatchLeases) ||
    !dispatchLeases.every((name) => typeof name === "string" && name in leases) ||
    new Set(dispatchLeases).size !== dispatchLeases.length
  )
    throw new Error("runtime.dispatchLeases must list distinct configured resources.");
  const maxPerLane: Record<string, number> = {};
  if (input.maxPerLane !== undefined) {
    if (!isRecord(input.maxPerLane)) throw new Error("runtime.maxPerLane must be an object.");
    for (const [name, max] of Object.entries(input.maxPerLane)) {
      if (!(name in leases))
        throw new Error(`runtime.maxPerLane.${name} names no configured resource.`);
      if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > 16)
        throw new Error(`runtime.maxPerLane.${name} must be an integer from 1 to 16.`);
      maxPerLane[name] = max as number;
    }
  }
  return { leases, dispatchLeases: dispatchLeases as string[], maxPerLane };
}

export function activeLeases(ledger: Lease[] | undefined): Lease[] {
  return (ledger ?? []).filter((lease) => lease.state === "active");
}

/** Every port or name held by more than one active lease. */
export function ledgerConflicts(ledger: Lease[] | undefined): string[] {
  const holders = new Map<string, string[]>();
  for (const lease of activeLeases(ledger)) {
    const keys = lease.name !== undefined
      ? [`name ${lease.name}`]
      : (lease.ports ?? []).map((port) => `port ${port}`);
    for (const key of keys) holders.set(key, [...(holders.get(key) ?? []), lease.id]);
  }
  return [...holders]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => `${key} is held by ${ids.join(", ")}`);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Deterministic, lowercase [a-z0-9_] name; long names keep a hash suffix so
 * truncation cannot make two lanes collide. */
export function leaseName(
  resource: NameResource,
  workflowId: string,
  laneId: string,
  label = "default",
): string {
  const workflow = slug(workflowId.replace(/^herdr-/, "")).slice(0, 8);
  const parts = [resource.prefix, workflow, slug(laneId), ...(label === "default" ? [] : [slug(label)])];
  const full = parts.filter(Boolean).join("_");
  if (full.length <= resource.maxLength) return full;
  const hash = createHash("sha256").update(full).digest("hex").slice(0, 8);
  return `${full.slice(0, resource.maxLength - 9).replace(/_+$/, "")}_${hash}`;
}

function slots(resource: PortResource | PortBlockResource): number[][] {
  const size = resource.kind === "port" ? 1 : resource.size;
  const out: number[][] = [];
  // Blocks are aligned to their size from the range start, so no block ever
  // straddles another lease's block.
  for (let start = resource.range[0]; start + size - 1 <= resource.range[1]; start += size)
    out.push(Array.from({ length: size }, (_, index) => start + index));
  return out;
}

export type AllocatePorts = {
  /** Resolves true when nothing is listening on 127.0.0.1:port. */
  probe(port: number): Promise<boolean>;
  now(): string;
  id?(): string;
};

/** Allocate (or return the existing) lease for one workflow/lane/resource/
 * label. Mutates `ledger` in place; the caller holds the manifest lock and
 * saves. Throws when the ledger already conflicts, the resource is unknown,
 * the lane is at its limit, or no slot is free. */
export async function allocateLease(
  ledger: Lease[],
  config: RuntimeConfig,
  request: LeaseRequest,
  ports: AllocatePorts,
): Promise<{ lease: Lease; created: boolean }> {
  const conflicts = ledgerConflicts(ledger);
  if (conflicts.length)
    throw new Error(`Lease ledger has conflicts; resolve before allocating: ${conflicts.join("; ")}.`);
  const resource = config.leases[request.resource];
  if (!resource)
    throw new Error(
      `Unknown lease resource ${JSON.stringify(request.resource)}. Configured: ${Object.keys(config.leases).join(", ")}.`,
    );
  const label = request.label ?? "default";
  if (!LABEL.test(label))
    throw new Error("Lease label must be a short lowercase identifier.");
  const held = activeLeases(ledger).filter(
    (lease) =>
      lease.workflowId === request.workflowId &&
      lease.laneId === request.laneId &&
      lease.resource === request.resource,
  );
  const existing = held.find((lease) => lease.label === label);
  if (existing) return { lease: existing, created: false };
  const max = config.maxPerLane[request.resource] ?? 1;
  if (held.length >= max)
    throw new Error(
      `Lane ${request.laneId} already holds ${held.length} ${request.resource} lease(s) (limit ${max}).`,
    );
  const base = {
    id: ports.id?.() ?? `lease-${randomUUID().slice(0, 8)}`,
    resource: request.resource,
    label,
    kind: resource.kind,
    workflowId: request.workflowId,
    laneId: request.laneId,
    state: "active" as const,
    grantedBy: request.grantedBy,
    grantedAt: ports.now(),
  };
  if (resource.kind === "name") {
    const name = leaseName(resource, request.workflowId, request.laneId, label);
    if (activeLeases(ledger).some((lease) => lease.name === name))
      throw new Error(`Lease name ${name} is already held.`);
    const lease: Lease = { ...base, name };
    ledger.push(lease);
    return { lease, created: true };
  }
  const taken = new Set(activeLeases(ledger).flatMap((lease) => lease.ports ?? []));
  for (const slot of slots(resource)) {
    if (slot.some((port) => taken.has(port))) continue;
    let free = true;
    for (const port of slot)
      if (!(await ports.probe(port))) {
        free = false;
        break;
      }
    if (!free) continue;
    const lease: Lease = { ...base, ports: slot };
    ledger.push(lease);
    return { lease, created: true };
  }
  throw new Error(
    `No free ${request.resource} slot in ${resource.range[0]}-${resource.range[1]}: every slot is leased or already listening.`,
  );
}

/** Release every active lease matching `match`; returns the released leases. */
export function releaseLeases(
  ledger: Lease[] | undefined,
  match: (lease: Lease) => boolean,
  reason: string,
  now: string,
): Lease[] {
  const released: Lease[] = [];
  for (const lease of ledger ?? [])
    if (lease.state === "active" && match(lease)) {
      lease.state = "released";
      lease.releasedAt = now;
      lease.releaseReason = reason;
      released.push(lease);
    }
  return released;
}

export function leaseValue(lease: Lease): string {
  if (lease.name !== undefined) return lease.name;
  const ports = lease.ports ?? [];
  return ports.length > 1 ? `${ports[0]}-${ports.at(-1)}` : String(ports[0]);
}

/** One line per lease, for lane briefs and tool output. */
export function leaseLines(leases: Lease[]): string[] {
  return leases.map(
    (lease) =>
      `${lease.resource}${lease.label === "default" ? "" : `:${lease.label}`} = ${leaseValue(lease)} (${lease.id})`,
  );
}

/** True when nothing accepts a TCP listen on 127.0.0.1:port right now. */
export function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}
