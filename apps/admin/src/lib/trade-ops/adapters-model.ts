/**
 * The protocol adapters' own status as the founder console shows it (J-cex-spot-20 #3, SP-order-02): svc-fix's FIX
 * sessions and CompID to account map, and svc-ws's SBE tape consumers, read through svc-edge's
 * `/admin/trade-ops/adapters/status`. Each adapter is its own half with its own read state. Plain data, no money: the
 * adapters carry orders and market data only.
 */

export interface FixSessionRow {
  readonly role: 'order-entry' | 'drop-copy';
  readonly beginString: string;
  readonly senderCompId: string;
  readonly targetCompId: string;
  readonly state: string;
  readonly accountId: string | null;
  /** Null when the FIX engine could not read its store. */
  readonly nextSenderSeq: number | null;
  readonly nextTargetSeq: number | null;
}

export interface FixStatus {
  readonly sessions: readonly FixSessionRow[];
  readonly compIdMapSet: boolean;
  readonly compIdMap: readonly { readonly compId: string; readonly accountId: string }[];
  readonly asOf: string;
}

export interface SbeConsumerRow {
  readonly id: string;
  readonly marketId: string;
  readonly connectedAt: string;
  readonly framesSent: number;
  readonly lastSequence: string | null;
}

export interface SbeStatus {
  readonly codecLinked: boolean;
  readonly consumers: readonly SbeConsumerRow[];
  readonly asOf: string;
}

export type AdapterHalf<T> =
  | { readonly read: 'ok'; readonly data: T }
  | { readonly read: 'refused' | 'unknown'; readonly code: string; readonly error: string; readonly key: string | null };

export interface AdapterStatus {
  readonly fix: AdapterHalf<FixStatus>;
  readonly sbe: AdapterHalf<SbeStatus>;
  readonly asOf: string;
}

const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function half<T>(raw: unknown, parse: (r: Record<string, unknown>) => T | null): AdapterHalf<T> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.read === 'ok') {
    const data = parse(r);
    return data ? { read: 'ok', data } : null;
  }
  if ((r.read === 'refused' || r.read === 'unknown') && text(r.code) && typeof r.error === 'string') {
    return { read: r.read, code: r.code, error: r.error, key: text(r.key) ? r.key : null };
  }
  return null;
}

function parseFix(r: Record<string, unknown>): FixStatus | null {
  if (!Array.isArray(r.sessions) || !Array.isArray(r.compIdMap) || typeof r.compIdMapSet !== 'boolean' || !text(r.asOf)) return null;
  const sessions: FixSessionRow[] = [];
  for (const s of r.sessions as unknown[]) {
    const x = s && typeof s === 'object' ? (s as Record<string, unknown>) : null;
    if (!x || (x.role !== 'order-entry' && x.role !== 'drop-copy')) return null;
    if (!text(x.beginString) || !text(x.senderCompId) || !text(x.targetCompId) || !text(x.state)) return null;
    if (
      !(x.accountId === null || text(x.accountId)) ||
      !(x.nextSenderSeq === null || count(x.nextSenderSeq)) ||
      !(x.nextTargetSeq === null || count(x.nextTargetSeq))
    )
      return null;
    sessions.push({
      role: x.role,
      beginString: x.beginString,
      senderCompId: x.senderCompId,
      targetCompId: x.targetCompId,
      state: x.state,
      accountId: x.accountId,
      nextSenderSeq: x.nextSenderSeq,
      nextTargetSeq: x.nextTargetSeq,
    });
  }
  const compIdMap: { compId: string; accountId: string }[] = [];
  for (const m of r.compIdMap as unknown[]) {
    const x = m && typeof m === 'object' ? (m as Record<string, unknown>) : null;
    if (!x || !text(x.compId) || !text(x.accountId)) return null;
    compIdMap.push({ compId: x.compId, accountId: x.accountId });
  }
  return { sessions, compIdMapSet: r.compIdMapSet, compIdMap, asOf: r.asOf };
}

function parseSbe(r: Record<string, unknown>): SbeStatus | null {
  if (typeof r.codecLinked !== 'boolean' || !Array.isArray(r.consumers) || !text(r.asOf)) return null;
  const consumers: SbeConsumerRow[] = [];
  for (const c of r.consumers as unknown[]) {
    const x = c && typeof c === 'object' ? (c as Record<string, unknown>) : null;
    if (!x || !text(x.id) || !text(x.marketId) || !text(x.connectedAt) || !count(x.framesSent)) return null;
    if (!(x.lastSequence === null || text(x.lastSequence))) return null;
    consumers.push({ id: x.id, marketId: x.marketId, connectedAt: x.connectedAt, framesSent: x.framesSent, lastSequence: x.lastSequence });
  }
  return { codecLinked: r.codecLinked, consumers, asOf: r.asOf };
}

export function parseAdapterStatus(raw: unknown): AdapterStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const fix = half(r.fix, parseFix);
  const sbe = half(r.sbe, parseSbe);
  if (!fix || !sbe || !text(r.asOf)) return null;
  return { fix, sbe, asOf: r.asOf };
}

/** What the Account column says for a session: the mapped account, or why there is none. */
export function sessionAccount(s: FixSessionRow): string {
  if (s.role === 'drop-copy') return 'Drop copy (no orders)';
  return s.accountId ?? 'Not mapped';
}
