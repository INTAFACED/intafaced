/**
 * The agent action log desk (`/more-ops/agents/log`, AG-audit-01, AG-audit-02): what the operator typed and what the
 * desk's one API route accepts. Shared by the page and the route; holds no data.
 */

export type CustomerReference = { readonly kind: 'id'; readonly value: string } | { readonly kind: 'handle'; readonly value: string };

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Identity's own handle shape (`users_handle_check`). */
const HANDLE = /^@?[A-Za-z0-9_]{3,32}$/;

/** An account id, or a whole handle (with or without its @). Anything else is refused before anything is read. */
export function customerReference(raw: string): CustomerReference | { readonly error: string } {
  const value = raw.trim();
  if (ACCOUNT_ID.test(value)) return { kind: 'id', value: value.toLowerCase() };
  if (HANDLE.test(value)) return { kind: 'handle', value: value.replace(/^@/, '') };
  return { error: 'Type the customer’s whole handle or their account id.' };
}

export const OUTCOMES = ['executed', 'refused', 'failed'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const OUTCOME_WORD: Record<Outcome, string> = { executed: 'Executed', refused: 'Refused', failed: 'Failed' };

export type AgentsLogAction =
  | {
      readonly action: 'actions' | 'export';
      readonly customer: string;
      readonly reason: string | null;
      readonly outcome: Outcome | null;
      readonly tool: string | null;
      readonly requestId: string;
    }
  | { readonly action: 'transcript'; readonly actionId: string; readonly reason: string | null; readonly requestId: string };

const REQUEST_ID = /^[A-Za-z0-9:_-]{8,200}$/;
const TOOL = /^[A-Za-z0-9._:-]{1,120}$/;

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max ? value.trim() : null;

/** The route's body, checked field by field. A missing reason is passed on, so svc-agents refuses it by its own code. */
export function parseAgentsLogAction(body: unknown): AgentsLogAction | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const requestId = typeof b.requestId === 'string' && REQUEST_ID.test(b.requestId) ? b.requestId : null;
  if (!requestId) return null;
  const reason = text(b.reason, 200);
  if (b.action === 'transcript') {
    const actionId = typeof b.actionId === 'string' && ACCOUNT_ID.test(b.actionId) ? b.actionId.toLowerCase() : null;
    return actionId ? { action: 'transcript', actionId, reason, requestId } : null;
  }
  if (b.action !== 'actions' && b.action !== 'export') return null;
  const customer = text(b.customer, 64);
  if (!customer) return null;
  const outcome = b.outcome === undefined || b.outcome === null || b.outcome === '' ? null : b.outcome;
  if (outcome !== null && !OUTCOMES.includes(outcome as Outcome)) return null;
  const tool = b.tool === undefined || b.tool === null || b.tool === '' ? null : b.tool;
  if (tool !== null && (typeof tool !== 'string' || !TOOL.test(tool))) return null;
  return { action: b.action, customer, reason, outcome: outcome as Outcome | null, tool: tool as string | null, requestId };
}
