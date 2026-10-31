import { z } from 'zod';

/**
 * Owner-published pool text and the reachability probe.
 *
 * Blank, whitespace, or an unusable value is unpublished. Nothing here fills in a
 * host, a port, a sentence, or the reference port. Fee and window size stay in
 * `pool-terms.ts`. This module is not loaded at boot, so a blank setting refuses
 * the read that needs it and does not stop the process.
 */

const TEXT_MAX = 4_000;
const LINE_MAX = 500;
const VERSION_MAX = 64;
const HOST_MAX = 253;
const PATTERN_MAX = 80;
const LIMIT_MAX = 10_000;
const WINDOW_MAX_MS = 86_400_000;
const TIMEOUT_MAX_MS = 30_000;
/** Bounds of the pool's reference proof-of-work parameters (`pow.ts`). */
/** The asset a miner-door window is filed under. */
export const STRATUM_ASSET_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;
export const POW_DIMENSION_MIN = 2;
export const POW_DIMENSION_MAX = 64;
export const POW_TARGET_BITS_MAX = 32;
/** A whole difficulty of 1 to 38 digits, the numeric(38, 0) column's range. */
export const DIFFICULTY = /^[1-9]\d{0,37}$/;

function blankAsAbsent<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string' && value.trim() === '') return undefined;
    return value;
  }, schema);
}

/** Documented owner settings. The readers below enforce the same bounds; this object is not applied at boot. */
export const miningPublishSchema = z.object({
  /**
   * Version stamp on the published pool overview.
   * NO DEFAULT. Blank refuses `mining.overview_unset`.
   */
  MINING_OVERVIEW_VERSION: blankAsAbsent(z.string().min(1).max(VERSION_MAX).optional()),
  /**
   * What the pool is, in the owner's words.
   * NO DEFAULT. A wholly blank overview refuses `mining.overview_unset`.
   */
  MINING_OVERVIEW_WHAT: blankAsAbsent(z.string().min(1).max(TEXT_MAX).optional()),
  /**
   * Coin the pool names.
   * NO DEFAULT. Blank leaves that section unpublished.
   */
  MINING_OVERVIEW_COIN: blankAsAbsent(z.string().min(1).max(TEXT_MAX).optional()),
  /**
   * Hardware the pool names.
   * NO DEFAULT. Blank leaves that section unpublished.
   */
  MINING_OVERVIEW_HARDWARE: blankAsAbsent(z.string().min(1).max(TEXT_MAX).optional()),
  /**
   * How revenue is split, in the owner's words.
   * NO DEFAULT. Blank leaves that section unpublished.
   */
  MINING_OVERVIEW_REVENUE_SPLIT: blankAsAbsent(z.string().min(1).max(TEXT_MAX).optional()),
  /**
   * What the pool does not support.
   * NO DEFAULT. Blank leaves that section unpublished.
   */
  MINING_OVERVIEW_NOT_SUPPORTED: blankAsAbsent(z.string().min(1).max(TEXT_MAX).optional()),
  /**
   * Pool host a miner copies.
   * NO DEFAULT. Blank refuses `mining.connection_unset`.
   */
  MINING_POOL_HOST: blankAsAbsent(z.string().min(1).max(HOST_MAX).optional()),
  /**
   * Pool port a miner copies.
   * NO DEFAULT. Blank refuses `mining.connection_unset`.
   */
  MINING_POOL_PORT: blankAsAbsent(
    z
      .string()
      .regex(/^[1-9]\d{0,4}$/)
      .optional(),
  ),
  /**
   * Secure pool URL, only when the owner publishes one.
   * NO DEFAULT. Blank omits the line.
   */
  MINING_POOL_SECURE_URL: blankAsAbsent(z.string().min(1).max(LINE_MAX).optional()),
  /**
   * Worker-name pattern a miner copies.
   * NO DEFAULT. Blank omits the pattern.
   */
  MINING_WORKER_NAME_PATTERN: blankAsAbsent(z.string().min(1).max(PATTERN_MAX).optional()),
  /**
   * How many reachability probes one account may make in the window.
   * NO DEFAULT. Blank refuses `mining.probe_limit_unset`.
   */
  MINING_PROBE_LIMIT: blankAsAbsent(z.coerce.number().int().min(0).max(LIMIT_MAX).optional()),
  /**
   * Reachability probe window in milliseconds.
   * NO DEFAULT. Blank refuses `mining.probe_limit_unset`.
   */
  MINING_PROBE_WINDOW_MS: blankAsAbsent(z.coerce.number().int().min(1).max(WINDOW_MAX_MS).optional()),
  /**
   * How long one reachability probe waits, in milliseconds.
   * NO DEFAULT. Blank refuses `mining.probe_timeout_unset`.
   */
  MINING_PROBE_TIMEOUT_MS: blankAsAbsent(z.coerce.number().int().min(1).max(TIMEOUT_MAX_MS).optional()),
  /**
   * Share difficulty a worker gets when its account set no minimum.
   * NO DEFAULT. Blank is reported as `mining.default_difficulty_unset` on the worker roster.
   */
  MINING_DEFAULT_DIFFICULTY: blankAsAbsent(z.string().regex(DIFFICULTY).optional()),
  /**
   * Matrix size n of the pool's reference proof-of-work check (2..64).
   * NO DEFAULT. All three proof-of-work settings blank: shares are not checked and a share carrying work refuses
   * `mining.pow_spec_unset`. Partly set or out of range refuses `mining.pow_spec_unset` (`pow.ts`).
   */
  MINING_POW_DIMENSION: blankAsAbsent(z.coerce.number().int().min(POW_DIMENSION_MIN).max(POW_DIMENSION_MAX).optional()),
  /**
   * Leading zero bits a share's work digest must have (1..32).
   * NO DEFAULT. Blank refuses `mining.pow_spec_unset`.
   */
  MINING_POW_TARGET_BITS: blankAsAbsent(z.coerce.number().int().min(1).max(POW_TARGET_BITS_MAX).optional()),
  /**
   * `true` for a testnet parameter set (its windows earn no credit, `mining.testnet_no_credit`). `false` (mainnet)
   * refuses `audit.external`: the live proof of work waits for the external audit.
   * NO DEFAULT. Blank refuses `mining.pow_spec_unset`.
   */
  MINING_POW_TESTNET: blankAsAbsent(z.enum(['true', 'false']).optional()),
  /**
   * Port the pool's miner door (`stratum-door.ts`) listens on; the address a rig dials is MINING_POOL_HOST and
   * MINING_POOL_PORT, which may sit in front of it.
   * NO DEFAULT. Blank leaves the door closed (`mining.stratum_unset`).
   */
  MINING_STRATUM_LISTEN_PORT: blankAsAbsent(
    z
      .string()
      .regex(/^[1-9]\d{0,4}$/)
      .optional(),
  ),
  /**
   * Length in seconds of one share window at the miner door (60..2678400); shares fall in fixed windows counted from the
   * Unix epoch.
   * NO DEFAULT. Blank leaves the door closed (`mining.stratum_unset`).
   */
  MINING_STRATUM_WINDOW_SECONDS: blankAsAbsent(z.coerce.number().int().min(60).max(2_678_400).optional()),
  /**
   * Asset a miner-door window is mined for.
   * NO DEFAULT. Blank leaves the door closed (`mining.stratum_unset`).
   */
  MINING_STRATUM_ASSET_ID: blankAsAbsent(z.string().regex(STRATUM_ASSET_PATTERN).optional()),
  /**
   * Seconds without an accepted share after which a worker is offline (10..86400); the miner door keeps no lasting
   * connection, so this is what "online" means.
   * NO DEFAULT. Blank refuses `mining.quiet_interval_unset` on `workers.one`, the roster shows no active or offline badge,
   * and the worker evaluator stays off.
   */
  MINING_WORKER_QUIET_SECONDS: blankAsAbsent(z.coerce.number().int().min(10).max(86_400).optional()),
  /**
   * How often, in seconds, the worker evaluator looks for quiet workers and records their state changes (1..3600).
   * NO DEFAULT. Blank keeps the evaluator off (`mining.worker_evaluate_unset` in the log).
   */
  MINING_WORKER_EVALUATE_SECONDS: blankAsAbsent(z.coerce.number().int().min(1).max(3_600).optional()),
  /**
   * The share of a worker's trailing accepted weight, in basis points (1..10000), that an automatic alert limit is.
   * NO DEFAULT. Blank leaves an automatic alert limit unset (`mining.alert_limit_unset`).
   */
  MINING_WORKER_ALERT_SHARE_BPS: blankAsAbsent(z.coerce.number().int().min(1).max(10_000).optional()),
});

/** A whole share difficulty as published: digits, no leading zero, below 10^38. Blank is null; anything else is invalid. */
export function publishedDifficulty(raw: string | undefined): Published {
  const line = publishedText(raw, 38, false);
  if (line === null || line === 'invalid') return line;
  return DIFFICULTY.test(line) ? line : 'invalid';
}

export type Published = string | null | 'invalid';

function controls(value: string, multiline: boolean): boolean {
  const stripped = multiline ? value.replace(/[\n\t]/g, '') : value;
  return /[\u0000-\u001F\u007F]/.test(stripped);
}

/** Trimmed owner text. Blank is null. Too long or containing control characters is invalid, never truncated. */
export function publishedText(raw: string | undefined, max: number, multiline: boolean): Published {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max || controls(trimmed, multiline)) return 'invalid';
  if (!multiline && /[\n\r]/.test(trimmed)) return 'invalid';
  return trimmed;
}

const HOST =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)$/;

/** A hostname or IPv4 the owner published. No scheme, no port, no caller-supplied address. */
export function publishedHost(raw: string | undefined): Published {
  const line = publishedText(raw, HOST_MAX, false);
  if (line === null || line === 'invalid') return line;
  if (!HOST.test(line)) return 'invalid';
  return line;
}

/** Port digits as published. No leading zero, no default. */
export function publishedPort(raw: string | undefined): Published {
  const line = publishedText(raw, 5, false);
  if (line === null || line === 'invalid') return line;
  if (!/^[1-9]\d{0,4}$/.test(line)) return 'invalid';
  const n = Number(line);
  if (n < 1 || n > 65_535) return 'invalid';
  return line;
}

/** Whole number inside the bound. Blank is null. Anything else is invalid, never clamped. */
export function publishedInt(raw: string | undefined, min: number, max: number): number | null | 'invalid' {
  const line = publishedText(raw, 12, false);
  if (line === null || line === 'invalid') return line;
  if (!/^(0|[1-9]\d{0,8})$/.test(line)) return 'invalid';
  const n = Number(line);
  if (!Number.isSafeInteger(n) || n < min || n > max) return 'invalid';
  return n;
}

export const OVERVIEW_TEXT_MAX = TEXT_MAX;
export const OVERVIEW_VERSION_MAX = VERSION_MAX;
export const CONNECTION_URL_MAX = LINE_MAX;
export const WORKER_PATTERN_MAX = PATTERN_MAX;
export const PROBE_LIMIT_MAX = LIMIT_MAX;
export const PROBE_WINDOW_MAX_MS = WINDOW_MAX_MS;
export const PROBE_TIMEOUT_MAX_MS = TIMEOUT_MAX_MS;
