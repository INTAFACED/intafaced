import type { CampaignsRefusalCode } from '@intafaced/contracts/campaigns-drops';

/** A named refusal. The code leads the tRPC message in brackets so the screens can quote it. */
export class CampaignsError extends Error {
  constructor(
    readonly code: CampaignsRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'CampaignsError';
  }
}
