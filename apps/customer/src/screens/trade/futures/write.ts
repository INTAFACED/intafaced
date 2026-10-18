/**
 * Every futures write goes through here: one at a time, under the shared device guard (`../buy/write-lock`), with the
 * original request saved so an unknown outcome can be looked up again with the SAME request id.
 *
 * The service makes each of these retry-safe on its own request identity: open by `clientOpenId`, close by `clientCloseId`,
 * leverage and margin by `clientAdjustmentId` plus the position id. "Check status" reads first (open, close) and replays the
 * saved request, unchanged, only for margin and leverage or after the trader's explicit second step. Nothing here retries by itself.
 */
import type { Position } from '@intafaced/exchange-contract/schemas';
import type { ApiResult } from '../../../shared/api';
import { dec } from '../../../data/decimal';
import { clearPending, readPending, runGuarded, type BlockReason, type Pending } from '../buy/write-lock';
import type { FuturesApi, OpenInput } from './api';
import { futuresRefusal, type FuturesRefusal } from './refusals';

export type Intent =
  | { op: 'open'; input: OpenInput }
  | { op: 'close'; positionId: string; symbol: string; size: string; clientCloseId: string }
  | { op: 'leverage'; input: { symbol: string; positionId: string; leverage: string; clientAdjustmentId: string } }
  | { op: 'margin-add'; input: { symbol: string; positionId: string; amount: string; clientAdjustmentId: string } }
  | { op: 'margin-reduce'; input: { symbol: string; positionId: string; amount: string; clientAdjustmentId: string } };

export type Operation = Intent['op'];

export function intentId(intent: Intent): string {
  switch (intent.op) {
    case 'open':
      return intent.input.clientOpenId;
    case 'close':
      return `close:${intent.positionId}`;
    default:
      return intent.input.clientAdjustmentId;
  }
}

export function intentSymbol(intent: Intent): string {
  return intent.op === 'close' ? intent.symbol : intent.input.symbol;
}

const intentKey = (userId: string, id: string) => `futures-intent:${userId}:${id}`;

function saveIntent(userId: string, intent: Intent): boolean {
  try {
    localStorage.setItem(intentKey(userId, intentId(intent)), JSON.stringify(intent));
    return true;
  } catch {
    return false;
  }
}

export function loadIntent(userId: string, id: string): Intent | null {
  try {
    const raw = localStorage.getItem(intentKey(userId, id));
    return raw ? (JSON.parse(raw) as Intent) : null;
  } catch {
    return null;
  }
}

function dropIntent(userId: string, id: string): void {
  try {
    localStorage.removeItem(intentKey(userId, id));
  } catch {
    // The guard note is what blocks new actions; a stuck copy of the intent is harmless.
  }
}

export function send(api: FuturesApi, intent: Intent): Promise<ApiResult<Position>> {
  switch (intent.op) {
    case 'open':
      return api.open(intent.input);
    case 'close':
      return api.close(intent.positionId, { quantity: intent.size, clientCloseId: intent.clientCloseId });
    case 'leverage':
      return api.setLeverage(intent.input);
    case 'margin-add':
      return api.addMargin(intent.input);
    case 'margin-reduce':
      return api.reduceMargin(intent.input);
  }
}

export type WriteOutcome =
  | { kind: 'blocked'; reason: BlockReason; pending?: Pending }
  | { kind: 'done'; position: Position }
  | { kind: 'refused'; refusal: FuturesRefusal }
  /** The outcome is unknown. The note stays, so no other trade write goes out until this one is looked up. `notFound`: a read looked and found nothing. */
  | { kind: 'uncertain'; id: string; notFound?: boolean };

/**
 * 5xx answers the service sends AFTER rolling back with nothing posted (position-service.ts: no usable mark on open, or on a
 * profitable close that fails the payout-grade mark check). The shared client calls any 5xx on a write "uncertain"; for these
 * codes the answer is definite, so they must not leave the device-wide note behind.
 */
const ROLLED_BACK_CODES: ReadonlySet<string> = new Set(['trade.mark_missing', 'trade.mark_unusable']);
const isDefinite = (result: { ok: boolean; reason?: string; code?: string }) =>
  !result.ok && result.reason === 'uncertain' && result.code !== undefined && ROLLED_BACK_CODES.has(result.code);

/** Send ONE write. An unknown outcome keeps the device note and the saved request; nothing re-sends by itself. */
export async function runIntent(
  api: FuturesApi,
  userId: string | null,
  intent: Intent,
  options: { recheck?: boolean } = {},
): Promise<WriteOutcome> {
  const id = intentId(intent);
  const pending: Pending = { kind: 'position', id, symbol: intentSymbol(intent), startedAt: Date.now() };
  if (userId && !options.recheck && !saveIntent(userId, intent)) return { kind: 'blocked', reason: 'storage' };
  const guarded = await runGuarded(
    userId,
    pending,
    () => send(api, intent),
    (result) => !result.ok && result.reason === 'uncertain' && !isDefinite(result),
    options,
  );
  if (guarded.kind === 'blocked') {
    if (userId && !options.recheck) dropIntent(userId, id);
    return { kind: 'blocked', reason: guarded.reason, pending: guarded.pending };
  }
  if (guarded.kind === 'threw') return { kind: 'uncertain', id };
  const result = guarded.value;
  if (result.ok) {
    if (userId) dropIntent(userId, id);
    return { kind: 'done', position: result.data };
  }
  if (result.reason === 'uncertain' && !isDefinite(result)) return { kind: 'uncertain', id };
  if (userId) dropIntent(userId, id);
  return { kind: 'refused', refusal: futuresRefusal(result) };
}

const SETTLED = new Set(['closed', 'liquidated', 'closing']);

/** Look for the effect of an unknown write without sending anything. Null = looked, found nothing; undefined = could not look. */
async function lookup(api: FuturesApi, intent: Intent, pending: Pending): Promise<Position | null | undefined> {
  if (intent.op === 'close') {
    const result = await api.position(intent.positionId);
    return result.ok ? result.data : result.code === 'trade.position_not_found' ? null : undefined;
  }
  if (intent.op === 'open') {
    const result = await api.positions();
    if (!result.ok) return undefined;
    const size = dec(intent.input.size);
    return (
      result.data.find(
        (p) =>
          p.symbol === intent.input.symbol &&
          p.side === intent.input.side &&
          dec(p.contracts) === size &&
          p.timestamp >= pending.startedAt - 10_000,
      ) ?? null
    );
  }
  return undefined;
}

/**
 * After an unknown outcome. Open and close are looked up with a READ first: a close that already went through is not sent
 * again, and an open whose request never arrived must not be sent again by a button called "check". A still-open close
 * replays the saved intent, including the same `clientCloseId`, so the service returns the first close instead of a second.
 * `resend` is the trader's explicit second step for an open that was not found: the same request id goes out once more, so at
 * most one position can result. Margin and leverage replays are safe by their request id and go straight out.
 */
export async function checkPending(
  api: FuturesApi,
  userId: string | null,
  pending: Pending,
  options: { resend?: boolean } = {},
): Promise<WriteOutcome> {
  if (!userId) return { kind: 'blocked', reason: 'signedOut' };
  const intent = loadIntent(userId, pending.id);
  if (!intent) return { kind: 'blocked', reason: 'unreadable' };
  if (intent.op === 'open' || intent.op === 'close') {
    const found = await lookup(api, intent, pending);
    if (found && (intent.op === 'open' || SETTLED.has(found.status ?? ''))) {
      clearPending(userId, pending.id);
      dropIntent(userId, pending.id);
      return { kind: 'done', position: found };
    }
    if (found === undefined) return { kind: 'uncertain', id: pending.id };
    if (intent.op === 'open' && !options.resend) return { kind: 'uncertain', id: pending.id, notFound: true };
  }
  const outcome = await runIntent(api, userId, intent, { recheck: true });
  if (outcome.kind === 'done' || outcome.kind === 'refused') clearPending(userId, pending.id);
  return outcome;
}

export { readPending };
