import { s2sFromEnv, serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { z } from 'zod';
import type { ProcedureInput } from '@intafaced/contracts/procedure';
import { createHash } from 'node:crypto';
import { MATCHING_SUBMIT_ORDER, type MarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import {
  adaptResultSchema,
  matchingOrderCommandSchema,
  matchingTifSchema,
  type AdaptResult,
  type MatchingOrderCommand,
} from './command.js';

/**
 * HTTP port: adapted NewOrderSingle → matching submit.
 * Unmapped CompID and missing TIF refuse before POST.
 * Named ack only. Does not relay extra fills/last/account as if svc-fix minted them.
 */

export const COMPID_ACCOUNT_JSON_ENV = 'FIX_COMPID_ACCOUNT_JSON';
export const SERVICE_SECRET_ENV = 'INTERNAL_SERVICE_SECRET';
export const MATCHING_SERVICE_NAME = 'svc-fix';
export const MATCHING_AUDIENCE = 'svc-matching';
const MIN_SERVICE_SECRET_LENGTH = 32;

export const matchingPortErrorSchema = z.object({
  code: z.enum([
    'unsupported_begin_string',
    'unsupported_appl_ver',
    'unsupported_msg_type',
    'unsupported_tag',
    'unsupported_side',
    'unsupported_ord_type',
    'missing_cl_ord_id',
    'missing_qty',
    'missing_price',
    'invalid_decimal',
    'invalid_message',
    'tif_missing',
    'tif_unsupported',
    'gtd_expiry_missing',
    'unmapped_economic_tag',
    'matching_account_unmapped',
    'matching_unconfigured',
    'matching_service_auth_unconfigured',
    'matching_lifecycle_proof_unavailable',
    'matching_unavailable',
    'matching_timeout',
    'matching_rejected',
  ]),
  message: z.string().min(1),
});

export type MatchingPortError = z.infer<typeof matchingPortErrorSchema>;

/** Named matching ack only. Extra fills/last/account from HTTP 200 are stripped — not minted here. */
export const matchingSubmitAckSchema = z.object({
  accepted: z.literal(true),
  sequence: z.number().int().nullable().optional(),
});

export type MatchingSubmitAck = z.infer<typeof matchingSubmitAckSchema>;

export type MatchingPortResult = { ok: true; ack: MatchingSubmitAck } | { ok: false; error: MatchingPortError };

export type MatchingPortOptions = {
  /** Blank / omitted with blank env → matching_unconfigured. Never localhost-by-default. */
  matchingBaseUrl?: string;
  timeoutMs?: number;
  /** OWNER-SET CompID→account JSON. Blank refuses. Never invent an account. */
  compIdAccountJson?: string;
  /** INTERNAL_SERVICE_SECRET. Blank / short refuses before unsigned POST. */
  internalServiceSecret?: string;
  /**
   * S2S v3 signing key and mode. Omitted: built from S2S_AUTH_MODE / S2S_KEYRING / S2S_SIGNING_KID / S2S_SIGNING_KEY
   * (mode off or unset means the shared secret alone). In `dual` the shared secret rides along; in `keypair` the key
   * signature is the only form and the shared secret may be blank.
   */
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
  /**
   * The market lifecycle admission proof matching requires on every submit (PX-S01). svc-fix has no source of one yet, so
   * in production this is unset and every order refuses `matching_lifecycle_proof_unavailable` before any POST: svc-fix
   * never invents a proof. Tests pass a TEST proof to exercise the POST path.
   */
  lifecycleProof?: (command: MatchingOrderCommand) => MarketLifecycleAdmissionProof | null;
};

/** Matching submit JSON: the record's own input (`MATCHING_SUBMIT_ORDER`), never a copy. Qty/price stay decimal strings. */
export type MatchingSubmitBody = ProcedureInput<typeof MATCHING_SUBMIT_ORDER>;

const DEFAULT_TIMEOUT_MS = 5_000;

function refuse(code: MatchingPortError['code'], message: string): { ok: false; error: MatchingPortError } {
  return { ok: false, error: { code, message } };
}

export function readCompIdAccountMap(
  raw: string | undefined,
): { ok: true; map: Record<string, string> } | { ok: false; error: MatchingPortError } {
  const text = (raw ?? '').trim();
  if (!text) {
    return refuse('matching_account_unmapped', 'FIX_COMPID_ACCOUNT_JSON is blank; svc-fix does not invent an account');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return refuse('matching_account_unmapped', 'FIX_COMPID_ACCOUNT_JSON is not JSON; svc-fix does not invent an account');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return refuse('matching_account_unmapped', 'FIX_COMPID_ACCOUNT_JSON is not an object; svc-fix does not invent an account');
  }
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const compId = key.trim();
    if (!compId || typeof value !== 'string') continue;
    const accountId = value.trim();
    if (!accountId) continue;
    map[compId] = accountId;
  }
  if (Object.keys(map).length === 0) {
    return refuse('matching_account_unmapped', 'FIX_COMPID_ACCOUNT_JSON has no CompID mappings; svc-fix does not invent an account');
  }
  return { ok: true, map };
}

export function resolveAccountId(
  senderCompId: string | undefined,
  rawJson: string | undefined,
): { ok: true; accountId: string } | { ok: false; error: MatchingPortError } {
  const mapped = readCompIdAccountMap(rawJson);
  if (!mapped.ok) return mapped;
  const compId = (senderCompId ?? '').trim();
  if (!compId) {
    return refuse('matching_account_unmapped', 'SenderCompID is blank; svc-fix does not invent an account');
  }
  const accountId = mapped.map[compId];
  if (!accountId) {
    return refuse('matching_account_unmapped', `SenderCompID ${compId} is unmapped; svc-fix does not invent an account`);
  }
  return { ok: true, accountId };
}

/** The time in force matching takes: the record's own list. */
export type MatchingSubmitTif = MatchingSubmitBody['tif'];

export function readCommandTif(
  command: MatchingOrderCommand,
): { ok: true; tif: MatchingSubmitTif } | { ok: false; error: MatchingPortError } {
  const parsed = matchingTifSchema.safeParse(command.tif);
  if (!parsed.success) {
    return refuse('tif_missing', 'TimeInForce is missing; svc-fix does not invent GTC');
  }
  // FIX DAY (59=0) has no matching time in force; mapping it to GTC or IOC would change the order.
  if (parsed.data === 'DAY') {
    return refuse('tif_unsupported', 'TimeInForce DAY has no matching time in force; svc-fix does not map it to another');
  }
  return { ok: true, tif: parsed.data };
}

/**
 * The GUID matching keys the order by, from the business key `fix:<SenderCompID>:<ClOrdID>` (a name-based UUID, version 5
 * layout over SHA-1). The same order from the same session always maps to the same id, so a resend cannot place it twice,
 * and two sessions' equal ClOrdIDs never collide.
 */
export function fixOrderId(senderCompId: string, clOrdId: string): string {
  const hash = createHash('sha1').update(`fix:${senderCompId}:${clOrdId}`).digest();
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x50, 6);
  hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function toMatchingSubmitBody(
  command: MatchingOrderCommand,
  order: { accountId: string; tif: MatchingSubmitTif; lifecycleProof: MarketLifecycleAdmissionProof },
): MatchingSubmitBody {
  const { accountId, tif, lifecycleProof } = order;
  return {
    orderId: fixOrderId(command.senderCompId ?? '', command.clOrdId),
    accountId,
    type: command.ordType,
    side: command.side,
    qty: command.qty,
    price: command.price,
    tif,
    lifecycleProof,
  };
}

export function matchingSubmitPath(command: MatchingOrderCommand): string {
  return `/markets/${encodeURIComponent(command.symbol)}/orders`;
}

export function readInternalServiceSecret(raw: string | undefined): { ok: true; secret: string } | { ok: false; error: MatchingPortError } {
  const secret = raw ?? '';
  if (secret.length < MIN_SERVICE_SECRET_LENGTH) {
    return refuse('matching_service_auth_unconfigured', 'INTERNAL_SERVICE_SECRET is blank; svc-fix does not POST unsigned matching orders');
  }
  return { ok: true, secret };
}

export function readMatchingBaseUrl(raw: string | undefined): { ok: true; url: string } | { ok: false; error: MatchingPortError } {
  const url = (raw ?? '').trim().replace(/\/$/, '');
  if (!url) {
    return {
      ok: false,
      error: {
        code: 'matching_unconfigured',
        message: 'MATCHING_BASE_URL is blank; svc-fix does not invent a matching host, a last price, or a fill',
      },
    };
  }
  return { ok: true, url };
}

function commandRefuse(command: unknown): { ok: true; command: MatchingOrderCommand } | { ok: false; error: MatchingPortError } {
  const parsed = matchingOrderCommandSchema.safeParse(command);
  if (parsed.success) {
    return { ok: true, command: parsed.data };
  }
  const begin = parsed.error.issues.some((issue) => issue.path[0] === 'beginString');
  if (begin) {
    return refuse('unsupported_begin_string', 'BeginString is not FIX.4.2, FIX.4.4, FIX.5.0, or FIXT.1.1');
  }
  return refuse('invalid_message', 'matching command is not a NewOrderSingle decimal-string command');
}

function classifyHttpStatus(status: number, detail: string): MatchingPortResult {
  if (status === 408 || status === 504) {
    return refuse('matching_timeout', `matching submit timed out (${status}); svc-fix does not invent a fill`);
  }
  if (status >= 500) {
    return refuse(
      'matching_unavailable',
      `matching submit failed (${status})${detail ? `: ${detail}` : ''}; svc-fix does not invent a fill`,
    );
  }
  return refuse('matching_rejected', `matching rejected submit (${status})${detail ? `: ${detail}` : ''}; svc-fix does not invent a fill`);
}

function parseAck(body: unknown): MatchingPortResult {
  const acceptedFalse = z
    .object({
      accepted: z.literal(false),
      rejected: z
        .object({
          code: z.string().optional(),
          message: z.string().optional(),
        })
        .passthrough()
        .nullable()
        .optional(),
    })
    .passthrough()
    .safeParse(body);
  if (acceptedFalse.success) {
    const rejected = acceptedFalse.data.rejected;
    const message =
      rejected && typeof rejected.message === 'string' && rejected.message.length > 0
        ? rejected.message
        : 'matching rejected the order; svc-fix does not invent a fill';
    return refuse('matching_rejected', message);
  }
  const ack = matchingSubmitAckSchema.safeParse(body);
  if (!ack.success) {
    return refuse(
      'matching_rejected',
      'matching submit ack is not named accepted/sequence JSON; svc-fix does not mint fills, last, or account',
    );
  }
  return { ok: true, ack: ack.data };
}

function isAbort(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = 'name' in err ? String(err.name) : '';
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * POST adapted command to matching `POST /markets/:marketId/orders`.
 * CompID map and TIF refuse before HTTP. Does not post ledger. Does not mint last/account/TIF.
 */
export async function postMatchingSubmit(command: unknown, options: MatchingPortOptions = {}): Promise<MatchingPortResult> {
  const parsed = commandRefuse(command);
  if (!parsed.ok) {
    return parsed;
  }
  const tif = readCommandTif(parsed.command);
  if (!tif.ok) {
    return tif;
  }
  const account = resolveAccountId(parsed.command.senderCompId, options.compIdAccountJson ?? process.env[COMPID_ACCOUNT_JSON_ENV]);
  if (!account.ok) {
    return account;
  }
  const base = readMatchingBaseUrl(options.matchingBaseUrl ?? process.env.MATCHING_BASE_URL);
  if (!base.ok) {
    return base;
  }
  let s2s = options.s2s;
  if (!s2s) {
    try {
      const fromEnv = s2sFromEnv(process.env, MATCHING_SERVICE_NAME);
      if (fromEnv.s2sMode && !fromEnv.signer) {
        // svc-fix only calls out: dual or keypair without its own signing key must not fall back to the shared secret.
        return refuse(
          'matching_service_auth_unconfigured',
          `S2S_AUTH_MODE=${fromEnv.s2sMode} needs S2S_SIGNING_KID and S2S_SIGNING_KEY; svc-fix does not POST unsigned matching orders`,
        );
      }
      if (fromEnv.signer && fromEnv.s2sMode) s2s = { signer: fromEnv.signer, mode: fromEnv.s2sMode };
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'invalid';
      return refuse(
        'matching_service_auth_unconfigured',
        `S2S configuration is invalid (${detail}); svc-fix does not POST unsigned matching orders`,
      );
    }
  }
  const rawSecret = options.internalServiceSecret ?? process.env[SERVICE_SECRET_ENV];
  // A signing key in keypair mode is the credential; the shared secret is not sent, so it need not be set.
  let secret: string;
  if (s2s?.mode === 'keypair') {
    secret = rawSecret ?? '';
  } else {
    const checked = readInternalServiceSecret(rawSecret);
    if (!checked.ok) {
      return checked;
    }
    secret = checked.secret;
  }
  const proof = options.lifecycleProof?.(parsed.command) ?? null;
  if (!proof) {
    return refuse(
      'matching_lifecycle_proof_unavailable',
      'svc-fix has no market lifecycle admission proof for this order; matching requires one and svc-fix does not invent it',
    );
  }
  // The body is checked against the record matching parses with, so an order matching would refuse is never sent.
  const body = MATCHING_SUBMIT_ORDER.input.safeParse(
    toMatchingSubmitBody(parsed.command, { accountId: account.accountId, tif: tif.tif, lifecycleProof: proof }),
  );
  if (!body.success) {
    return refuse('invalid_message', `the order does not satisfy matching's submit record: ${body.error.issues[0]?.message ?? 'invalid'}`);
  }
  const payload = JSON.stringify(body.data);
  const path = matchingSubmitPath(parsed.command);
  const sign = serviceCallSigner({ service: MATCHING_SERVICE_NAME, audience: MATCHING_AUDIENCE, legacySecret: secret, s2s });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(`${base.url}${path}`);
    const response = await fetch(url.href, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...sign(payload, { method: 'POST', url, contentType: 'application/json' }),
      },
      body: payload,
      signal: controller.signal,
    });
    // A body that stalls or breaks after 2xx headers must reach the catch below: matching may already hold the order, so it is a timeout, never a clean rejection.
    const text = await response.text();
    if (!response.ok) {
      return classifyHttpStatus(response.status, text.slice(0, 500));
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      return refuse('matching_rejected', 'matching submit returned non-JSON; svc-fix does not invent a fill');
    }
    return parseAck(json);
  } catch (err) {
    if (isAbort(err) || controller.signal.aborted) {
      return refuse('matching_timeout', 'matching submit timed out; svc-fix does not invent a fill');
    }
    const detail = err instanceof Error ? err.message : 'unknown';
    return refuse('matching_unavailable', `matching submit unreachable: ${detail}; svc-fix does not invent a fill`);
  } finally {
    clearTimeout(timer);
  }
}

/** Adapter refuse (including unsupported BeginString) never touches HTTP. */
export async function postAdaptedNewOrder(adapted: unknown, options: MatchingPortOptions = {}): Promise<MatchingPortResult> {
  const parsed = adaptResultSchema.safeParse(adapted);
  if (!parsed.success) {
    return refuse('invalid_message', 'adapt result is not a NewOrderSingle envelope');
  }
  if (!parsed.data.ok) {
    return parsed.data;
  }
  return postMatchingSubmit(parsed.data.command, options);
}

export type { AdaptResult, MatchingOrderCommand };
