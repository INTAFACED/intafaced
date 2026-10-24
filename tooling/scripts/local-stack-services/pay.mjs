export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  name: 'pay',
  env: () => ({
    ...c('svc-pay', PORTS.pay),
    DATABASE_URL: dbUrl('svc_pay', secrets),
    LEDGER_URL: urlOf('ledger'),
    IDENTITY_URL: urlOf('identity'),
    IDENTITY_ADMISSION_SECRET: secrets.payAdmission,
    PAY_CRYPTO_WEBHOOK_SECRET: secrets.payCryptoWebhook,
    PAY_CARD_SANDBOX_WEBHOOK_SECRET: secrets.payCardWebhook,
    PAY_CRYPTO_WATCHER_ENABLED: 'false', // no chain RPC in the local stack
    PAY_ALLOW_SANDBOX_RAILS: 'false',
    // Required, no default. LOCAL TEST values copied from .env.example.
    PAY_OPERATOR_CREDIT_RAILS: 'card-sandbox',
    PAY_MIN_CONFIRMATIONS: '6',
    PAY_WEBHOOK_TOLERANCE_SECONDS: '300',
    PAY_CHECKOUT_SESSION_TTL_SECONDS: '900',
    PAY_CHECKOUT_MAX_OPEN_SESSIONS: '25',
    PAY_LINK_DEFAULT_TTL_DAYS: '30',
    PAY_LINK_MAX_TTL_DAYS: '365',
    // LOCAL-TEST value, not INTAFACED pricing. 250 bps is a labelled stand-in so the local portal can show a fee. The product stays unset wherever this variable is absent.
    PAY_MERCHANT_STARTER_FEE_BPS: '250',
    // LOCAL-TEST merchant terms (tooling/profiles/test-owner-values/pay.json), so go-live can show and accept them. svc-pay refuses a TEST version outside APP_ENV dev or test.
    PAY_MERCHANT_TERMS_VERSION: 'TEST-merchant-terms-1',
    PAY_MERCHANT_TERMS_URL: 'https://terms.example/TEST-merchant-terms-1',
  }),
});
