import { MERCHANT_NAME_MAX, cleanMerchantName, merchantNameInputSchema } from '@intafaced/contracts/pay-call-schemas';

// eslint-disable-next-line no-control-regex -- the point of this pattern is to match control characters

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
export { MERCHANT_NAME_MAX, cleanMerchantName, merchantNameInputSchema };
