import { z } from 'zod';

/**
 * Merchant names (migration 0071). One rule, used by the onboarding input, the
 * service and (by shape) the database CHECKs: after trimming spaces a name is
 * 1..120 characters and holds no control character (C0, DEL or C1), so it cannot
 * carry a newline, tab or terminal escape into a table, a CSV export or a log line.
 */
export const MERCHANT_NAME_MAX = 120;

// eslint-disable-next-line no-control-regex -- the point of this pattern is to match control characters
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** The trimmed name when it is valid, otherwise null. Never throws. */
export function cleanMerchantName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || [...trimmed].length > MERCHANT_NAME_MAX || CONTROL_CHARACTER.test(trimmed)) return null;
  return trimmed;
}

/** For the onboarding input: refuse a bad name loudly rather than store a changed one. */
export const merchantNameInputSchema = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => cleanMerchantName(v) !== null, {
    message: `A name must be 1 to ${MERCHANT_NAME_MAX} characters with no control characters`,
  });

export interface MerchantNames {
  displayName: string | null;
  legalName: string | null;
}

/**
 * What to store at onboarding.
 *
 * - An explicit `legalName` / `displayName` wins.
 * - A client that has not been updated still sends the legal name inside
 *   `settlementPrefs.businessDetails.legalName` (the portal did, before names had
 *   their own fields), so that is read as the legal name. A malformed value there is
 *   ignored, not refused: it is free-form JSON the service never promised to validate.
 * - A merchant that gave one name is known by it, so a missing display name falls
 *   back to the legal name. Nothing else is ever guessed.
 */
export function resolveMerchantNames(input: {
  displayName?: string | null | undefined;
  legalName?: string | null | undefined;
  settlementPrefs?: Record<string, unknown> | undefined;
}): MerchantNames {
  const details = input.settlementPrefs?.businessDetails;
  const fromPrefs =
    details !== null && typeof details === 'object' ? cleanMerchantName((details as Record<string, unknown>).legalName) : null;
  const legalName = cleanMerchantName(input.legalName) ?? fromPrefs;
  const displayName = cleanMerchantName(input.displayName) ?? legalName;
  return { displayName, legalName };
}
