import 'server-only';
import { parseOpsData, parseOpsCreated, type OpsView, type OpsCreate, type OpsReply, type OpsAuthority } from './business-ops-contract';

/** Separate deployment principals. General admin and customer bearer headers are never substitutes. */
export function opsAuthority(): OpsAuthority {
  const missingRead = ['EDGE_URL', 'ADMIN_OPS_READ_TOKEN'].filter((name) => !process.env[name]?.trim());
  const missingWrite = ['EDGE_URL', 'ADMIN_OPS_WRITE_TOKEN'].filter((name) => !process.env[name]?.trim());
  return { readConfigured: missingRead.length === 0, writeConfigured: missingWrite.length === 0, missingRead, missingWrite };
}
const PROCEDURES: Record<OpsView, string> = {
  contacts: 'contacts',
  team: 'team',
  revenue: 'revenue',
  projects: 'projects.list',
  fundraising: 'fundraising.list',
  milestones: 'fundraising.milestones',
  custody: 'custody.list',
  structured: 'structured.list',
};

export async function callBusinessOps(view: OpsView | OpsCreate, input: Record<string, unknown>, write = false): Promise<OpsReply> {
  const authority = opsAuthority();
  if (!(write ? authority.writeConfigured : authority.readConfigured))
    return {
      ok: false,
      status: 503,
      code: write ? 'admin.ops_write_unconfigured' : 'admin.ops_read_unconfigured',
      uncertain: false,
      authority,
    };
  let url: URL;
  try {
    const base = new URL(process.env.EDGE_URL!.trim());
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
      throw new Error('invalid edge');
    url = new URL(`${base.href.replace(/\/$/, '')}/api/ops/trpc/${write ? view : PROCEDURES[view as OpsView]}`);
    if (!write && Object.keys(input).length) url.searchParams.set('input', JSON.stringify(input));
  } catch {
    return { ok: false, status: 503, code: 'admin.ops_edge_invalid', uncertain: false };
  }
  try {
    const response = await fetch(url, {
      method: write ? 'POST' : 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${process.env[write ? 'ADMIN_OPS_WRITE_TOKEN' : 'ADMIN_OPS_READ_TOKEN']!.trim()}`,
        accept: 'application/json',
        ...(write ? { 'content-type': 'application/json' } : {}),
      },
      ...(write ? { body: JSON.stringify(input) } : {}),
    });
    const body: unknown = await response.json().catch(() => null);
    const envelope = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
    if (!response.ok || envelope?.error) {
      const error = envelope?.error && typeof envelope.error === 'object' ? (envelope.error as Record<string, unknown>) : null;
      const sourceCode = typeof error?.message === 'string' ? error.message.match(/^ops\.[a-z_]+\b/)?.[0] : null;
      // Never forward stack traces, raw upstream data or credential-bearing errors.
      return {
        ok: false,
        status: response.ok ? 502 : response.status,
        code:
          sourceCode ??
          (response.status === 401
            ? 'admin.ops_unauthorized'
            : response.status === 403
              ? 'admin.ops_forbidden'
              : 'admin.ops_upstream_refused'),
        uncertain: write && response.status >= 500,
      };
    }
    let data: unknown = body;
    if (envelope?.result && typeof envelope.result === 'object') {
      data = (envelope.result as Record<string, unknown>).data;
      if (data && typeof data === 'object' && 'json' in data) data = (data as { json: unknown }).json;
    }
    try {
      return write
        ? { ok: true, status: 200, record: parseOpsCreated(view as OpsCreate, data) }
        : { ok: true, status: 200, data: parseOpsData(view as OpsView, data) };
    } catch {
      return { ok: false, status: 502, code: 'admin.ops_invalid_response', uncertain: write };
    }
  } catch {
    return { ok: false, status: 502, code: 'admin.ops_network_unavailable', uncertain: write };
  }
}
