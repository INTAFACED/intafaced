import { createHash } from 'node:crypto';
import type { CampaignsRefusalCode } from '@intafaced/contracts/campaigns-drops';
import type { CampaignRefusalCode } from '@intafaced/contracts/campaigns-catalogue';

/** A named refusal. The code leads the tRPC message in brackets so the screens can quote it. */
export class CampaignsError extends Error {
  constructor(
    readonly code: CampaignsRefusalCode | CampaignRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'CampaignsError';
  }
}

/**
 * A voucher code as it is looked up and stored (J-campaigns-17): trimmed and upper case, then its SHA-256 hash in hex and
 * its last four characters. A code made in a batch or imported is stored as these two only, never in plain text.
 */
export const normalCode = (raw: string) => raw.trim().toUpperCase();
export const codeHashOf = (raw: string) => createHash('sha256').update(normalCode(raw), 'utf8').digest('hex');
export const lastFourOf = (raw: string) => normalCode(raw).slice(-4);
/** How a code reads where its plain text is not held: its last four characters after an ellipsis. */
export const maskedCode = (lastFour: string) => `…${lastFour}`;
