import type { Sql } from 'postgres';
import { ServiceAuthError, verifyServiceHeaders } from '@intafaced/contracts';
import { planPplns, type PplnsInput, type PplnsPlan, type PplnsShare } from './pplns.js';
import { persistBlankRewardShares, persistWindowShares, readStoredEpoch, PG_UNAVAILABLE } from './window-store.js';

export const MINING_UNAUTHENTICATED = 'mining.unauthenticated' as const;

export type MiningShareAuthRefuse = {
  readonly ok: false;
  readonly status: 401;
  readonly body: {
    readonly accepted: false;
    readonly error: 'service credentials required';
    readonly code: typeof MINING_UNAUTHENTICATED;
    readonly rejected: string;
  };
};

function unauthenticated(rejected: string): MiningShareAuthRefuse {
  return {
    ok: false,
    status: 401,
    body: {
      accepted: false,
      error: 'service credentials required',
      code: MINING_UNAUTHENTICATED,
      rejected,
    },
  };
}

/**
 * POST /submitShare persists shares the epoch job later pays.
 * Edge mounts `/api/mining` — unsigned was a public payout ingest.
 * Same HMAC helper as ledger/token/matching. Blank secret is a typed refuse.
 */
export function authorizeSubmitShare(
  headers: Record<string, string | string[] | undefined>,
  secret: string | undefined,
  rawBody: Buffer,
): { readonly ok: true; readonly service: string } | MiningShareAuthRefuse {
  const trimmed = secret?.trim() ?? '';
  if (trimmed.length < 32) return unauthenticated('unset');
  try {
    const { service, rejected } = verifyServiceHeaders(headers, trimmed, {
      rawBody: { retained: true, bytes: rawBody },
      mode: 'require',
    });
    if (service === null) return unauthenticated(rejected ?? 'unauthenticated');
    return { ok: true, service };
  } catch (err) {
    if (err instanceof ServiceAuthError) return unauthenticated('unset');
    throw err;
  }
}

export async function handleSubmitSharePost(input: {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawBody: Buffer;
  readonly secret: string | undefined;
  readonly sql: Sql | null;
}): Promise<{ readonly status: number; readonly body: unknown }> {
  const auth = authorizeSubmitShare(input.headers, input.secret, input.rawBody);
  if (!auth.ok) return { status: auth.status, body: auth.body };
  try {
    if (!input.sql) throw new Error(PG_UNAVAILABLE);
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.rawBody.toString('utf8')) as unknown;
    } catch {
      throw new Error('mining.share_malformed');
    }
    const body = objectBody(parsed);
    if (body.reward === undefined || body.reward === null || (typeof body.reward === 'string' && !body.reward.trim())) {
      const windowId = requiredId(body.windowId, 'window_unconfigured');
      const assetId = requiredId(body.assetId, 'window_unconfigured');
      const epoch = parseEpoch(body.epoch) ?? null;
      if (body.feeBps !== undefined && body.feeBps !== null) throw new Error('fee_unconfigured');
      if (!Array.isArray(body.shares) || body.shares.length === 0) throw new Error('shares_empty');
      const shares = body.shares.map((item) => {
        const share = objectBody(item);
        return {
          shareId: requiredId(share.shareId, 'mining.share_malformed'),
          minerId: requiredId(share.minerId, 'mining.share_malformed'),
          weight: share.weight === undefined || share.weight === null ? null : parseWeight(share.weight),
        };
      });
      await persistBlankRewardShares(input.sql, { windowId, assetId, epoch, shares });
      return {
        status: 200,
        body: {
          accepted: true,
          settled: false,
          epoch: await readStoredEpoch(input.sql, windowId),
          amount: null,
          shares: shares.map(({ shareId, minerId }) => ({ shareId, minerId })),
        },
      };
    }
    const pplns = parsePplnsBody(parsed);
    if (pplns.shares.length === 0) throw new Error('shares_empty');
    await submitShare(input.sql, pplns);
    const epoch = await readStoredEpoch(input.sql, pplns.windowId);
    return {
      status: 200,
      body: { accepted: true, settled: false, epoch },
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : 'mining.submitShare_failed';
    return { status: 409, body: { accepted: false, error: code } };
  }
}

function objectBody(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('mining.share_malformed');
  return raw as Record<string, unknown>;
}
function requiredId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value;
}
function parseEpoch(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2_147_483_647) throw new Error('mining.epoch_unset');
  return value;
}
function parseWeight(value: unknown): bigint {
  if (typeof value === 'bigint' && value > 0n && value < 10n ** 38n) return value;
  if (typeof value === 'string' && /^[1-9]\d{0,37}$/.test(value)) return BigInt(value);
  throw new Error('mining.weight_not_integer');
}
export function parsePplnsBody(raw: unknown): PplnsInput {
  const v = objectBody(raw);
  const windowId = requiredId(v.windowId, 'window_unconfigured');
  const assetId = requiredId(v.assetId, 'window_unconfigured');
  if (typeof v.reward === 'number') throw new Error('mining.amount_not_decimal');
  if (typeof v.reward !== 'string') throw new Error('reward_unconfigured');
  if (typeof v.feeBps !== 'number' || !Number.isInteger(v.feeBps)) throw new Error('fee_unconfigured');
  const epoch = parseEpoch(v.epoch);
  if (!Array.isArray(v.shares)) throw new Error('shares_empty');
  const shares: PplnsShare[] = v.shares.map((item) => {
    const sh = objectBody(item);
    return {
      shareId: requiredId(sh.shareId, 'mining.share_malformed'),
      minerId: requiredId(sh.minerId, 'mining.share_malformed'),
      weight: parseWeight(sh.weight),
    };
  });
  return { windowId, epoch, assetId, reward: v.reward, feeBps: v.feeBps, shares };
}

/** Persist the share. Mint/rewardPay happens on the JobHost tick, not this door. */
export async function submitShare(sql: Sql, input: PplnsInput): Promise<PplnsPlan> {
  if (!sql) throw new Error(PG_UNAVAILABLE);
  const plan = planPplns(input);
  await persistWindowShares(sql, input);
  return plan;
}
