/**
 * Shared pieces for the trade operator desk: reads are `admin:read`, writes
 * are `admin:write`, exact decimals, append-only audit, idempotent requests,
 * and two-person approval consumption.
 * Money stays a decimal string. A blank config refuses; it is never filled in.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { requireScope, type Principal } from '@intafaced/auth';

export const OPERATOR_PERMISSION = 'admin:read' as const;
export const OPERATOR_WRITE_PERMISSION = 'admin:write' as const;

export class TradeOpsError extends Error {
  constructor(
    readonly code: string,
    message: string = code,
  ) {
    super(message);
    this.name = 'TradeOpsError';
  }
}

export function requireOperator(principal: Principal): void {
  requireScope(principal, OPERATOR_PERMISSION);
}

export function requireOperatorWrite(principal: Principal): void {
  requireScope(principal, OPERATOR_WRITE_PERMISSION);
}

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;
const INTEGER = /^(?:0|[1-9]\d*)$/;

/** Unsigned exact decimal. Rejects floats, blanks, and exponents. */
export function exactDecimal(value: string, label: string): string {
  const trimmed = value.trim();
  if (!DECIMAL.test(trimmed)) {
    throw new TradeOpsError('risk_limit_not_exact', `${label} must be an exact unsigned decimal string`);
  }
  return trimmed;
}

export function exactInteger(value: string, label: string): string {
  const trimmed = value.trim();
  if (!INTEGER.test(trimmed)) {
    throw new TradeOpsError('risk_limit_not_exact', `${label} must be an exact non-negative integer string`);
  }
  return trimmed;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new TradeOpsError('payload_not_canonical', 'approval payload must be JSON');
}

export function payloadHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export interface ApprovalConsumeInput {
  readonly approvalId: string;
  readonly actionType: string;
  readonly targetId: string;
  readonly expectedVersion: string;
  readonly payloadHash: string;
  readonly operationId: string;
}

export type ApprovalConsumeResult =
  | { readonly ok: true; readonly approverId: string; readonly requesterId: string }
  | { readonly ok: false; readonly code: 'approval_missing' | 'approval_reused' | 'approval_mismatch' };

export interface ApprovalBook {
  consume(input: ApprovalConsumeInput): Promise<ApprovalConsumeResult>;
}

export interface StoredApproval {
  readonly approvalId: string;
  readonly actionType: string;
  readonly targetService: string;
  readonly targetId: string;
  readonly expectedVersion: string;
  readonly payloadHash: string;
  readonly requesterId: string;
  readonly approverId: string;
}

/** In-process book the acceptance tests use. Production uses the identity client. */
export class MemoryApprovalBook implements ApprovalBook {
  private readonly rows = new Map<string, StoredApproval & { status: 'APPROVED' | 'CONSUMED' }>();

  put(row: StoredApproval): void {
    this.rows.set(row.approvalId, { ...row, status: 'APPROVED' });
  }

  async consume(input: ApprovalConsumeInput): Promise<ApprovalConsumeResult> {
    const row = this.rows.get(input.approvalId);
    if (!row) return { ok: false, code: 'approval_missing' };
    if (row.status === 'CONSUMED') return { ok: false, code: 'approval_reused' };
    const bound =
      row.actionType === input.actionType &&
      row.targetService === 'svc-trade' &&
      row.targetId === input.targetId &&
      row.expectedVersion === input.expectedVersion &&
      row.payloadHash === input.payloadHash &&
      row.approverId.trim().toLowerCase() !== row.requesterId.trim().toLowerCase();
    if (!bound) return { ok: false, code: 'approval_mismatch' };
    this.rows.set(row.approvalId, { ...row, status: 'CONSUMED' });
    return { ok: true, approverId: row.approverId, requesterId: row.requesterId };
  }
}

export async function consumeApproval(book: ApprovalBook, input: ApprovalConsumeInput): Promise<{ approverId: string }> {
  const result = await book.consume(input);
  if (!result.ok) {
    const message =
      result.code === 'approval_missing'
        ? 'approval is missing'
        : result.code === 'approval_reused'
          ? 'approval was already consumed'
          : 'approval does not match this scope, payload, or a second operator';
    throw new TradeOpsError(result.code, message);
  }
  return { approverId: result.approverId };
}

export interface AuditWrite {
  readonly kind: string;
  readonly operatorId: string;
  readonly accountId: string | null;
  readonly objectId: string;
  readonly approverId: string | null;
  readonly reason: string | null;
  readonly detail?: unknown;
}

export async function writeOperatorAudit(sql: Sql, row: AuditWrite, at: Date = new Date()): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO trade.operator_audit (
    id, kind, operator_id, account_id, object_id, approver_id, reason, occurred_at, detail
  ) VALUES (
    ${id}, ${row.kind}, ${row.operatorId}, ${row.accountId}, ${row.objectId}, ${row.approverId},
    ${row.reason}, ${at.toISOString()}, ${sql.json((row.detail ?? {}) as never)}
  )`;
  return id;
}

/** Restriction apply path: skip when this migration is not on the database (older suites). */
export async function writeRestrictionAudit(
  sql: Sql,
  row: { actorUserId: string; userId: string; action: string; reason: string; requestId: string },
): Promise<void> {
  const [present] = await sql<Array<{ rel: string | null }>>`SELECT to_regclass('trade.operator_audit')::text AS rel`;
  if (!present?.rel) return;
  await writeOperatorAudit(sql, {
    kind: 'restriction.apply',
    operatorId: row.actorUserId,
    accountId: row.userId,
    objectId: row.requestId,
    approverId: null,
    reason: row.reason,
    detail: { action: row.action },
  });
}

export async function loadRequest(sql: Sql, clientRequestId: string, kind: string, fingerprint: string): Promise<unknown | undefined> {
  const [row] = await sql<Array<{ kind: string; fingerprint: string; result: unknown }>>`
    SELECT kind, fingerprint, result FROM trade.operator_requests WHERE client_request_id = ${clientRequestId}`;
  if (!row) return undefined;
  if (row.kind !== kind || row.fingerprint !== fingerprint) {
    throw new TradeOpsError('client_request_conflict', 'clientRequestId was already used for a different request');
  }
  return row.result;
}

export async function storeRequest(sql: Sql, clientRequestId: string, kind: string, fingerprint: string, result: unknown): Promise<void> {
  await sql`INSERT INTO trade.operator_requests (client_request_id, kind, fingerprint, result)
    VALUES (${clientRequestId}, ${kind}, ${fingerprint}, ${sql.json(result as never)})`;
}

export function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ at, id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | null | undefined): { at: string; id: string } | null {
  if (cursor == null || cursor === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { at?: string; id?: string };
    if (!parsed.at || !parsed.id) throw new Error('short');
    return { at: parsed.at, id: parsed.id };
  } catch {
    throw new TradeOpsError('cursor_invalid', 'cursor is not a page token this desk issued');
  }
}

/** Spreadsheet formula injection: a cell that starts with = + - or @ is prefixed. */
export function csvCell(value: string): string {
  const neutral = /^[=+\-@]/.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(neutral)) return `"${neutral.replaceAll('"', '""')}"`;
  return neutral;
}

export function csvLine(cells: readonly string[]): string {
  return cells.map(csvCell).join(',');
}

export function readExportCap(): number | null {
  const raw = process.env.TRADE_OPERATOR_EXPORT_CAP?.trim() ?? '';
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const cap = Number(raw);
  if (!Number.isSafeInteger(cap) || cap < 1) return null;
  return cap;
}

export function readExportSigningKey(): string | null {
  const raw = process.env.TRADE_OPERATOR_EXPORT_SIGNING_KEY?.trim() ?? '';
  return raw === '' ? null : raw;
}

export function reconcileJobsEnabled(): boolean {
  const raw = process.env.TRADE_RECONCILE_JOBS_ENABLED;
  if (typeof raw !== 'string') return false;
  const text = raw.trim().toLowerCase();
  if (text === '') return false;
  return text === '1' || text === 'true' || text === 'on' || text === 'yes';
}

const EXPORT_TTL_SECONDS = 120;

export function signExportRef(id: string, exp: number, key: string): string {
  const body = `${id}.${exp}`;
  const mac = createHmac('sha256', key).update(body).digest('hex');
  return `${body}.${mac}`;
}

export function openExportRef(ref: string, key: string, nowMs: number): { id: string } {
  const parts = ref.split('.');
  if (parts.length !== 3) throw new TradeOpsError('export_ref_invalid', 'download reference is not signed');
  const [id, expText, mac] = parts as [string, string, string];
  const exp = Number(expText);
  if (!id || !Number.isFinite(exp)) throw new TradeOpsError('export_ref_invalid', 'download reference is not signed');
  const expected = createHmac('sha256', key).update(`${id}.${expText}`).digest('hex');
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new TradeOpsError('export_ref_invalid', 'download reference is not signed');
  }
  if (nowMs > exp * 1000) throw new TradeOpsError('export_ref_expired', 'download reference has expired');
  return { id };
}

export function exportExpiry(now: Date): number {
  return Math.floor(now.getTime() / 1000) + EXPORT_TTL_SECONDS;
}

export function requireClientRequestId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 128) {
    throw new TradeOpsError('client_request_id_required', 'clientRequestId is required (1–128 chars)');
  }
  return trimmed;
}

export function requireReason(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 500) {
    throw new TradeOpsError('reason_required', 'reason is required (3–500 chars)');
  }
  return trimmed;
}
