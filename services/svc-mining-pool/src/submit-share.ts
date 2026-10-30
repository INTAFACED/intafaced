import type { Sql } from 'postgres';
import {
  ServiceAuthError,
  verifyServiceHeaders,
  verifyServiceRequest,
  type ServiceAuthMode,
  type ServiceVerifier,
} from '@intafaced/contracts';
import { MiningError } from './errors.js';
import { resolveJob, type JobSource } from './job-source.js';
import { planPplns, type PplnsInput, type PplnsPlan, type PplnsShare } from './pplns.js';
import { createHash } from 'node:crypto';
import {
  POW_INVALID,
  POW_MISSING,
  POW_SPEC_UNSET,
  POW_WEIGHT_FROM_CLIENT,
  hashLengthPrefixed,
  powHeader,
  powValid,
  publishedPowSpec,
} from './pow.js';
import { recordShareRejection } from './share-rejections.js';
import { persistBlankRewardShares, persistWindowShares, readStoredEpoch, workerNameOf, PG_UNAVAILABLE } from './window-store.js';

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
/** Per-service keys (S2S v3): the request line is signed too, so it travels with the keys. Unset keeps the shared secret alone. */
export type SubmitShareS2s = {
  readonly verifier: ServiceVerifier;
  readonly mode: ServiceAuthMode;
  readonly method: string | undefined;
  readonly url: string | undefined;
};

export function authorizeSubmitShare(
  headers: Record<string, string | string[] | undefined>,
  secret: string | undefined,
  rawBody: Buffer,
  s2s?: SubmitShareS2s,
): { readonly ok: true; readonly service: string } | MiningShareAuthRefuse {
  const trimmed = secret?.trim() ?? '';
  if (trimmed.length < 32) return unauthenticated('unset');
  try {
    // A failed key-signed call is refused and never retried on the shared secret.
    const { service, rejected } = s2s
      ? verifyServiceRequest(
          { method: s2s.method, url: s2s.url, headers, body: rawBody },
          { verifier: s2s.verifier, mode: s2s.mode, legacySecret: trimmed, bodyBindMode: 'require' },
        )
      : verifyServiceHeaders(headers, trimmed, { rawBody: { retained: true, bytes: rawBody }, mode: 'require' });
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
  readonly s2s?: SubmitShareS2s;
  readonly sql: Sql | null;
  /** Test adapter only. Production leaves this unset. */
  readonly jobSource?: JobSource | null;
  /** The owner's proof-of-work parameters. Unset reads `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}): Promise<{ readonly status: number; readonly body: unknown }> {
  const auth = authorizeSubmitShare(input.headers, input.secret, input.rawBody, input.s2s);
  if (!auth.ok) return { status: auth.status, body: auth.body };
  try {
    if (!input.sql) throw new Error(PG_UNAVAILABLE);
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.rawBody.toString('utf8')) as unknown;
    } catch {
      throw new Error('mining.share_malformed');
    }
    const body = await checkedWork(input.sql, objectBody(parsed), input.env ?? process.env);
    if (Array.isArray(body.shares) && body.shares.some((item) => isRecord(item) && Object.prototype.hasOwnProperty.call(item, 'jobId'))) {
      return await persistJobChecked(input.sql, body, input.jobSource ?? null);
    }
    return await persistSubmittedBody(input.sql, body);
  } catch (error) {
    if (error instanceof MiningError) return { status: 409, body: { accepted: false, error: error.code } };
    const code = error instanceof Error ? error.message : 'mining.submitShare_failed';
    return { status: 409, body: { accepted: false, error: code } };
  }
}

/**
 * The proof-of-work check, before any share is stored. With no parameters published at all, a share that carries no
 * work goes on as before (the pool then checks no work, as it did before this check existed) and a share that carries
 * work refuses `mining.pow_spec_unset`: the pool cannot check it. Once parameters are published every share must carry
 * a nonce (`mining.pow_missing`), each is checked against a header the pool derives itself, and the first share that
 * fails is one rejection row and refuses the whole batch with `mining.pow_invalid`: nothing from it is stored, and the
 * shares after it are not checked. A checked share weighs 1 (one share at the published target); a weight sent beside
 * the work is refused, never trusted. Every nonce the pool accepts today was checked under a testnet set (a mainnet set
 * refuses `audit.external` here), so the stored share is stamped testnet and its window earns no credit.
 */
async function checkedWork(sql: Sql, body: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  if (!Array.isArray(body.shares)) return body;
  const shares = body.shares.map(objectBody);
  const carried = shares.some((share) => share.powNonce !== undefined);
  const spec = publishedPowSpec(env);
  if (spec === null) {
    if (carried) throw new MiningError('Proof-of-work parameters are not published', POW_SPEC_UNSET);
    return body;
  }
  const windowId = requiredId(body.windowId, 'window_unconfigured');
  const checked: Record<string, unknown>[] = [];
  for (const share of shares) {
    if (share.powNonce === undefined) throw new MiningError('A share carries no proof of work', POW_MISSING);
    if (share.weight !== undefined) throw new MiningError('A share with work is weighed by the pool', POW_WEIGHT_FROM_CLIENT);
    const shareId = requiredId(share.shareId, 'mining.share_malformed');
    const minerId = requiredId(share.minerId, 'mining.share_malformed');
    const workerName = workerNameOf(share.workerName);
    if (!powValid(spec, powHeader(windowId, minerId, workerName), share.powNonce)) {
      await recordShareRejection(sql, {
        idempotencyKey: powInvalidKey(windowId, minerId, workerName, shareId),
        windowId,
        minerId,
        reasonCode: POW_INVALID,
      });
      throw new MiningError('A share failed the proof-of-work check', POW_INVALID);
    }
    checked.push({ ...share, weight: '1' });
  }
  return { ...body, shares: checked };
}

/** One share from a rig through the miner door (`stratum-door.ts`): the account and rig it authorized, its nonce. */
export type RigShare = {
  readonly windowId: string;
  readonly assetId: string;
  readonly minerId: string;
  readonly workerName: string;
  readonly powNonce: unknown;
};

/**
 * A rig's share, through the same checks and store as a signed batch: the pool checks the work against its own header
 * and weighs it 1, a failed check is one rejection row and `mining.pow_invalid`, and the same work again is
 * `mining.share_duplicate`. The share id is the work itself (window, account, rig and nonce, length-prefixed and
 * hashed), so the rig never chooses it. With no published proof-of-work parameters it refuses `mining.pow_spec_unset`:
 * the miner door never takes work it cannot check.
 */
export async function ingestRigShare(sql: Sql, env: NodeJS.ProcessEnv, share: RigShare): Promise<void> {
  // Checked here, not only in checkedWork: with no published parameters a share without a nonce would be kept unchecked.
  if (publishedPowSpec(env) === null) throw new MiningError('Proof-of-work parameters are not published', POW_SPEC_UNSET);
  const nonce = typeof share.powNonce === 'string' ? share.powNonce : '';
  const shareId = `stratum:${prefixedHash([share.windowId, share.minerId, share.workerName, nonce])}`;
  const body = await checkedWork(
    sql,
    {
      windowId: share.windowId,
      assetId: share.assetId,
      shares: [{ shareId, minerId: share.minerId, workerName: share.workerName, powNonce: share.powNonce }],
    },
    env,
  );
  await persistSubmittedBody(sql, body);
}

function prefixedHash(parts: readonly string[]): string {
  return hashLengthPrefixed(createHash('sha256'), parts).digest('hex');
}

/**
 * The business key of one refused piece of work: the window, the account, the rig and the share, length-prefixed and
 * hashed so any id fits the key column. The same share refused again is the same row.
 */
function powInvalidKey(windowId: string, minerId: string, workerName: string, shareId: string): string {
  return `pow-invalid:${prefixedHash([windowId, minerId, workerName, shareId])}`;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}

type JobRefusal = { idempotencyKey: string; minerId: string; reasonCode: 'mining.job_source_unconfigured' | 'job_not_found' };

/**
 * Shares that name a job are accepted only when the job source knows the id.
 * A refusal with an identified miner is one rejection row, written after HMAC.
 * Accepted shares then follow the same persist path as a batch that never named a job.
 * Neither branch posts a ledger credit.
 */
async function persistJobChecked(
  sql: Sql,
  body: Record<string, unknown>,
  source: JobSource | null,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const windowId = requiredId(body.windowId, 'window_unconfigured');
  const shares = body.shares;
  if (!Array.isArray(shares) || shares.length === 0) throw new Error('shares_empty');
  const accepted: Record<string, unknown>[] = [];
  const refused: JobRefusal[] = [];
  for (const item of shares) {
    const share = objectBody(item);
    if (!Object.prototype.hasOwnProperty.call(share, 'jobId')) {
      accepted.push(share);
      continue;
    }
    const minerId = requiredId(share.minerId, 'mining.share_malformed');
    const jobId = typeof share.jobId === 'string' ? share.jobId : '';
    const decision = resolveJob(source, jobId);
    if (decision.ok) {
      const { jobId: _jobId, idempotencyKey: _key, ...rest } = share;
      void _jobId;
      void _key;
      accepted.push(rest);
      continue;
    }
    const idempotencyKey = share.idempotencyKey;
    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.trim().length < 8 ||
      idempotencyKey.length > 200 ||
      idempotencyKey !== idempotencyKey.trim()
    ) {
      throw new Error('mining.idempotency_key_unset');
    }
    refused.push({ idempotencyKey, minerId, reasonCode: decision.reason });
  }
  let persisted: { readonly status: number; readonly body: unknown } | null = null;
  if (accepted.length > 0) {
    persisted = await persistSubmittedBody(sql, { ...body, shares: accepted });
  }
  for (const refusal of refused) {
    await recordShareRejection(sql, { ...refusal, windowId });
  }
  if (!persisted) return { status: 200, body: { accepted: false, settled: false, rejected: refused.length } };
  if (refused.length === 0) return persisted;
  return { status: persisted.status, body: { ...(isRecord(persisted.body) ? persisted.body : {}), rejected: refused.length } };
}

async function persistSubmittedBody(sql: Sql, body: Record<string, unknown>): Promise<{ readonly status: number; readonly body: unknown }> {
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
        ...namedWorker(share.workerName),
        ...checkedNonce(share.powNonce),
      };
    });
    await persistBlankRewardShares(sql, { windowId, assetId, epoch, shares });
    return {
      status: 200,
      body: {
        accepted: true,
        settled: false,
        epoch: await readStoredEpoch(sql, windowId),
        amount: null,
        shares: shares.map(({ shareId, minerId }) => ({ shareId, minerId })),
      },
    };
  }
  const pplns = parsePplnsBody(body);
  if (pplns.shares.length === 0) throw new Error('shares_empty');
  await submitShare(sql, pplns);
  const epoch = await readStoredEpoch(sql, pplns.windowId);
  return { status: 200, body: { accepted: true, settled: false, epoch } };
}

function objectBody(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('mining.share_malformed');
  return raw as Record<string, unknown>;
}
function requiredId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value;
}
/** A sent rig name, checked here; no name stays absent and the store files it under the default worker. */
function namedWorker(value: unknown): { workerName?: string } {
  return value === undefined || value === null ? {} : { workerName: workerNameOf(value) };
}
/**
 * A nonce that already passed `checkedWork`; stored so the same work is not counted twice. A nonce reaches here only
 * under a published testnet set (blank refuses work, mainnet refuses `audit.external`), so it is stamped testnet.
 */
function checkedNonce(value: unknown): { powNonce?: string; testnet?: true } {
  return typeof value === 'string' ? { powNonce: value, testnet: true } : {};
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
      ...namedWorker(sh.workerName),
      ...checkedNonce(sh.powNonce),
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
