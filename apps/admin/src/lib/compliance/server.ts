import 'server-only';
import { describeUnconfigured, readConsoleStatus } from '@/lib/console-status';
import { readQueue, readStatus, type ComplianceRead, type ComplianceSection, type Disposition, type EdgeComplianceStatus } from './model';

/**
 * svc-edge `/admin/status` and `/admin/compliance/*`, with the console's module operator credential
 * (`ADMIN_OPERATOR_TOKEN`, `admin:write` + MFA). The token stays on the server. The edge attributes a disposition to
 * the token's user, not to the founder at the keyboard; the console logs the founder (see the route) and the gap is
 * filed in admin-BACKEND-NEEDS.md.
 */

const TIMEOUT_MS = 5_000;

function config(): { edgeUrl: string; token: string } | { reason: string } {
  const status = readConsoleStatus();
  if (!status.module.configured || !status.edgeUrl) return { reason: describeUnconfigured(status.module) };
  return { edgeUrl: status.edgeUrl, token: (process.env[status.module.tokenVar] ?? '').trim() };
}

async function get<T>(path: string, read: (raw: unknown) => T | null, what: string): Promise<ComplianceSection<T>> {
  const cfg = config();
  if ('reason' in cfg) return { kind: 'failed', message: cfg.reason, code: 'admin.kill_unconfigured' };
  try {
    const res = await fetch(`${cfg.edgeUrl}${path}`, {
      headers: { authorization: `Bearer ${cfg.token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const code =
        body && typeof body === 'object' && typeof (body as Record<string, unknown>).code === 'string'
          ? ((body as Record<string, unknown>).code as string)
          : null;
      return {
        kind: 'failed',
        message:
          res.status === 401 || res.status === 403
            ? `svc-edge refused the console’s operator credential for ${what}.`
            : `svc-edge could not give ${what} (HTTP ${res.status}).`,
        code,
      };
    }
    const data = read(body);
    return data === null
      ? { kind: 'failed', message: `svc-edge answered ${what} in a shape this console does not understand.`, code: null }
      : { kind: 'ok', data };
  } catch {
    return { kind: 'failed', message: `svc-edge did not answer ${what}.`, code: null };
  }
}

export async function loadCompliance(now: Date = new Date()): Promise<ComplianceRead> {
  const [status, queue] = await Promise.all([
    get('/admin/status', readStatus, 'the compliance status'),
    get('/admin/compliance/queue', readQueue, 'the compliance queue'),
  ]);
  return { asOf: now.toISOString(), status, queue };
}

/** svc-edge's compliance status alone (screening and network posture), for the effective settings page. */
export async function loadComplianceStatus(): Promise<ComplianceSection<EdgeComplianceStatus>> {
  return get('/admin/status', readStatus, 'the compliance status');
}

export type DisposeResult =
  | { readonly kind: 'applied'; readonly status: Disposition; readonly itemId: string }
  | { readonly kind: 'refused'; readonly status: number; readonly code: string | null; readonly message: string }
  | { readonly kind: 'unknown'; readonly detail: string }
  | { readonly kind: 'unconfigured'; readonly detail: string };

/** One disposition. Only a 200 whose body names the same case and status counts as applied. */
export async function disposeCase(itemId: string, status: Disposition, reason: string): Promise<DisposeResult> {
  const cfg = config();
  if ('reason' in cfg) return { kind: 'unconfigured', detail: cfg.reason };
  try {
    const res = await fetch(`${cfg.edgeUrl}/admin/compliance/queue/disposition`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ itemId, status, reason }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body: unknown = await res.json().catch(() => null);
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    if (res.ok) {
      return record.ok === true && record.status === status && record.itemId === itemId
        ? { kind: 'applied', status, itemId }
        : { kind: 'unknown', detail: 'svc-edge answered 200 but its body does not confirm this case and status.' };
    }
    if (res.status >= 500) return { kind: 'unknown', detail: `svc-edge answered ${res.status}.` };
    return {
      kind: 'refused',
      status: res.status,
      code: typeof record.code === 'string' ? record.code : null,
      message:
        typeof record.error === 'string'
          ? record.error
          : typeof record.message === 'string'
            ? record.message
            : 'svc-edge refused the disposition.',
    };
  } catch {
    return { kind: 'unknown', detail: 'The connection ended before svc-edge answered.' };
  }
}
