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
