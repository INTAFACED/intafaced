import { createHash } from 'node:crypto';

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
    // The stack's own key for business verification documents (generated once in secrets.json), so uploads are stored encrypted.
    PAY_KYB_DOC_KEY: secrets.payKybDocKey,
    // The stack's own travel-rule sealing key (generated once in secrets.json), so a deposit declaration is stored sealed.
    // 32 bytes as base64, derived from the stored secret, so plan mode's placeholder gives a valid key too.
    PAY_TRAVEL_RULE_MESSAGE_KEY: createHash('sha256').update(secrets.payTravelRuleKey).digest('base64'),
    PAY_TRAVEL_RULE_MESSAGE_KEY_ID: 'local-test-1',
    // LOCAL-TEST value (tooling/profiles/test-owner-values/pay.json): a business application is due 30 days after it starts.
    PAY_KYB_APPLICATION_DUE_DAYS: '30',
    // LOCAL-TEST scanner for information-request files: infected only when a file carries the EICAR test string. svc-pay refuses it outside APP_ENV dev or test.
    PAY_KYB_MALWARE_SCANNER: 'local-test-eicar',
    // LOCAL-TEST value (tooling/profiles/test-owner-values/pay.json): the largest product image, 500 KB.
    PAY_PRODUCT_IMAGE_MAX_BYTES: '500000',
    // LOCAL-TEST value (tooling/profiles/test-owner-values/pay.json): the largest hosted checkout logo, 100 KB.
    PAY_CHECKOUT_LOGO_MAX_BYTES: '100000',
    // LOCAL-TEST value (tooling/profiles/test-owner-values/pay.json): the risk band the hosted checkout routes with.
    PAY_CHECKOUT_RISK_BAND: 'low',
    // LOCAL-TEST value (same file): the success fraction smart routing reads for the crypto rail.
    PAY_CHECKOUT_SUCCESS_RATES: 'crypto-native:0.9',
  }),
});
