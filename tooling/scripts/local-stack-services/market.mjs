// LOCAL TEST only, labelled in tooling/profiles/test-owner-values/market.json: the refund policy (MC-market-02). A journey
// restarts market with LOCAL_STACK_MARKET_REFUND_POLICY=off to prove the blank refusal (owner.decision).
const refundPolicy = () => (process.env.LOCAL_STACK_MARKET_REFUND_POLICY === 'off' ? {} : { MARKET_REFUND_POLICY: 'seller_full' });
// LOCAL TEST only, labelled in the same file: the listing review criteria (MC-market-03). A journey restarts market with
// LOCAL_STACK_MARKET_REVIEW_CRITERIA=off to see the founders' queue wait while the owner's criteria are blank.
const reviewCriteria = () =>
  process.env.LOCAL_STACK_MARKET_REVIEW_CRITERIA === 'off'
    ? {}
    : { MARKET_LISTING_REVIEW_CRITERIA: 'TEST criteria: the listing says what it sells | TEST criteria: its price and period are stated' };

export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  name: 'market',
  env: () => ({
    ...c('svc-market', PORTS.market),
    DATABASE_URL: dbUrl('svc_market', secrets),
    TOKEN_URL: urlOf('token'),
    LEDGER_URL: urlOf('ledger'),
    IDENTITY_URL: urlOf('identity'),
    // LOCAL TEST only, the labelled value in tooling/profiles/test-owner-values/market.json: the house commission on a
    // Market sale. Production stays blank and every listing and purchase refuses (market.commission_not_configured).
    MARKET_HOUSE_COMMISSION_BPS: '100',
    // LOCAL TEST only, labelled in the same file: a purchase is held for a two-minute refund window, and a sweep every
    // 5 s releases it after (MC-market-02). Production leaves all three unset: purchases pay through, and with the switch
    // on but no window every purchase refuses (market.refund_window_unset).
    MARKET_PURCHASE_HOLD: 'on',
    MARKET_REFUND_WINDOW_SECONDS: '120',
    MARKET_RELEASE_SWEEP_SECONDS: '5',
    ...refundPolicy(),
    // LOCAL TEST only, labelled in the same file: two founders review each new listing against TEST criteria within a
    // TEST one-day window. Production leaves both unset, and every listing waits in applied (market.review_criteria_unset).
    ...reviewCriteria(),
    MARKET_LISTING_REVIEW_WINDOW_SECONDS: '86400',
  }),
});
