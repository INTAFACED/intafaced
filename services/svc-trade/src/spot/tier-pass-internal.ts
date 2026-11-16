/**
 * GRANT A VIP TRIAL PASS, FOR svc-campaigns (CM-vip-tiers-01, J-campaigns-14 #2 #3): `POST /internal/tier-pass`.
 *
 * Body `{ userId, campaignId, tierId, seconds, grantedBy }`. svc-campaigns sends it when a `trial_pass` campaign grants
 * its reward; the pass is keyed `trial-pass:<campaignId>:<userId>`, so a retry answers the pass already granted and
 * writes nothing. The tier must be one the owner's tier programme in force names: with no programme the grant refuses
 * `trade.tier_pass_no_programme`, and a tier it does not name refuses `trade.tier_pass_tier_unknown`, so a pass never
 * names a tier no fill could be charged at. A pass in force is replaced (tier-passes.ts). Only svc-campaigns may call it.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from 'postgres';
import { verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import type { OwnerFeeSchedule } from './fee-schedule.js';
import { TIER_PASS_MAX_SECONDS, TIER_PASS_MIN_SECONDS, grantTierPass } from './tier-passes.js';

export const TIER_PASS_PATH = '/internal/tier-pass';
export const TIER_PASS_CALLERS: ReadonlySet<string> = new Set(['svc-campaigns']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAMPAIGN = /^[A-Za-z0-9_.-]{1,128}$/;
const TIER = /^[A-Za-z0-9_.-]{1,64}$/;

export interface TierPassBody {
  readonly userId: string;
  readonly campaignId: string;
  readonly tierId: string;
  readonly seconds: number;
  readonly grantedBy: string;
}

export function parseTierPassBody(body: unknown): TierPassBody | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.userId !== 'string' || !UUID.test(b.userId)) return null;
  if (typeof b.campaignId !== 'string' || !CAMPAIGN.test(b.campaignId)) return null;
  if (typeof b.tierId !== 'string' || !TIER.test(b.tierId) || b.tierId === 'regular') return null;
  if (typeof b.seconds !== 'number' || !Number.isInteger(b.seconds)) return null;
  if (b.seconds < TIER_PASS_MIN_SECONDS || b.seconds > TIER_PASS_MAX_SECONDS) return null;
  if (typeof b.grantedBy !== 'string' || b.grantedBy.trim().length === 0 || b.grantedBy.length > 200) return null;
  return { userId: b.userId.toLowerCase(), campaignId: b.campaignId, tierId: b.tierId, seconds: b.seconds, grantedBy: b.grantedBy.trim() };
}

function callerOf(req: FastifyRequest, secret: string, s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode }): string | null {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  try {
    return verifyServiceRequest(req, { verifier: s2s?.verifier, mode: s2s?.mode, legacySecret: secret, bodyBindMode: 'require' }).service;
  } catch {
    return null;
  }
}

export function registerTierPassGrant(
  app: FastifyInstance,
  deps: {
    sql: Sql;
    secret: string;
    s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode };
    scheduleAt(at: Date): Promise<OwnerFeeSchedule>;
    now?: () => Date;
  },
): void {
  const now = deps.now ?? (() => new Date());
  app.post(TIER_PASS_PATH, async (req, reply) => {
    const caller = callerOf(req, deps.secret, deps.s2s);
    if (caller === null) return reply.code(401).send({ error: 'service credentials required', code: 'trade.unauthenticated' });
    if (!TIER_PASS_CALLERS.has(caller)) {
      return reply.code(403).send({ error: 'a trial pass is granted by svc-campaigns only', code: 'trade.tier_pass_forbidden' });
    }
    const input = parseTierPassBody(req.body);
    if (!input) return reply.code(400).send({ error: 'trial pass input is invalid', code: 'trade.tier_pass_input' });
    const at = now();
    const schedule = await deps.scheduleAt(at);
    if (schedule.published !== true || !schedule.tierProgram) {
      return reply.code(409).send({ error: 'no fee tier programme is in force', code: 'trade.tier_pass_no_programme' });
    }
    if (!schedule.tierProgram.thresholds.some((threshold) => threshold.tierId === input.tierId)) {
      return reply
        .code(409)
        .send({ error: `the tier programme in force names no tier '${input.tierId}'`, code: 'trade.tier_pass_tier_unknown' });
    }
    const granted = await grantTierPass(deps.sql, { ...input, scheduleVersion: schedule.version, at });
    return reply.code(granted.granted ? 201 : 200).send(granted);
  });
}
