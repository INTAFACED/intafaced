import type { z } from 'zod';
import { merchantPartnerTermsSchema } from '@intafaced/contracts/merchant-metrics';
import { registerRefusals } from '../refusal';
import type { PortalTools } from '../api-tools';
import { mc } from './copy';

/**
 * svc-pay `merchantMetrics.partnerTerms`, read with the contract's own schema: the acquiring partner's terms for this
 * business (reserve rule, who covers a chargeback shortfall, the currencies it offers, its instant payout). A term the
 * partner has not given is `{ known: false }` and reads "not known", never zero (CUSTODY-DELTA §1.3; OWNER 226).
 */
export const partnerTermsSchema = merchantPartnerTermsSchema;
export type PartnerTerms = z.infer<typeof partnerTermsSchema>;

/** No acquiring partner on this deployment: there is no partner to have said anything. */
export const PARTNER_TERMS_UNAVAILABLE = 'pay.partner_terms_unavailable';
registerRefusals({ [PARTNER_TERMS_UNAVAILABLE]: () => mc.t('rPartnerTermsUnavailable') });

export const partnerTermsApi = ({ query }: PortalTools) => ({
  partnerTerms: (merchantId: string, signal?: AbortSignal) =>
    query('merchantMetrics.partnerTerms', { merchantId }, partnerTermsSchema, signal),
});
