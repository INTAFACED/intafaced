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
const DIFFICULTY = /^[1-9]\d{0,37}$/;

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
