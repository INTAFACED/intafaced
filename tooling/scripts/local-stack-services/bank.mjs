import path from 'node:path';
import { loadProfile } from '../owner-settings.mjs';

/** One labelled TEST value from this service's profile file; a missing one names the file instead of a bare TypeError. */
function testValue(name) {
  const entry = loadProfile().values[name];
  if (!entry) throw new Error(`${name} is missing from tooling/profiles/test-owner-values/bank.json.`);
  return entry.value;
}

/** The staking risk wording (BK-earn-04): the profile's TEST wording, or blank when the stack is asked to show it unset. */
function earnRiskWording() {
  const asked = process.env.LOCAL_STACK_BANK_EARN_RISK_WORDING;
  if (asked === undefined || asked === '') return { BANK_EARN_RISK_WORDING_JSON: testValue('BANK_EARN_RISK_WORDING_JSON') };
  if (asked === 'off') return {};
  throw new Error(`LOCAL_STACK_BANK_EARN_RISK_WORDING is "${asked}"; leave it unset for the TEST wording, or set it to off.`);
}

/** The lending policy (BK-loan-01, J-bank-09 #1): new loans open, or switched off when the stack is asked to show it. */
function lendingPolicy() {
  const asked = process.env.LOCAL_STACK_BANK_LOANS;
  if (asked === undefined || asked === '') return {};
  if (asked === 'off') return { BANK_LOANS_ENABLED: 'false' };
  throw new Error(`LOCAL_STACK_BANK_LOANS is "${asked}"; leave it unset for loans open, or set it to off.`);
}

/**
 * The loan origination fee (BK-loan-01, J-bank-09 #3): the profile's TEST zero fee, blank when the stack is asked to
 * show it unset, or the profile's TEST non-zero fee when asked to publish one.
 */
function originationFee() {
  const asked = process.env.LOCAL_STACK_BANK_LOAN_ORIGINATION_FEE;
  if (asked === undefined || asked === '') return { BANK_LOAN_ORIGINATION_FEE_BPS: testValue('BANK_LOAN_ORIGINATION_FEE_BPS') };
  if (asked === 'off') return {};
  // LOCAL TEST non-zero fee, only to see a published fee refuse new loans bank.loan_fee_unwired (J-bank-09 #3).
  if (asked === 'published') return { BANK_LOAN_ORIGINATION_FEE_BPS: '50' };
  throw new Error(
    `LOCAL_STACK_BANK_LOAN_ORIGINATION_FEE is "${asked}"; leave it unset for the TEST zero fee, or set it to off or published.`,
  );
}

/** svc-pay as the deposit custody port, or none at all when the stack is asked to show custody unset. */
function depositCustody(urlOf) {
  const asked = process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY;
  if (asked === undefined || asked === '') return { PAY_URL: urlOf('pay') };
  if (asked === 'off') return {};
  throw new Error(`LOCAL_STACK_BANK_DEPOSIT_CUSTODY is "${asked}"; leave it unset for custody connected, or set it to off.`);
}

export default ({ c, secrets, dbUrl, urlOf, PORTS, STATE }) => ({
  name: 'bank',
  env: () => ({
    ...c('svc-bank', PORTS.bank),
    DATABASE_URL: dbUrl('svc_bank', secrets),
    LEDGER_URL: urlOf('ledger'),
    IDENTITY_URL: urlOf('identity'),
    TRADE_URL: urlOf('trade'),
    // Deposit catalogue and addresses come from svc-pay's custody paths; without it every deposit answer is "not published".
    // `LOCAL_STACK_BANK_DEPOSIT_CUSTODY=off` on a start or restart leaves it blank, so the Deposit room's custody-unset
    // refusal can be seen too (J-wallet-02 #1).
    ...depositCustody(urlOf),
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
    // LOCAL TEST value from the bank profile (BK-pots-02): how long an early unlock of a locked space waits. Unset, every
    // early unlock refuses bank.space_unlock_rule_unset and the space stays locked to its date.
    BANK_SPACE_UNLOCK_WAIT_HOURS: testValue('BANK_SPACE_UNLOCK_WAIT_HOURS'),
    // LOCAL TEST value from the bank profile (BK-pots-03): the smallest payment from another person the income sorter
    // splits. Unset, making a sorter refuses bank.sorter_terms_unset and no payment is sorted.
    BANK_INCOME_SORTER_MIN_CREDIT: testValue('BANK_INCOME_SORTER_MIN_CREDIT'),
    // LOCAL TEST values from the bank profile (BK-acct-09): how long a shared pot invite stays open and how many people one
    // pot may be shared with. Unset, inviting and accepting refuse bank.joint_unset and no pot is shared.
    BANK_SHARED_POT_INVITE_MINUTES: testValue('BANK_SHARED_POT_INVITE_MINUTES'),
    BANK_SHARED_POT_PEOPLE_CAP: testValue('BANK_SHARED_POT_PEOPLE_CAP'),
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
    // LOCAL TEST value: how long an emailed link that approves a new withdrawal address works (J-wallet-04 #5).
    BANK_ADDRESS_APPROVAL_LINK_MINUTES: '30',
    // LOCAL TEST values: how many deposit addresses one person may hold open per asset and network (small, so J-wallet-02 #4
    // reaches it), and how long an extra one lasts. Unset, making another deposit address refuses by name.
    BANK_DEPOSIT_ADDRESS_CAP: '3',
    BANK_DEPOSIT_ADDRESS_EXPIRY_DAYS: '30',
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
    // LOCAL TEST rate stand-in for add money (J-bank-02 #4; prices nothing real, opens no payment, refused under live
    // posture): it quotes only the asks its TEST catalogue lists, so a price can be shown, run out and be refused here.
    BANK_ONRAMP_RATES: 'ramp-sim',
    BANK_ONRAMP_SIM_JSON: testValue('BANK_ONRAMP_SIM_JSON'),
    // LOCAL TEST payout stand-in for cash out (J-bank-03 #4/#5; pays nobody, refused under live posture): it prices the
    // assets its TEST catalogue lists and takes a payout; verifying an account and saying paid, failed or returned are the
    // partner's signed job calls, which only a test makes here. Value moves to and from its own TEST rail boundary.
    BANK_PAYOUT_PARTNER: 'payout-sim',
    BANK_PAYOUT_SIM_JSON: testValue('BANK_PAYOUT_SIM_JSON'),
    // The stand-in keeps its own TEST record of rail payout-sim in the stack's records folder (read by
    // local-test-rail-records.mjs), so a reconciliation compares that rail with its own word, not the ledger's.
    BANK_PAYOUT_SIM_RECORDS_DIR: path.join(STATE, 'test-rail-records'),
    // LOCAL TEST stand-in for a direct debit scheme (BK-xfer-11; no network, pays nobody, refused under live posture): its
    // TEST creditors set up mandates and present collections only through the signed job doors, as J-bank-06 #4 does.
    BANK_DD_SCHEME: 'dd-sim',
    BANK_DD_SIM_JSON: testValue('BANK_DD_SIM_JSON'),
    // LOCAL TEST value from the bank profile, not an owner decision (BK-xfer-06): how long a new bank-rail recipient waits
    // before money may go to it. Unset, every send to a saved recipient refuses bank.payee_cooling_unset.
    BANK_PAYEE_COOLING_HOURS: testValue('BANK_PAYEE_COOLING_HOURS'),
    // LOCAL TEST value from the bank profile (BK-xfer-08): how long a global send may stay on hold before it is cancelled.
    BANK_GLOBAL_HOLD_CANCEL_HOURS: testValue('BANK_GLOBAL_HOLD_CANCEL_HOURS'),
    // LOCAL TEST value from the bank profile (BK-xfer-09): the fee on refunding a send the rail returned.
    BANK_GLOBAL_REFUND_FEE: testValue('BANK_GLOBAL_REFUND_FEE'),
    // LOCAL TEST value from the bank profile (J-bank-06): how close to its next run a standing order may still be edited.
    BANK_SCHEDULE_EDIT_CUTOFF_MINUTES: testValue('BANK_SCHEDULE_EDIT_CUTOFF_MINUTES'),
    // LOCAL TEST values from the bank profile (BK-loan-06, J-bank-11 #1): the fee on clearing a loan early and how long a
    // payoff quote holds. Unset, every payoff quote refuses bank.loan_fee_unset, so the loan page could only show the refusal.
    BANK_LOAN_PAYOFF_FEE: testValue('BANK_LOAN_PAYOFF_FEE'),
    BANK_LOAN_PAYOFF_WINDOW_MINUTES: testValue('BANK_LOAN_PAYOFF_WINDOW_MINUTES'),
    // The lending policy is on and the origination fee is the profile's TEST zero. `LOCAL_STACK_BANK_LOANS=off`, or
    // `LOCAL_STACK_BANK_LOAN_ORIGINATION_FEE=off` or `=published` on a restart, shows each refusal (J-bank-09 #1 and #3).
    ...lendingPolicy(),
    ...originationFee(),
    // LOCAL TEST wording from the bank profile (BK-earn-04, J-bank-08 #6): what slashing means and who owns a staked saving.
    // `LOCAL_STACK_BANK_EARN_RISK_WORDING=off` on a restart leaves it blank, so the pool page's "not published" can be seen.
    ...earnRiskWording(),
    // Nothing moves money in the background of a test stack.
    // The standing-order runner has no timer: it is a signed job door, and on this stack only a test's own signed call
    // (J-bank-06) runs it. Left off, a one-off or a standing order could never be shown running here.
    SCHEDULED_TRANSFERS_ENABLED: 'true',
    // Auto-invest has no timer either: its runner is a signed job door no test calls. On, a card capture's round-up
    // (J-bank-07 #3) moves the spare change into the person's space; off, every round-up would only say it is switched off.
    AUTO_INVEST_ENABLED: 'true',
    // Earn interest has no timer either: on this stack only a test's own staff call (`ops.accrueInterest` for one TEST pool
    // and day, J-bank-07 #5) pays a day. Left off, savings here could never show a day of interest.
    INTEREST_ACCRUAL_ENABLED: 'true',
    // Loan interest moves no money (it writes the day's interest row) and has no timer either: on this stack only a
    // test's own signed call to its job door runs it (J-bank-11 #2, after `local-test-seed.mjs age-loan`). Left off, a
    // loan here could never owe interest, so a repayment could never be shown paying interest first.
    LOAN_ACCRUAL_ENABLED: 'true',
    LOAN_RISK_SWEEP_ENABLED: 'false',
  }),
});
