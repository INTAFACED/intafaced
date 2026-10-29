// hand-declared-ok: the host dispatch receipt is a deployment file written by apps/customer/deployment/host-dispatch.mjs, not a service answer
/**
 * The host dispatch receipt the deployment publishes beside `customer-deployment.json` (apps/customer/deployment/host-dispatch.mjs
 * writes it). The Help room shows each of the apex, app and join hosts as served or with its typed `host.*` code, and with
 * no readable receipt it says so with a typed code for every host, never a pass.
 */
export const HOST_DISPATCH_RECEIPT = '/host-dispatch.json';
export const HOST_ROLES = ['apex', 'app', 'join'] as const;
export type HostRole = (typeof HOST_ROLES)[number];
const RECEIPT_SCHEMA_VERSION = 1;

export type HostRow = { role: HostRole; host: string | null; result: string; detail: string | null };
export type HostDispatchView = {
  /** 'receipt' when the deployment's receipt was read, else the typed code it could not be read with. */
  source: 'receipt' | 'host.receipt_missing' | 'host.receipt_invalid' | 'host.receipt_unreadable';
  checkedAt: string | null;
  rows: HostRow[];
  /** The last receipt in which every host was served, when the current one is a refusal. */
  lastGood: { checkedAt: string; staleSince: string | null } | null;
};

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Every host carries the same typed code: the receipt itself could not be read. */
export function unreadable(source: Exclude<HostDispatchView['source'], 'receipt'>): HostDispatchView {
  return { source, checkedAt: null, rows: HOST_ROLES.map((role) => ({ role, host: null, result: source, detail: null })), lastGood: null };
}

/** The view of a receipt body. A body that is not a version-1 receipt naming its hosts is `host.receipt_invalid`. */
export function hostDispatchView(body: unknown): HostDispatchView {
  const receipt = record(body);
  const hosts = Array.isArray(receipt?.hosts) ? receipt.hosts.map(record) : null;
  const checkedAt = text(receipt?.checkedAt);
  if (!receipt || receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION || !hosts || hosts.some((host) => !host) || !checkedAt) {
    return unreadable('host.receipt_invalid');
  }
  // A refusal for every host (TLS verification off) applies to each role; otherwise each role takes its own row.
  const everyHost = hosts.find((host) => host?.role === 'all');
  const rows = HOST_ROLES.map((role): HostRow => {
    const host = everyHost ?? hosts.find((row) => row?.role === role);
    const result = text(host?.result);
    return {
      role,
      host: host === everyHost ? null : text(host?.host),
      // A receipt that leaves a host out has not checked it, which is not a pass.
      result: result === 'served' || result?.startsWith('host.') ? result : 'host.not_checked',
      detail: text(host?.detail),
    };
  });
  const good = record(receipt.lastGood);
  const goodAt = text(good?.checkedAt);
  return { source: 'receipt', checkedAt, rows, lastGood: goodAt ? { checkedAt: goodAt, staleSince: text(good?.staleSince) } : null };
}

/** Reads the published receipt. A static host answers an unknown path with the app's index, so only JSON counts as one. */
export async function readHostDispatch(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<HostDispatchView> {
  let response: Response;
  try {
    response = await fetcher(HOST_DISPATCH_RECEIPT, { cache: 'no-store', headers: { accept: 'application/json' } });
  } catch {
    return unreadable('host.receipt_unreadable');
  }
  if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return unreadable('host.receipt_missing');
  try {
    return hostDispatchView(await response.json());
  } catch {
    return unreadable('host.receipt_invalid');
  }
}
