import { QUANT_SANDBOX_SOURCE_ENVELOPE } from '@intafaced/contracts/quant-sandbox-procedures';
import { QUANT_SANDBOX_MAX_OPS_UNSET, QUANT_SANDBOX_MAX_SOURCE_UNSET, QuantError } from '../errors.js';

/**
 * Owner-published isolate ceilings. Blank / non-integer / out of range refuse.
 * Never invent 50000 ops or 8000 source chars. Never clamp.
 * Refuse codes: quant.sandbox_max_ops_unset, quant.sandbox_max_source_unset.
 *
 * Env schema envelope (not a published default) for tRPC input when unpublished.
 */
export const SANDBOX_MAX_OPS_MIN = 100;
export const SANDBOX_MAX_OPS_MAX = 1_000_000;
export const SANDBOX_MAX_SOURCE_MIN = 32;
/** The record's own ceiling on a source (`sandbox.run`), the most `SANDBOX_MAX_SOURCE` may be. */
export const SANDBOX_MAX_SOURCE_ENVELOPE = QUANT_SANDBOX_SOURCE_ENVELOPE;

export function assertPublishedSandboxMaxOps(max: number | undefined): number {
  if (max === undefined || typeof max !== 'number' || !Number.isInteger(max) || max < SANDBOX_MAX_OPS_MIN || max > SANDBOX_MAX_OPS_MAX) {
    throw new QuantError(QUANT_SANDBOX_MAX_OPS_UNSET, 'set SANDBOX_MAX_OPS (never invent 50000)');
  }
  return max;
}

export function assertPublishedSandboxMaxSource(max: number | undefined): number {
  if (
    max === undefined ||
    typeof max !== 'number' ||
    !Number.isInteger(max) ||
    max < SANDBOX_MAX_SOURCE_MIN ||
    max > SANDBOX_MAX_SOURCE_ENVELOPE
  ) {
    throw new QuantError(QUANT_SANDBOX_MAX_SOURCE_UNSET, 'set SANDBOX_MAX_SOURCE (never invent 8000)');
  }
  return max;
}

/** The longest source `sandbox.run` takes here: owner pin when published, the envelope when not (isolate still refuses unset). */
export function sandboxSourceInputMax(maxSource: number | undefined): number {
  if (
    typeof maxSource === 'number' &&
    Number.isInteger(maxSource) &&
    maxSource >= SANDBOX_MAX_SOURCE_MIN &&
    maxSource <= SANDBOX_MAX_SOURCE_ENVELOPE
  ) {
    return maxSource;
  }
  return SANDBOX_MAX_SOURCE_ENVELOPE;
}
