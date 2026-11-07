import { createHash } from 'node:crypto';

/**
 * The approval a trade bust needs (J-cex-spot-18 #4) is bound to a hash of exactly what svc-trade checks when the bust
 * is carried out (services/svc-trade/src/admin/bust.ts `bustApprovalBody`): the action, the order, its fill count when
 * read, and the reason. Byte for byte the same canonical form: keys sorted, no spaces.
 */
export const BUST_ACTION_TYPE = 'trade.bust';
export const BUST_TARGET_SERVICE = 'svc-trade';
export const BUST_POLICY_VERSION = 'trade-bust-v1';
/** The typed blocker svc-trade answers with while no ledger-client recipe reverses a fill. */
export const TRADE_BUST_RECIPE_MISSING = 'trade_bust_recipe_missing';

export interface BustBody {
  readonly orderId: string;
  /** The order's fill count when the proposer read it, as a whole-number string. */
  readonly expectedVersion: string;
  readonly reason: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function bustPayloadHash(body: BustBody): string {
  const payload = { actionType: BUST_ACTION_TYPE, orderId: body.orderId, expectedVersion: body.expectedVersion, reason: body.reason };
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}
