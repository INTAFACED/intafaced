import { formatAmount } from '@intafaced/ledger-client';
import type { MerchantPartnerTerms } from '@intafaced/contracts';
import type { RailAdapter } from './rails/rail-adapter.js';
import { MetricsError } from './metrics/errors.js';
import { testAcquirerSwitchesAllowed } from './rails/posture.js';

/**
 * `merchantMetrics.partnerTerms`: the acquiring partner's own terms for one business, as the partner has given them
 * (CUSTODY-DELTA §1.3 "Unknown, never zero"; OWNER 226). The answer is the adapter's, copied to the wire and never
 * filled in: a term the partner has not given stays `{ known: false }`, which the rooms show as "not known".
 *
 * The acquiring partner is the registered rail that reports partner terms. Today that is only the labelled TEST
 * acquirer (`card-sandbox`), which production refuses at boot (`rails/posture.ts`); its terms are refused in staging and
 * prod even where an operator lets the rail boot (`testAcquirerSwitchesAllowed`). With none registered the read
 * refuses `pay.partner_terms_unavailable`, never "not known": "not known" is a partner's silence, and there is no partner.
 */
export function readPartnerTerms(
  rails: readonly RailAdapter[],
  merchantId: string,
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): MerchantPartnerTerms {
  const acquirer = rails.find((r) => typeof r.partnerTerms === 'function');
  // The TEST acquirer is the only partner, and its terms are refused outside dev and test, override or not.
  if (!acquirer?.partnerTerms || acquirer.mode !== 'sandbox' || !testAcquirerSwitchesAllowed(env)) {
    throw new MetricsError('pay.partner_terms_unavailable', 'pay.partner_terms_unavailable');
  }
  const t = acquirer.partnerTerms(merchantId);
  const instant: MerchantPartnerTerms['instantPayout'] = !t.instantPayout.known
    ? { known: false }
    : !t.instantPayout.offered
      ? { known: true, offered: false }
      : {
          known: true,
          offered: true,
          fee: t.instantPayout.fee.known
            ? { known: true, amount: formatAmount(t.instantPayout.fee.amount), assetCode: t.instantPayout.fee.assetId }
            : { known: false },
        };
  return {
    merchantId,
    partner: 'TEST',
    asOf: now.toISOString(),
    reserveRule: t.reserveRule.known
      ? { known: true, rollingReserveBps: t.reserveRule.rollingReserveBps, holdDays: t.reserveRule.holdDays }
      : { known: false },
    shortfallCover: t.shortfallCover.known ? { known: true, who: t.shortfallCover.who } : { known: false },
    currencies: t.currencies.known ? { known: true, offered: [...t.currencies.offered] } : { known: false },
    instantPayout: instant,
  };
}
