// LOCAL TEST only, labelled in tooling/profiles/test-owner-values/market.json: the refund policy (MC-market-02). A journey
// restarts market with LOCAL_STACK_MARKET_REFUND_POLICY=off to prove the blank refusal (owner.decision).
const refundPolicy = () => (process.env.LOCAL_STACK_MARKET_REFUND_POLICY === 'off' ? {} : { MARKET_REFUND_POLICY: 'seller_full' });

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
  }),
});
