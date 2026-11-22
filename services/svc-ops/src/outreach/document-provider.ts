import type { CrmDocumentProviderAdapter } from '@intafaced/contracts';
import { crmDocumentProviderReadInputSchema } from '@intafaced/contracts/crm-workflows';

/** Free entitlement has no verified API access. Never interpret unavailable reads as zero views. */
export const papermarkFreeAdapter: CrmDocumentProviderAdapter = {
  async status() {
    return { status: 'disabled', reason: 'api_access_unavailable' };
  },
  async readViews(input) {
    crmDocumentProviderReadInputSchema.parse(input);
    return { status: 'unavailable', reason: 'api_access_unavailable' };
  },
};
