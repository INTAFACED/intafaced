/**
 * Every futures write goes through here: one at a time, under the shared device guard (`../buy/write-lock`), with the
 * original request saved so an unknown outcome can be looked up again with the SAME request id.
 *
 * The service makes each of these retry-safe on its own request identity: open by `clientOpenId`, close by the position
 * (`close:{positionId}`), leverage and margin by `clientAdjustmentId` plus the position id. So "Check status" replays the
 * saved request unchanged and gets the original result; it never builds a new request. Nothing here retries by itself.
 */
import type { Position } from '@intafaced/exchange-contract/schemas';
import type { ApiResult } from '../../../shared/api';
import { clearPending, readPending, runGuarded, type BlockReason, type Pending } from '../buy/write-lock';
import type { FuturesApi, OpenInput } from './api';
import { futuresRefusal, type FuturesRefusal } from './refusals';

export type Intent =
  | { op: 'open'; input: OpenInput }
  | { op: 'close'; positionId: string; symbol: string }
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
      return api.close(intent.positionId);
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
  /** The outcome is unknown. The note stays, so no other trade write goes out until this one is looked up. */
  | { kind: 'uncertain'; id: string };

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
    (result) => !result.ok && result.reason === 'uncertain',
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
  if (result.reason === 'uncertain') return { kind: 'uncertain', id };
  if (userId) dropIntent(userId, id);
  return { kind: 'refused', refusal: futuresRefusal(result) };
}

/**
 * After an unknown outcome: replay the saved request unchanged. The service answers with the original result for the same
 * identity. Only a definite answer (done or refused) clears the note.
 */
export async function checkPending(api: FuturesApi, userId: string | null, pending: Pending): Promise<WriteOutcome> {
  if (!userId) return { kind: 'blocked', reason: 'signedOut' };
  const intent = loadIntent(userId, pending.id);
  if (!intent) return { kind: 'blocked', reason: 'unreadable' };
  const outcome = await runIntent(api, userId, intent, { recheck: true });
  if (outcome.kind === 'done' || outcome.kind === 'refused') clearPending(userId, pending.id);
  return outcome;
}

export { readPending };
