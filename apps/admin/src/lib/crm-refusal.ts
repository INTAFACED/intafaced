/**
 * How the CRM screens word a refused request. The route handlers pass the service's typed code through as `upstream`
 * (see `adminSessionErrorResponse`), so a deployment that has no CRM set up is told apart from a real version conflict.
 * Both used to arrive as the same 412 and both read "the record changed".
 */
/** refused = the service definitely declined (a typed 409/412 that is not a version conflict): nothing was changed. */
export type CrmRefusalKind = 'session' | 'unconfigured' | 'conflict' | 'refused' | 'other';

/** The service says CRM storage, its founder list or its authority is not set up here: nothing the founder can retry. */
const NOT_CONFIGURED = new Set(['ops.crm.configuration_unverified', 'ops.crm.storage_unconfigured', 'ops.crm.authority_unconfigured']);
/** A real version conflict: someone saved a newer copy first, so reloading the record is the right next step. */
const VERSION_CONFLICT = new Set(['ops.crm.revision_conflict', 'ops.crm.idempotency_conflict']);

export const CRM_REFUSED_TEXT = 'This action was refused and nothing was changed. Refresh and review before retrying.';
export const CRM_NOT_CONFIGURED_TEXT = 'CRM is not configured on this deployment.';

export function crmUpstreamCode(body: unknown): string | null {
  const upstream = body && typeof body === 'object' ? (body as { upstream?: unknown }).upstream : null;
  return typeof upstream === 'string' ? upstream : null;
}

export function crmRefusalKind(status: number, upstream: string | null): CrmRefusalKind {
  if (upstream && NOT_CONFIGURED.has(upstream)) return 'unconfigured';
  if (status === 401 || status === 403) return 'session';
  if (status === 409 || status === 412) return upstream === null || VERSION_CONFLICT.has(upstream) ? 'conflict' : 'refused';
  return 'other';
}
