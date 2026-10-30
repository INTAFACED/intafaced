import { createHash } from 'node:crypto';
import path from 'node:path';

export default ({ c, secrets, dbUrl, urlOf, PORTS, STATE }) => ({
  name: 'pay',
  env: () => ({
    ...c('svc-pay', PORTS.pay),
    DATABASE_URL: dbUrl('svc_pay', secrets),
    LEDGER_URL: urlOf('ledger'),
    IDENTITY_URL: urlOf('identity'),
    // W-withdraw-14: a withdrawal to another account's platform address is one send at svc-bank (transfers.settleWithdrawal).
    BANK_URL: urlOf('bank'),
    IDENTITY_ADMISSION_SECRET: secrets.payAdmission,
    PAY_CRYPTO_WEBHOOK_SECRET: secrets.payCryptoWebhook,
    PAY_CARD_SANDBOX_WEBHOOK_SECRET: secrets.payCardWebhook,
    // The TEST bank for pushed bank transfers at hosted checkout (J-merchant-04 step 6): no real bank, transfers arrive only
    // through `local-test-stack.mjs bank-transfer`. svc-pay refuses this secret outside APP_ENV dev or test.
    PAY_BANK_TRANSFER_SANDBOX_WEBHOOK_SECRET: secrets.payBankTransferWebhook,
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
    // `LOCAL_STACK_PAY_STARTER_FEE=off` on a start or restart leaves it blank, so the refusal to open an account can be seen
    // too (J-merchant-02 #1).
    ...(process.env.LOCAL_STACK_PAY_STARTER_FEE === 'off' ? {} : { PAY_MERCHANT_STARTER_FEE_BPS: '250' }),
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
    // LOCAL-TEST screener for custodial sends (W9): answers clear, recorded as provider local-test, so J-wallet-07 #3-#5 can
    // walk an internal withdrawal. No supplier is connected anywhere else; svc-pay refuses it outside APP_ENV dev or test.
    // `LOCAL_STACK_PAY_SCREENER=off` on a start or restart leaves it blank, so the blank-list refusal can be seen too
    // (J-wallet-05 #2).
    ...(process.env.LOCAL_STACK_PAY_SCREENER === 'off' ? {} : { PAY_SCREENING_SCREENER: 'local-test' }),
    // LOCAL-TEST value (tooling/profiles/test-owner-values/pay.json): the largest product image, 500 KB.
    PAY_PRODUCT_IMAGE_MAX_BYTES: '500000',
    // LOCAL-TEST value (tooling/profiles/test-owner-values/pay.json): the largest hosted checkout logo, 100 KB.
    PAY_CHECKOUT_LOGO_MAX_BYTES: '100000',
    // LOCAL-TEST value (tooling/profiles/test-owner-values/pay.json): the risk band the hosted checkout routes with.
    PAY_CHECKOUT_RISK_BAND: 'low',
    // LOCAL-TEST value (same file): the success fraction smart routing reads for each checkout rail.
    PAY_CHECKOUT_SUCCESS_RATES: 'crypto-native:0.9,bank-transfer-sandbox:0.9',
    // LOCAL-TEST: the hosted checkout takes crypto and TEST bank transfers. The TEST bank exists only on this stack.
    PAY_CHECKOUT_RAILS: 'crypto-native:crypto,bank-transfer-sandbox:bank_transfer',
    // LOCAL-TEST value (same file): RC-merchant-09, a bank transfer is captured only when the name on the sending account
    // matches the name the payer gave, after case, accents, punctuation and spacing. Anything else is held for review.
    PAY_PAYER_NAME_MATCH_RULE: 'exact_normalised',
    // LOCAL-TEST value (tooling/profiles/test-owner-values/pay.json): J-merchant-02 #5, a newly verified payout destination
    // is held 45 seconds before it can receive a payout (a change of a verified one waits as long), short enough for a
    // journey to wait it out. Not an owner decision; blank refuses every verification and change (pay.destination_hold_unset).
    PAY_DESTINATION_HOLD_SECONDS: '45',
    // Withdrawal limits per KYC tier are enforced (D-148). The figures are LOCAL-TEST ones set by local-test-gates.mjs through
    // founderAdmin.limits.change (TEST_WITHDRAWAL_LIMITS), and a founder's override for one customer comes from identity.
    PAY_WITHDRAWAL_LIMITS: 'required',
    // LOCAL-TEST: a TEST custody signer for TEST Ethereum only (J-wallet-05 #6), so a send out to a saved TEST wallet goes
    // through this stack's crypto-native rail, which is the in-memory MemoryChain: no chain, no key, nothing leaves. TEST Base
    // has none, so a send there is refused before anything is held (J-wallet-05 #7). svc-pay refuses this outside APP_ENV dev
    // or test; no live signer exists anywhere.
    PAY_TEST_WITHDRAW_SIGNER_NETWORKS: 'ethereum',
    // LOCAL-TEST pace for that in-memory chain (J-wallet-05 #8), so a real send can be watched on its page: every send waits
    // 6 seconds after it is recorded before it answers, as a node waits for confirmations, and a send of exactly 13 is
    // refused before anything is recorded, so its hold comes back and the page says why. svc-pay refuses both outside
    // APP_ENV dev or test, and beside a live chain.
    PAY_TEST_CHAIN_SEND_DELAY_MS: '6000',
    PAY_TEST_CHAIN_REFUSE_AMOUNT: '13',
    // LOCAL-TEST: that in-memory chain keeps its own TEST record of each send out of custody, in the stack's rail records
    // (local-test-rail-records.mjs reads them), so rail crypto-native is reconciled in the chain's words, never the ledger's.
    // svc-pay refuses this outside APP_ENV dev or test, or over any chain but the sandbox one.
    PAY_TEST_RAIL_RECORDS_DIR: path.join(STATE, 'test-rail-records'),
  }),
});
