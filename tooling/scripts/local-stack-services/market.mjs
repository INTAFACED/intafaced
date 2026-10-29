import { profileEnvFor } from '../owner-settings.mjs';

/**
 * `LOCAL_STACK_MARKET_REFUND_POLICY=off` on a start or restart leaves the refund window blank while the TEST commission
 * stays, so a refund ask is read refusing `market.refund_policy_unset` in the running app (J-more-catalogue-02 #6).
 */
export function marketRefundPolicy() {
  const asked = process.env.LOCAL_STACK_MARKET_REFUND_POLICY;
  if (asked === undefined) return true;
  if (asked === 'off') return false;
  throw new Error(`LOCAL_STACK_MARKET_REFUND_POLICY is "${asked}"; leave it unset for the TEST window, or set it to off.`);
}

function published() {
  const values = profileEnvFor('market', 'dev');
  if (!marketRefundPolicy()) delete values.MARKET_REFUND_WINDOW_SECONDS;
  return values;
}

export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  name: 'market',
  env: () => ({
    ...c('svc-market', PORTS.market),
    DATABASE_URL: dbUrl('svc_market', secrets),
    TOKEN_URL: urlOf('token'),
    LEDGER_URL: urlOf('ledger'),
    IDENTITY_URL: urlOf('identity'),
    // LOCAL TEST only, the labelled values in tooling/profiles/test-owner-values/market.json: the house commission, so a
    // purchase settles, and the refund window a purchase is held for (J-more-catalogue-02 #4 to #6). Production stays
    // blank: a purchase refuses market.commission_not_configured, and a refund ask market.refund_policy_unset.
    ...published(),
  }),
});
