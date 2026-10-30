// hand-declared-ok: the host dispatch receipt is a deployment file written by apps/customer/deployment/host-dispatch.mjs, not a service answer
/**
 * The host dispatch receipt (apps/customer/deployment/host-dispatch.mjs writes it; the build publishes it beside
 * `customer-deployment.json`, see `hostDispatchReceipt` in vite.config.ts). The Help room shows each of the apex, app and join hosts as served or with its typed `host.*` code, and with
 * no readable receipt it says so with a typed code for every host, never a pass.
 */
export const HOST_DISPATCH_RECEIPT = '/host-dispatch.json';
export const HOST_ROLES = ['apex', 'app', 'join'] as const;
export type HostRole = (typeof HOST_ROLES)[number];
const RECEIPT_SCHEMA_VERSION = 1;

/** The receipt's free-text detail (network errors, edge paths) stays in the receipt: the public room shows the typed code. */
export type HostRow = { role: HostRole; host: string | null; result: string };
export type HostDispatchView = {
  /** 'receipt' when the deployment's receipt was read, else the typed code it could not be read with. */
  source: 'receipt' | 'host.receipt_missing' | 'host.receipt_invalid' | 'host.receipt_unreadable';
  checkedAt: string | null;
  /** A refusal the check made for every host at once (`host.tls_verification_disabled`), beside each host's own row. */
  everyHost: string | null;
  rows: HostRow[];
  /** The last receipt in which every host was served, when the current one is a refusal. */
  lastGood: { checkedAt: string; staleSince: string | null } | null;
  /** A LOCAL TEST receipt: the local test stack's loopback sites, never a deployment. The room labels it TEST. */
  test: boolean;
};

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Every host carries the same typed code: the receipt itself could not be read. */
export function unreadable(source: Exclude<HostDispatchView['source'], 'receipt'>): HostDispatchView {
  return {
    source,
    checkedAt: null,
    everyHost: null,
    rows: HOST_ROLES.map((role) => ({ role, host: null, result: source })),
    lastGood: null,
    test: false,
  };
}

/**
 * The view of a receipt body. A body that is not a version-1 receipt naming its hosts is `host.receipt_invalid`, and so
 * is one naming a plain-http host without saying it is a LOCAL TEST receipt: only the local stack checks http hosts.
 */
export function hostDispatchView(body: unknown): HostDispatchView {
  const receipt = record(body);
  const hosts = Array.isArray(receipt?.hosts) ? receipt.hosts.map(record) : null;
  const checkedAt = text(receipt?.checkedAt);
  if (!receipt || receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION || !hosts || hosts.some((host) => !host) || !checkedAt) {
    return unreadable('host.receipt_invalid');
  }
  const test = receipt.test === true;
  if (!test && hosts.some((host) => text(host?.host)?.startsWith('http:'))) return unreadable('host.receipt_invalid');
  const code = (value: unknown) => {
    const result = text(value);
    return result === 'served' || result?.startsWith('host.') ? result : null;
  };
  const everyHost = code(hosts.find((host) => host?.role === 'all')?.result);
  const rows = HOST_ROLES.map((role): HostRow => {
    const host = hosts.find((row) => row?.role === role);
    // A host with no row of its own takes the refusal made for every host; with neither, it was not checked, never a pass.
    return { role, host: text(host?.host), result: code(host?.result) ?? everyHost ?? 'host.not_checked' };
  });
  const good = record(receipt.lastGood);
  const goodAt = text(good?.checkedAt);
  return {
    source: 'receipt',
    checkedAt,
    everyHost,
    rows,
    lastGood: goodAt ? { checkedAt: goodAt, staleSince: text(good?.staleSince) } : null,
    test,
  };
}

const TIMEOUT_MS = 10_000;

/** Reads the published receipt. A static host answers an unknown path with the app's index, so only JSON counts as one. */
export async function readHostDispatch(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<HostDispatchView> {
  let response: Response;
  try {
    response = await fetcher(HOST_DISPATCH_RECEIPT, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
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

let read: Promise<HostDispatchView> | undefined;
/** One read per page load: the Help room mounts the card in several of its views. */
export const hostDispatchOnce = () => (read ??= readHostDispatch());
