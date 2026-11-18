// hand-declared-ok: svc-trade's stream-hosts answer and svc-ws's GET /streams and GET /policy have no browser-safe schema in
// packages/contracts; these mirror services/svc-trade/src/developer-portal-rest.ts and services/svc-ws/src/routes.ts
/**
 * The WebSocket page's live reads (J-developer-09): the stream endpoint hosts the owner publishes on svc-trade
 * (`/api/trade/developer-portal/stream-hosts`), and from svc-ws itself, through the Customer server's `/ws` upstream, its
 * keepalive timing (`GET /ws/streams`) and its per-IP connection policy (`GET /ws/policy`). Nothing here holds a host, an
 * interval or a limit: a blank owner value reads "not set", and a read that fails is shown as failed, never as a value.
 */
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import type { Read } from './use-read';

export const STREAM_ENDPOINTS = ['public', 'private', 'business'] as const;
export const STREAM_HOST_ROLES = ['primary', 'failover'] as const;
export type StreamEndpoint = (typeof STREAM_ENDPOINTS)[number];
export type StreamHostRole = (typeof STREAM_HOST_ROLES)[number];

/** The svc-ws door each endpoint upgrades on (services/svc-ws: ws/gateway.ts, private/gateway.ts, drop-copy/gateway.ts). */
export const STREAM_ENDPOINT_PATH: Readonly<Record<StreamEndpoint, string>> = {
  public: '/stream',
  private: '/private/stream',
  business: '/drop-copy/stream',
};

export const DEVELOPER_STREAM_HOSTS_UNSET = 'trade.developer_stream_hosts_unset';

const streamHostsSchema = z.object({
  endpoints: z.array(z.object({ endpoint: z.enum(STREAM_ENDPOINTS), role: z.enum(STREAM_HOST_ROLES), host: z.string().min(1).nullable() })),
});
const count = z.number().int().positive().nullable();
const streamsSchema = z
  .object({
    timing: z
      .object({ heartbeatMs: z.number().int().positive().nullable(), muxIdleMs: z.number().int().positive().nullable() })
      .nullable()
      .optional(),
  })
  .passthrough();
const policySchema = z
  .object({
    perIp: z.object({ maxConnections: count, stormsBeforeBan: count, banSeconds: count, ban: z.enum(['set', 'unset']) }).optional(),
  })
  .passthrough();

export type PerIpPolicy = NonNullable<z.infer<typeof policySchema>['perIp']>;

export const readStreamHosts = (api: ApiClient, signal: AbortSignal): Promise<ApiResult<z.infer<typeof streamHostsSchema>>> =>
  api.plain('trade', '/developer-portal/stream-hosts', streamHostsSchema, { signal });

/** One GET to svc-ws through the Customer server's `/ws` upstream (apps/customer/nginx.conf strips the prefix). */
async function readStreamService<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`/ws${path}`, { signal, credentials: 'omit', headers: { accept: 'application/json' } });
    if (!response.ok)
      return { ok: false, reason: 'unreachable', message: `svc-ws ${path} answered ${response.status}`, status: response.status };
    const parsed = schema.safeParse(await response.json());
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, reason: 'invalid_response', message: `svc-ws ${path} answered an unexpected shape` };
  } catch {
    return signal.aborted
      ? { ok: false, reason: 'aborted', message: 'stopped' }
      : { ok: false, reason: 'unreachable', message: `svc-ws ${path} could not be reached` };
  }
}

export const readStreamTiming = (signal: AbortSignal) => readStreamService('/streams', streamsSchema, signal);
export const readStreamPolicy = (signal: AbortSignal) => readStreamService('/policy', policySchema, signal);

export type StreamHostCell = { state: 'unset' } | { state: 'set'; url: string };

/**
 * What the hosts read lets the page draw: every endpoint with its primary and failover host, `wss://` before each set
 * host, or every host unset with the code that says why. Any other failure is not "not set": the page shows the failure.
 */
export function streamHostsView(
  read: Read<z.infer<typeof streamHostsSchema>>,
):
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'table'; host: (endpoint: StreamEndpoint, role: StreamHostRole) => StreamHostCell; unsetCode: string | null } {
  if (read.status === 'loading') return { kind: 'loading' };
  if (read.status === 'failed') {
    return read.code === DEVELOPER_STREAM_HOSTS_UNSET
      ? { kind: 'table', host: () => ({ state: 'unset' }), unsetCode: read.code }
      : { kind: 'failed' };
  }
  const { endpoints } = read.data;
  return {
    kind: 'table',
    host: (endpoint, role) => {
      const host = endpoints.find((row) => row.endpoint === endpoint && row.role === role)?.host?.trim();
      return host ? { state: 'set', url: `wss://${host}` } : { state: 'unset' };
    },
    unsetCode: null,
  };
}

/** The ping interval in whole seconds, `unset` while svc-ws does not publish it, or `failed` when it could not be read. */
export function pingView(
  read: Read<z.infer<typeof streamsSchema>>,
): { kind: 'loading' } | { kind: 'failed' } | { kind: 'unset' } | { kind: 'set'; seconds: number } {
  if (read.status === 'loading') return { kind: 'loading' };
  if (read.status === 'failed') return { kind: 'failed' };
  const ms = read.data.timing?.heartbeatMs ?? null;
  if (ms === null) return { kind: 'unset' };
  return { kind: 'set', seconds: Math.max(1, Math.round(ms / 1000)) };
}

/** The per-IP policy as published, `unpublished` when svc-ws names none, or `failed` when it could not be read. */
export function policyView(
  read: Read<z.infer<typeof policySchema>>,
): { kind: 'loading' } | { kind: 'failed' } | { kind: 'unpublished' } | { kind: 'published'; perIp: PerIpPolicy } {
  if (read.status === 'loading') return { kind: 'loading' };
  if (read.status === 'failed') return { kind: 'failed' };
  return read.data.perIp ? { kind: 'published', perIp: read.data.perIp } : { kind: 'unpublished' };
}

/** The protocol choice guide: one row per protocol, each naming the module that owns it. */
export const PROTOCOL_GUIDE = [
  { protocol: 'rest', module: 'svc-trade' },
  { protocol: 'websocket', module: 'svc-ws' },
  { protocol: 'fix', module: 'svc-fix' },
] as const;
