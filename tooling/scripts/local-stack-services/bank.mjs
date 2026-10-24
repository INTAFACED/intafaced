import { loadProfile } from '../owner-settings.mjs';

/** One labelled TEST value from this service's profile file; a missing one names the file instead of a bare TypeError. */
function testValue(name) {
  const entry = loadProfile().values[name];
  if (!entry) throw new Error(`${name} is missing from tooling/profiles/test-owner-values/bank.json.`);
  return entry.value;
}

export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  name: 'bank',
  env: () => ({
    ...c('svc-bank', PORTS.bank),
    DATABASE_URL: dbUrl('svc_bank', secrets),
    LEDGER_URL: urlOf('ledger'),
    IDENTITY_URL: urlOf('identity'),
    TRADE_URL: urlOf('trade'),
    // Required, no default (owner-unpublished). Inert LOCAL TEST placeholders so the service can
    // boot: the jobs they size are all switched off below, so no batch size is ever exercised.
    LOAN_QUOTE_ASSET_ID: 'USDT',
    TRANSFER_BATCH_SIZE: '1',
    LOAN_SWEEP_BATCH_SIZE: '1',
    // LOCAL TEST, not owner decisions (BK-acct-01, BK-acct-03, BK-pots-01): blank refuses each by name, so the
    // J-bank-01 journey can read labelled TEST account terms, add and remove a currency, make spaces up to a TEST
    // limit and see the account details per currency switched off with rail.bank (no banking partner here).
    BANK_ACCOUNT_TERMS_JSON: JSON.stringify({
      tier: 'TEST base tier',
      version: 'local-test-1',
      currency: 'USDT',
      monthlyFee: '0',
      minimumBalance: '0',
      overdraftFee: null,
      included: ['TEST spaces for your goals', 'TEST moves between your spaces'],
    }),
    BANK_ACCOUNT_CURRENCIES: 'USDT,USDC,BTC,ETH',
    BANK_SPACE_LIMIT: '5',
    BANK_ACCOUNT_DETAILS_CURRENCIES: 'EUR,GBP,USD',
    // LOCAL TEST values, not owner decisions: how many withdrawal addresses one person may save, and how long a
    // new one waits before money may leave to it. Unset, the address book refuses saves and lists every row as
    // blocked (bank.offramp_cooling_unset).
    // LOCAL TEST card simulator (no issuer, no network): cards can be issued, frozen and closed, so the console's
    // account close (J-ops-console-04 #7) can be proved against an account that holds a card. Never a live issuer.
    BANK_CARD_ISSUER: 'card-sim',
    BANK_ADDRESS_BOOK_CAP: '10',
    BANK_OFFRAMP_COOLING_HOURS: '24',
    // LOCAL TEST values: how long a wallet ownership proof stays open to sign, and how long a verified one holds.
    BANK_WALLET_PROOF_WINDOW_MINUTES: '30',
    BANK_WALLET_PROOF_VALID_DAYS: '180',
    // LOCAL TEST values from the bank profile, not owner decisions (BK-xfer-07): one made-up blocked payee, one made-up
    // exchange account with a small allowance, and the proof files a held send may upload. Unset, every global send
    // refuses before its quote, so the sending journeys could not reach a hold or a refusal on this stack.
    BANK_PAYEE_CONTROLS_JSON: testValue('BANK_PAYEE_CONTROLS_JSON'),
    BANK_EXCHANGE_ALLOWANCE_JSON: testValue('BANK_EXCHANGE_ALLOWANCE_JSON'),
    BANK_PROOF_LIMITS_JSON: testValue('BANK_PROOF_LIMITS_JSON'),
    // LOCAL TEST stand-in for a global-send partner (no network, pays nobody, refused under live posture): it answers
    // from the TEST catalogue in the bank profile, so a global send can pass its corridor, quote and payee checks and post
    // once to the stand-in's rail boundary on this stack. The send-field rules are TEST reference lengths for its methods.
    BANK_GLOBAL_PARTNER: 'global-sim',
    BANK_GLOBAL_SIM_JSON: testValue('BANK_GLOBAL_SIM_JSON'),
    BANK_SEND_FIELD_RULES_JSON: testValue('BANK_SEND_FIELD_RULES_JSON'),
    // LOCAL TEST value from the bank profile, not an owner decision (BK-xfer-06): how long a new bank-rail recipient waits
    // before money may go to it. Unset, every send to a saved recipient refuses bank.payee_cooling_unset.
    BANK_PAYEE_COOLING_HOURS: testValue('BANK_PAYEE_COOLING_HOURS'),
    // LOCAL TEST value from the bank profile (BK-xfer-08): how long a global send may stay on hold before it is cancelled.
    BANK_GLOBAL_HOLD_CANCEL_HOURS: testValue('BANK_GLOBAL_HOLD_CANCEL_HOURS'),
    // LOCAL TEST value from the bank profile (BK-xfer-09): the fee on refunding a send the rail returned.
    BANK_GLOBAL_REFUND_FEE: testValue('BANK_GLOBAL_REFUND_FEE'),
    // LOCAL TEST value from the bank profile (J-bank-06): how close to its next run a standing order may still be edited.
    BANK_SCHEDULE_EDIT_CUTOFF_MINUTES: testValue('BANK_SCHEDULE_EDIT_CUTOFF_MINUTES'),
    // Nothing moves money in the background of a test stack.
    // The standing-order runner has no timer: it is a signed job door, and on this stack only a test's own signed call
    // (J-bank-06) runs it. Left off, a one-off or a standing order could never be shown running here.
    SCHEDULED_TRANSFERS_ENABLED: 'true',
    AUTO_INVEST_ENABLED: 'false',
    INTEREST_ACCRUAL_ENABLED: 'false',
    LOAN_ACCRUAL_ENABLED: 'false',
    LOAN_RISK_SWEEP_ENABLED: 'false',
  }),
});
