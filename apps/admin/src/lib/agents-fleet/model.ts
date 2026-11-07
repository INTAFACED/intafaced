/**
 * The agent fleet desk (`/more-ops/agents`, AG-registry-01, AG-control-02): what the operator picks and what the desk's
 * one API route accepts. Shared by the page and the route; holds no data.
 */

export const RISK_SIGNALS = ['no_owner', 'write_tool', 'no_spend_cap', 'never_run'] as const;
export type RiskSignal = (typeof RISK_SIGNALS)[number];
export const RISK_WORD: Record<RiskSignal, string> = {
  no_owner: 'Enabled with no owner',
  write_tool: 'Holds a write tool',
  no_spend_cap: 'No spend cap set',
  never_run: 'Never run',
};

export const KINDS = ['customer_built', 'product'] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_WORD: Record<Kind, string> = { customer_built: 'Customer-built', product: 'Product' };

export type FleetAction =
  | { readonly action: 'registry'; readonly riskSignal: RiskSignal | null }
  | { readonly action: 'export'; readonly riskSignal: RiskSignal | null; readonly requestId: string }
  | { readonly action: 'quarantine'; readonly ref: string; readonly reason: string | null; readonly requestId: string }
  | { readonly action: 'restore'; readonly ref: string; readonly requestId: string }
  | { readonly action: 'killKind'; readonly kind: Kind; readonly reason: string | null; readonly requestId: string }
  | { readonly action: 'restoreKind'; readonly kind: Kind; readonly requestId: string }
  | { readonly action: 'reassign'; readonly ref: string; readonly owner: string; readonly requestId: string };

const REQUEST_ID = /^[A-Za-z0-9:_-]{8,200}$/;
const REF = /^(product|own):[A-Za-z0-9._-]{1,100}$/;

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max ? value.trim() : null;

/** The route's body, checked field by field. A missing reason is passed on, so svc-agents refuses it by its own code. */
export function parseFleetAction(body: unknown): FleetAction | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const risk = b.riskSignal === undefined || b.riskSignal === null || b.riskSignal === '' ? null : b.riskSignal;
  if (risk !== null && !RISK_SIGNALS.includes(risk as RiskSignal)) return null;
  const riskSignal = risk as RiskSignal | null;
  if (b.action === 'registry') return { action: 'registry', riskSignal };
  const requestId = typeof b.requestId === 'string' && REQUEST_ID.test(b.requestId) ? b.requestId : null;
  if (!requestId) return null;
  if (b.action === 'export') return { action: 'export', riskSignal, requestId };
  const kind = KINDS.includes(b.kind as Kind) ? (b.kind as Kind) : null;
  if (b.action === 'killKind') return kind ? { action: 'killKind', kind, reason: text(b.reason, 500), requestId } : null;
  if (b.action === 'restoreKind') return kind ? { action: 'restoreKind', kind, requestId } : null;
  const ref = typeof b.ref === 'string' && REF.test(b.ref) ? b.ref : null;
  if (!ref) return null;
  if (b.action === 'quarantine') return { action: 'quarantine', ref, reason: text(b.reason, 500), requestId };
  if (b.action === 'restore') return { action: 'restore', ref, requestId };
  if (b.action === 'reassign') {
    const owner = text(b.owner, 64);
    return owner ? { action: 'reassign', ref, owner, requestId } : null;
  }
  return null;
}
