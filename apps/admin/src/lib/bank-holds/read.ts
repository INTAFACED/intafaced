import 'server-only';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type Part } from '@/lib/desk/part';
import { refusalWords } from './model';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown): v is number | null => v === null || num(v);
const setting = (v: unknown): v is 'unset' | 'published' => v === 'unset' || v === 'published';

export type HoldState = 'requested' | 'under_review' | 'released';
export interface HoldRow {
  readonly id: string;
  readonly sendId: string;
  readonly state: HoldState;
  readonly reason: string;
  readonly heldBy: string;
  readonly infoRequest: string | null;
  readonly proof: { name: string; type: string; size: number; sha256: string; uploadedAt: string } | null;
  readonly releasedBy: string | null;
  readonly createdAt: string;
  readonly send: {
    id: string;
    userId: string;
    assetId: string;
    amount: string;
    toCurrency: string;
    country: string;
    deliveryMethod: string;
  };
}
export interface HoldControls {
  readonly payeeControls: { state: 'unset' | 'published'; blockedCount: number };
  readonly exchangeAllowance: { state: 'unset' | 'published'; windowDays: number | null; exchangeCount: number };
  readonly proofLimits: { state: 'unset' | 'published'; allowedTypes: string[]; maxBytes: number | null };
}

function parseRow(raw: unknown): HoldRow | null {
  const r = rec(raw);
  const send = rec(r?.send);
  if (!r || !send) return null;
  const p = r.proof === null ? null : rec(r.proof);
  if (r.proof !== null && !(p && str(p.name) && str(p.type) && num(p.size) && str(p.sha256) && str(p.uploadedAt))) return null;
  if (!(str(r.id) && str(r.sendId) && (r.state === 'requested' || r.state === 'under_review' || r.state === 'released'))) return null;
  if (!(str(r.reason) && str(r.heldBy) && strOrNull(r.infoRequest) && strOrNull(r.releasedBy) && str(r.createdAt))) return null;
  if (!(
    str(send.id) &&
    str(send.userId) &&
    str(send.assetId) &&
    str(send.amount) &&
    str(send.toCurrency) &&
    str(send.country) &&
    str(send.deliveryMethod)
  ))
    return null;
  return {
    id: r.id,
    sendId: r.sendId,
    state: r.state,
    reason: r.reason,
    heldBy: r.heldBy,
    infoRequest: r.infoRequest,
    proof:
      p === null
        ? null
        : {
            name: p.name as string,
            type: p.type as string,
            size: p.size as number,
            sha256: p.sha256 as string,
            uploadedAt: p.uploadedAt as string,
          },
    releasedBy: r.releasedBy,
    createdAt: r.createdAt,
    send: {
      id: send.id,
      userId: send.userId,
      assetId: send.assetId,
      amount: send.amount,
      toCurrency: send.toCurrency,
      country: send.country,
      deliveryMethod: send.deliveryMethod,
    },
  };
}

export function parseQueue(raw: unknown): HoldRow[] | null {
  if (!Array.isArray(raw)) return null;
  const rows = raw.map(parseRow);
  return rows.every((r): r is HoldRow => r !== null) ? rows : null;
}

export function parseControls(raw: unknown): HoldControls | null {
  const r = rec(raw);
  const payee = rec(r?.payeeControls);
  const allow = rec(r?.exchangeAllowance);
  const proof = rec(r?.proofLimits);
  if (!payee || !allow || !proof) return null;
  if (!(setting(payee.state) && num(payee.blockedCount))) return null;
  if (!(setting(allow.state) && numOrNull(allow.windowDays) && num(allow.exchangeCount))) return null;
  if (!(setting(proof.state) && Array.isArray(proof.allowedTypes) && proof.allowedTypes.every(str) && numOrNull(proof.maxBytes)))
    return null;
  return {
    payeeControls: { state: payee.state, blockedCount: payee.blockedCount },
    exchangeAllowance: { state: allow.state, windowDays: allow.windowDays, exchangeCount: allow.exchangeCount },
    proofLimits: { state: proof.state, allowedTypes: proof.allowedTypes as string[], maxBytes: proof.maxBytes },
  };
}

export interface HoldDesk {
  readonly asOf: string;
  readonly queue: Part<HoldRow[]>;
  readonly controls: Part<HoldControls>;
}

const labels = {
  service: 'svc-bank',
  forbiddenMessage: 'svc-bank did not accept this founder session for the holds queue. It needs the operator permission admin:read.',
  refusedMessage: refusalWords,
} as const;

/** Both parts are read on their own, so a refused queue never hides the controls and the other way round. */
export async function readHoldDesk(ctx: FounderCallContext): Promise<HoldDesk> {
  const [queue, controls] = await Promise.all([
    founderCall(ctx, 'bank', 'global.ops.holds', 'GET', {}, parseQueue),
    founderCall(ctx, 'bank', 'global.ops.controls', 'GET', undefined, parseControls),
  ]);
  return { asOf: new Date().toISOString(), queue: partFrom(queue, (d) => d, labels), controls: partFrom(controls, (d) => d, labels) };
}
