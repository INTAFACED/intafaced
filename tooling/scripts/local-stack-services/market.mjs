import { profileEnvFor } from '../owner-settings.mjs';

/** LOCAL TEST only: the short window `LOCAL_STACK_MARKET_REFUND_POLICY=short` holds a purchase for. Not an owner value. */
export const SHORT_TEST_REFUND_WINDOW_SECONDS = '20';

/**
 * `LOCAL_STACK_MARKET_REFUND_POLICY=off` on a start or restart leaves the refund window blank while the TEST commission
 * stays, so a refund ask is read refusing `market.refund_policy_unset` in the running app (J-more-catalogue-02 #6).
 * `short` holds a new purchase for a TEST 20 seconds instead of the hour, so a journey sees its window end and the
 * release post (J-more-catalogue-02 #6). Returns 'test', 'off' or 'short'.
 */
export function marketRefundPolicy() {
  const asked = process.env.LOCAL_STACK_MARKET_REFUND_POLICY;
  if (asked === undefined) return 'test';
  if (asked === 'off' || asked === 'short') return asked;
  throw new Error(`LOCAL_STACK_MARKET_REFUND_POLICY is "${asked}"; leave it unset for the TEST window, or set it to off or short.`);
}

function published() {
  const values = profileEnvFor('market', 'dev');
  const policy = marketRefundPolicy();
  if (policy === 'off') delete values.MARKET_REFUND_WINDOW_SECONDS;
  if (policy === 'short') values.MARKET_REFUND_WINDOW_SECONDS = SHORT_TEST_REFUND_WINDOW_SECONDS;
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
    // LOCAL TEST only, the labelled values in tooling/profiles/test-owner-values/market.json: the house commission on a
    // Market sale, and the refund window a purchase is held for (J-more-catalogue-02 #4 to #6). Production stays blank:
    // every listing and purchase refuses market.commission_not_configured, and a refund ask market.refund_policy_unset.
    ...published(),
  }),
});
