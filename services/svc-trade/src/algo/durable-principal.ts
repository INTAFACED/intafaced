/**
 * Durable algo place grant — the caller presented these claims at createTwap
 * (TWAP / VWAP / POV share that door).
 *
 * Persisted claims (scopes / session / tier) reconstruct the original credential
 * provenance after restart, never a JWT or secret. The owned strategy admission
 * binds this provenance to an identity grant. Every fresh child still requires
 * its own live identity decision and local trading admission; these claims alone
 * cannot authorize new exposure.
 *
 * Missing grant (pre-migration rows) still halt `trade.algo_principal_unavailable`.
 * Never mint a principal from userId alone.
 */
import type { Principal } from '@intafaced/auth';
import { TradeError } from '../spot/types.js';

export interface AlgoPlaceGrant {
  readonly scopes: readonly string[];
  readonly sid: string;
  readonly tier: Principal['tier'];
  readonly mfa: boolean;
  readonly sub_account?: string;
  readonly kid?: string;
  readonly key_env?: Principal['key_env'];
}

export function captureAlgoPlaceGrant(principal: Principal): AlgoPlaceGrant {
  if (!principal.scopes.includes('trade:write')) {
    throw new TradeError('algo create cannot persist a place grant without trade:write', 'trade.algo_principal_unavailable');
  }
  return {
    scopes: [...principal.scopes],
    sid: principal.sid,
    tier: principal.tier,
    mfa: principal.mfa,
    ...(principal.sub_account ? { sub_account: principal.sub_account } : {}),
    ...(principal.kid ? { kid: principal.kid } : {}),
    ...(principal.key_env ? { key_env: principal.key_env } : {}),
  };
}

export function principalFromAlgoGrant(input: {
  userId: string;
  grant: AlgoPlaceGrant;
  /** Schedule end — grant must not outlive the algo it authorised. */
  expiresAt: Date;
  now: Date;
}): Principal {
  if (input.now.getTime() >= input.expiresAt.getTime()) {
    throw new TradeError('algo place grant expired with the schedule — refusing to place', 'trade.algo_principal_unavailable');
  }
  if (!input.grant.scopes.includes('trade:write')) {
    throw new TradeError('stored algo place grant is missing trade:write — refusing to mint authority', 'trade.algo_principal_unavailable');
  }
  return {
    sub: input.userId,
    userId: input.userId,
    sid: input.grant.sid,
    scopes: [...input.grant.scopes],
    tier: input.grant.tier,
    mfa: input.grant.mfa,
    expiresAt: input.expiresAt,
    ...(input.grant.sub_account ? { sub_account: input.grant.sub_account } : {}),
    ...(input.grant.kid ? { kid: input.grant.kid } : {}),
    ...(input.grant.key_env ? { key_env: input.grant.key_env } : {}),
  };
}

export function parseAlgoPlaceGrant(raw: unknown): AlgoPlaceGrant | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (!Array.isArray(row.scopes) || typeof row.sid !== 'string' || row.sid.length === 0) return null;
  const scopes = row.scopes.filter((s): s is string => typeof s === 'string');
  if (!scopes.includes('trade:write')) return null;
  const tier = row.tier;
  if (tier !== 'none' && tier !== 'basic' && tier !== 'full' && tier !== 'institutional') return null;
  if (typeof row.mfa !== 'boolean') return null;
  return {
    scopes,
    sid: row.sid,
    tier,
    mfa: row.mfa,
    ...(typeof row.sub_account === 'string' ? { sub_account: row.sub_account } : {}),
    ...(typeof row.kid === 'string' ? { kid: row.kid } : {}),
    ...(row.key_env === 'live' || row.key_env === 'sandbox' ? { key_env: row.key_env } : {}),
  };
}
