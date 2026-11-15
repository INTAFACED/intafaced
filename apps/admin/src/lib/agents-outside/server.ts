import 'server-only';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { refusalOf } from '@/lib/agents-log/server';
import { handlesFor, type FleetAnswer } from '@/lib/agents-fleet/server';
import type { OutsideAction } from './model';

/**
 * The outside assistant connections desk's hops (J-agents-21 #15), always as the signed-in founder through svc-edge:
 * svc-trade reads every connection (person, cap, balance as the venue reports it, key state, last call) and its own audit
 * log, and writes the quarantine's audit row; identity revokes the key, keeping its own row of actor and reason, and
 * names the people and operators by handle. Nothing is cached or kept here.
 *
 * Quarantine, in order, each safe to repeat with the same request id: identity revokes the key first, so its next call
 * is refused at the door whatever happens after; then svc-trade ends the connection and writes the audit row naming the
 * founder and the reason. A lost answer is read back by the same call again.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const nullableString = (v: unknown): boolean => v === null || isString(v);
const isKnown = (v: unknown): boolean => isObject(v) && typeof v.known === 'boolean';

const isQuarantine = (v: unknown): boolean =>
  v === null || (isObject(v) && isString(v.operatorId) && isString(v.reason) && isString(v.at) && isString(v.requestId));

const isRow = (v: unknown): v is Json =>
  isObject(v) &&
  isString(v.keyId) &&
  isString(v.userId) &&
  isString(v.accountId) &&
  isString(v.connectedAt) &&
  nullableString(v.endedAt) &&
  nullableString(v.asset) &&
  nullableString(v.cap) &&
  nullableString(v.accountStatus) &&
  isKnown(v.balance) &&
  (v.keyState === 'live' || v.keyState === 'revoked' || v.keyState === 'missing' || v.keyState === 'unknown') &&
  isKnown(v.lastAction) &&
  isQuarantine(v.quarantine);

const parseConnections = (raw: unknown): Json | null =>
  isObject(raw) && Array.isArray(raw.rows) && raw.rows.every(isRow) && typeof raw.more === 'boolean' && Number.isInteger(raw.limit)
    ? raw
    : null;
const isAuditRow = (v: unknown): v is Json =>
  isObject(v) && isString(v.id) && isString(v.action) && isString(v.keyId) && isString(v.userId) && isQuarantine(v);
const parseAudit = (raw: unknown): Json | null =>
  isObject(raw) && Array.isArray(raw.rows) && raw.rows.every(isAuditRow) && Number.isInteger(raw.limit) ? raw : null;
const parseAny = (raw: unknown): Json | null => (isObject(raw) ? raw : null);
const parseOwner = (raw: unknown): { keyId: string; userId: string } | null =>
  isObject(raw) && isString(raw.keyId) && isString(raw.userId) ? { keyId: raw.keyId, userId: raw.userId } : null;

export async function runOutside(ctx: FounderCallContext, action: OutsideAction): Promise<FleetAnswer> {
  switch (action.action) {
    case 'connections': {
      const result = await founderCall(ctx, 'trade', 'admin.agentDesk.connections', 'GET', undefined, parseConnections);
      if (result.kind !== 'ok') return refusalOf(result);
      const rows = result.data.rows as Json[];
      const { handles, unread } = await handlesFor(ctx, [
        ...rows.map((r) => r.userId),
        ...rows.map((r) => (isObject(r.quarantine) ? r.quarantine.operatorId : null)),
      ]);
      return { kind: 'ok', data: { ...result.data, handles, handlesUnread: unread } };
    }
    case 'audit': {
      const result = await founderCall(ctx, 'trade', 'admin.agentDesk.audit', 'GET', undefined, parseAudit);
      if (result.kind !== 'ok') return refusalOf(result);
      const rows = result.data.rows as Json[];
      const { handles, unread } = await handlesFor(ctx, [...rows.map((r) => r.operatorId), ...rows.map((r) => r.userId)]);
      return { kind: 'ok', data: { ...result.data, handles, handlesUnread: unread } };
    }
    case 'quarantine': {
      if (action.reason === null) return { kind: 'refused', code: 'agents.desk_reason_required', status: 400 };
      // The person the key belongs to, from svc-trade's own record of the key's connection, never from the browser.
      const owner = await founderCall(ctx, 'trade', 'admin.agentDesk.connection', 'GET', { keyId: action.keyId }, parseOwner);
      if (owner.kind !== 'ok') return refusalOf(owner);
      const revoked = await founderCall(
        ctx,
        'identity',
        'apiKeyOps.revoke',
        'POST',
        { userId: owner.data.userId, keyId: action.keyId, reason: action.reason, clientRequestId: action.requestId },
        parseAny,
      );
      if (revoked.kind !== 'ok') return refusalOf(revoked);
      const result = await founderCall(
        ctx,
        'trade',
        'admin.agentDesk.quarantine',
        'POST',
        { keyId: action.keyId, reason: action.reason, requestId: action.requestId },
        parseAny,
      );
      return result.kind === 'ok' ? { kind: 'ok', data: { ...result.data, keyRevoked: revoked.data } } : refusalOf(result);
    }
  }
}
