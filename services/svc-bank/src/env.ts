import { z } from 'zod';
import { edgeEnvSchema, loadEnv, serviceEnvSchema, internalServiceEnvSchema, s2sEnvSchema } from '@intafaced/config';
import { CARD_ISSUER_SETTINGS } from './cards/issuer.js';
import { parseRecoveryBatchLimit, parseRecoveryInterval } from './recovery-jobs.js';
import { RAMP_SETTINGS } from './ramps/rails.js';
import { GLOBAL_PARTNER_SETTINGS } from './personal-pay/global-sim.js';

// This service self-mounts /trpc, so it must be able to authenticate the edge.
// Every procedure here resolves `ctx.principal.userId` into somebody's spaces
// and transfers; an unsigned principal header would let a caller name any of
// them (docs/decisions/mount-boundary.md).
const schema = serviceEnvSchema
  .merge(edgeEnvSchema)
  .merge(internalServiceEnvSchema)
  .merge(s2sEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-bank'),
      HTTP_PORT: z.coerce.number().int().default(4009),

      /** svc-ledger's internal address. All value movement goes through it. */
      LEDGER_URL: z.string().url().default('http://localhost:4001'),

      /**
       * svc-identity base for affiliate accrue/payout after loan house fees.
       * Unset → noop port (loanRepay / loanLiquidate still post). No localhost default.
       */
      IDENTITY_URL: z.string().url().optional(),

      /**
       * svc-pay base for customer deposit addresses and the deposit catalogue (W-deposit-01). Blank → the deposit doors refuse
       * `bank.deposit_custody_unset`. No localhost default, no invented address.
       */
      PAY_URL: z.string().url().optional(),

      /**
       * The native asset. svc-bank refuses it in earn pools because native
       * staking lives in svc-token (§8.1) — one asset, one owner.
       *
       * This used to give a second reason: that both services would otherwise
       * write to the same `userStake(user, IFC)` ledger account. That has not
       * been true since `purpose` became part of account identity. svc-token
       * posts to `token:stake:<id>` and svc-bank to `bank:earn:<id>`, which are
       * different accounts by the unique index, so the guard is a product rule
       * now and not a reconciliation backstop. Worth knowing before anyone
       * relaxes it for the wrong reason — or keeps it for one.
       *
       * Configurable only so a testnet can run its own symbol.
       */
      TOKEN_ASSET_ID: z.string().default('IFC'),

      /**
       * Emergency stop for the standing-order runner.
       *
       * Separate from a general service toggle because the failure it guards
       * against is different in kind: a bad deploy that mis-computes occurrence
       * indices would fire every schedule in the book, and unlike a bad read there
       * is nothing to roll back — the ledger is append-only and each transfer is a
       * real movement between two real accounts.
       */
      SCHEDULED_TRANSFERS_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(true)
        .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(v.toLowerCase()))),

      /**
       * Emergency stop for interest accrual. Same reasoning, opposite direction:
       * interest leaves the pool reserve, and a reserve drained by a runaway job
       * cannot be un-paid without asking users to return money.
       */
      INTEREST_ACCRUAL_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(true)
        .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(v.toLowerCase()))),

      /**
       * How many due schedules one runner pass claims. Bounds the blast radius
       * of a bad pass. Owner-published. Blank / unset refuses boot (never invent
       * 200). Owner may set 200 explicitly. Empty string is not 0 — 0 is not a
       * legal batch (kill-switch is SCHEDULED_TRANSFERS_ENABLED).
       */
      TRANSFER_BATCH_SIZE: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.coerce.number().int().min(1).max(10_000),
      ),

      // ── Loans (§8.1) ───────────────────────────────────────────────────────

      /**
       * Where LTV marks come from. svc-trade's public REST, read over HTTP.
       *
       * A READ of another stream's public surface — no import, no shared table,
       * nothing written back. `loans/prices.ts` sets out what that surface can and
       * cannot currently support, and why a liquidation is refused on the weaker
       * of the two mark qualities it produces.
       */
      TRADE_URL: z.string().url().default('http://localhost:4004'),

      /**
       * The asset LTV is measured in, unless a product says otherwise.
       *
       * Both marks — collateral and debt — are taken against this, so it must be
       * an asset that actually has markets. Getting it wrong does not produce a
       * wrong number; it produces `bank.mark_missing` and no lending at all,
       * which is the right way for a misconfiguration this central to fail.
       *
       * Owner-published. Required min(1) — unset / blank refuses boot.
       * Never invent USDT (that default looked published).
       */
      LOAN_QUOTE_ASSET_ID: z.string().trim().min(1),

      /**
       * Emergency stop for LOAN interest accrual.
       *
       * Separate from `INTEREST_ACCRUAL_ENABLED`, which stops the earn pools, and
       * it stops the opposite direction of money: earn accrual PAYS users out of
       * a reserve, loan accrual CHARGES borrowers. A single flag would mean
       * halting a runaway payout also stops charging every borrower on the book,
       * and an operator in an incident should not have to accept that trade.
       */
      LOAN_ACCRUAL_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(true)
        .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(v.toLowerCase()))),

      /**
       * Module kill for collateralised loans (`FLAG_REGISTRY` bank.loans).
       *
       * OFF refuses new loan opens (and product-facing money paths that mint
       * debt). Accrual / risk-sweep keep their own flags — this is "stop the
       * product", not "stop one job". Defaults ON so existing deploys keep
       * working; flip to stop without inventing a console that never bit.
       */
      BANK_LOANS_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(true)
        .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(v.toLowerCase()))),

      /**
       * THE ONE THAT SELLS PEOPLE'S COLLATERAL.
       *
       * Defaults to OFF. Every other job in this service defaults on, because the
       * worst a bad pass does is move a user's own money between their own
       * accounts, or pay out yield that was funded. The risk sweep seizes and
       * sells collateral, and a first deploy that has not yet had its price
       * source, its thresholds and its liquidation venue checked by a human must
       * not do that on its own initiative.
       *
       * With the sweep off, loans still open, accrue and repay. Nothing is
       * liquidated and margin calls are not raised — so an operator turning this
       * on for the first time should expect a batch of calls, and that is the
       * correct thing to look at before it is the correct thing to automate.
       */
      LOAN_RISK_SWEEP_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /**
       * How many loans one sweep pass marks. Bounds the blast radius of a bad
       * pass. Owner-published. Blank / unset refuses boot (never invent 500).
       * Owner may set 500 explicitly. Sweep stays off unless
       * LOAN_RISK_SWEEP_ENABLED is on — this is not turning it on.
       */
      LOAN_SWEEP_BATCH_SIZE: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.coerce.number().int().min(1).max(10_000),
      ),

      // ── Cards (§8.1, ledger half) ──────────────────────────────────────────

      /**
       * WHICH CARD ISSUER THIS DEPLOYMENT HAS, AND `none` IS A REAL ANSWER.
       *
       * Defaults to `none`, and `none` is not a disabled feature — it is the
       * truthful statement that this deployment has no card programme. Every
       * procedure needing an issuer then refuses `bank.no_card_issuer` by name,
       * and `bank.cards.programme` says "No card programme" out loud rather than
       * leaving a caller to infer it from an error.
       *
       * `card-sim` is the only other value and IT IS A SIMULATOR. It creates no
       * card, makes no network call, and holds no credentials to make one with.
       * What it does is let the ledger half run end to end against real postings
       * in the real book, carrying `simulated: true` on the programme, on every
       * card row and on every router output. The live rail is
       * `socket.live-issuer` — a card-scheme sponsor and an issuing BIN, a
       * licence and a contract that no value of this variable produces.
       *
       * Why a setting rather than a default to the simulator: the same posture,
       * for the same reason, as `LOAN_RISK_SWEEP_ENABLED` and the loan price
       * source. The dangerous default is the plausible one. An environment
       * somebody believes is live must not quietly begin approving
       * authorisations against a counterparty that does not exist, so choosing
       * the simulator has to be an act somebody performed — and `/ready` reports
       * which act was performed, so it can be checked rather than assumed.
       */
      BANK_CARD_ISSUER: z.enum(CARD_ISSUER_SETTINGS).default('none'),

      /**
       * Module kill for the card ledger half (`FLAG_REGISTRY` bank.cards).
       *
       * OFF refuses issue and authorise. Issuer setting (`BANK_CARD_ISSUER`)
       * still names which programme exists when the module is on; this flag is
       * the emergency product stop, not a substitute for "no issuer".
       */
      BANK_CARDS_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(true)
        .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(v.toLowerCase()))),

      // ── Ramps (§8.1 / D-S-09, crypto ledger half) ───────────────────────────

      /**
       * WHICH BANK RAMP PROGRAMME THIS DEPLOYMENT HAS, AND `none` IS A REAL ANSWER.
       *
       * Defaults to `none`. `crypto-ledger` turns on the CRYPTO LEDGER half only:
       * deposit / withdraw recipes against `bank-crypto-ledger`, always with
       * `simulated: true`. It does not broadcast to a chain and it does not open
       * a fiat path — fiat remains `socket.psp-partners` and refuses by name.
       *
       * Same posture as `BANK_CARD_ISSUER`: the dangerous default is the
       * plausible one, so choosing the ledger half is an act somebody performed.
       */
      BANK_RAMP_MODE: z.enum(RAMP_SETTINGS).default('none'),

      /**
       * MONEY-OUT STEP-UP (ADR 2026-10-14-money-out-step-up, phase 1). `off` | `required`.
       *
       * `off` (default) leaves every door as it was. `required` makes sends to other users, standing
       * orders to other people, business payments and membership, and card unfreeze/issue demand
       * `stepUpApprovalId`: a same-person approval from svc-identity, bound to that exact payload.
       * Flip to `required` only once the customer app can show the step-up sheet, or every send
       * to another person fails. Any other value (including blank) refuses boot: a typo must never
       * read as "off".
       */
      BANK_STEP_UP_MONEY_OUT: z.enum(['off', 'required']).default('off'),

      /**
       * Owner-set offramp cooling window in hours (PTX-M17-R03).
       *
       * No default. Blank / unset / non-integer / negative → offramp refuses
       * `bank.offramp_cooling_unset` rather than inventing 24h. Boot stays up;
       * the money path is the refuse.
       */
      BANK_OFFRAMP_COOLING_HOURS: z.string().optional(),

      /**
       * Owner-set hours a new bank-rail recipient waits before money may go to it (BK-xfer-06, J-bank-04 #2).
       *
       * No default. Blank / unset / not a whole number → a send to a saved recipient refuses
       * `bank.payee_cooling_unset`. Zero is a real owner choice (no wait).
       */
      BANK_PAYEE_COOLING_HOURS: z.string().optional(),

      /**
       * Owner-set hours a global send may stay on a compliance hold before it is cancelled automatically, nothing posted
       * (BK-xfer-08, J-bank-04 #6).
       *
       * No default. Blank / unset / not a whole number of 1 or more → nothing is cancelled automatically, and every screen
       * says the rule is not published (`bank.global_hold_cancel_unset`).
       */
      BANK_GLOBAL_HOLD_CANCEL_HOURS: z.string().optional(),

      /**
       * Owner-set number of saved withdrawal addresses one customer may hold.
       *
       * No default. Blank / unset / zero / not a whole number → saving an address refuses
       * `bank.address_book_cap_unset`. Boot stays up; the save is the refuse.
       */
      BANK_ADDRESS_BOOK_CAP: z.string().optional(),

      /**
       * Owner-set minutes a wallet ownership proof offer stays open for signing (W-withdraw-17).
       *
       * No default. Blank / unset / zero / not a whole number → starting a proof refuses
       * `bank.wallet_proof_window_unset`. Boot stays up; the start is the refuse.
       */
      BANK_WALLET_PROOF_WINDOW_MINUTES: z.string().optional(),

      /**
       * Owner-set days a verified wallet ownership proof holds before the customer proves the wallet again (W-withdraw-17).
       *
       * No default. Blank / unset / zero / not a whole number → a proof refuses `bank.wallet_proof_validity_unset`.
       * Boot stays up; the proof is the refuse.
       */
      BANK_WALLET_PROOF_VALID_DAYS: z.string().optional(),

      /**
       * Owner-published currencies that have local account details, comma separated ISO-4217 codes ("GBP,EUR").
       *
       * No default. Blank / unset / a code that is not three letters → the list refuses
       * `bank.account_details_currencies_unset`. Boot stays up; the read is the refuse.
       */
      BANK_ACCOUNT_DETAILS_CURRENCIES: z.string().optional(),

      /**
       * Owner-published eligibility rule set as JSON: `{ countries: ["GB", ...], entityTypes: [...], productRestrictions:
       * [{ product, restriction }] }`. No default. Blank / unset / not in shape → `bank.eligibility_unset`.
       */
      BANK_ELIGIBILITY_JSON: z.string().optional(),

      /**
       * Owner-published base-tier account terms as JSON (BK-acct-01): `{ tier, version, currency, monthlyFee, minimumBalance,
       * overdraftFee, included: [...] }`, money as decimal strings. NO DEFAULT. Blank / unset / not in shape → the account
       * panel refuses `bank.account_terms_unset` and never claims a fee-free account. Boot stays up; the read is the refuse.
       */
      BANK_ACCOUNT_TERMS_JSON: z.string().optional(),

      /**
       * Owner-published currencies an account may hold, comma separated asset ids ("USDT,USDC,BTC"). NO DEFAULT. Blank /
       * unset → adding a currency refuses `bank.account_currencies_unset`; an asset not on the list refuses
       * `bank.asset_unknown`. Removing a currency needs no list.
       */
      BANK_ACCOUNT_CURRENCIES: z.string().optional(),

      /**
       * Owner-published number of live named spaces one account may hold (BK-pots-01). NO DEFAULT. Blank / unset / not a
       * positive whole number → creating a space refuses `bank.space_limit_unset`; at the limit it refuses
       * `bank.space_limit_reached` with the number. Boot stays up; the create is the refuse.
       */
      BANK_SPACE_LIMIT: z.string().optional(),

      /**
       * Owner-published rules for the purpose, source of funds and reference of a global send, as JSON: `{ reference:
       * [{ deliveryMethod, country?, maxLength }], purposeRequired: ["INR", ...], sourceOfFunds: [{ asset, threshold }] }`.
       * No default. Blank / unset / not in shape → `bank.send_field_rules_unset`; a reference with no rule for its rail →
       * `bank.reference_rules_unset`. Boot stays up; the send is the refuse.
       */
      BANK_SEND_FIELD_RULES_JSON: z.string().optional(),

      /**
       * WHO ANSWERS A GLOBAL SEND. `none` (default) | `global-sim`.
       *
       * `none` leaves every global-send port unset: each send refuses by name and nothing posts. `global-sim` is a TEST
       * stand-in for the local stack and journey tests only (`personal-pay/global-sim.ts`): it answers from the typed TEST
       * catalogue in `BANK_GLOBAL_SIM_JSON`, pays nobody, and is refused under live posture. Same posture as
       * `BANK_CARD_ISSUER`: choosing the stand-in has to be an act somebody performed.
       */
      BANK_GLOBAL_PARTNER: z.enum(GLOBAL_PARTNER_SETTINGS).default('none'),
      /** The stand-in's TEST catalogue (corridors, rates, banks, travel-rule fields, and optionally the amounts it screens). Read only when the setting is `global-sim`. */
      BANK_GLOBAL_SIM_JSON: z.string().optional(),

      /**
       * Owner-published payee controls for a global send as JSON: `{ blockedAccounts: ["..."] }`. A published empty list
       * blocks nothing. No default. Blank / unset / not in shape → every send refuses `bank.payee_controls_unset`; a listed
       * account refuses `bank.payee_blocked` without naming the list.
       */
      BANK_PAYEE_CONTROLS_JSON: z.string().optional(),

      /**
       * Owner-published limits for a proof-of-payment upload as JSON: `{ allowedTypes: ["application/pdf"], maxBytes: n }`.
       * No default. Blank / unset / not in shape → an upload refuses `bank.proof_limits_unset`.
       */
      BANK_PROOF_LIMITS_JSON: z.string().optional(),

      /**
       * Owner-published allowance for sends to crypto exchanges as JSON: `{ exchangeAccounts: ["..."], windowDays: 30,
       * limits: [{ asset: "USDT", maxAmount: "5000" }] }`. No default. Blank / unset / not in shape, or an exchange account with
       * no limit for the asset → the send refuses `bank.exchange_allowance_unset`; over the limit in the rolling window →
       * `bank.exchange_allowance_exceeded`. A published empty account list means no recipient is an exchange.
       */
      BANK_EXCHANGE_ALLOWANCE_JSON: z.string().optional(),

      /**
       * Emergency stop for the auto-invest runner (threshold sweeps / DCA).
       * Same posture as SCHEDULED_TRANSFERS_ENABLED: a bad pass must not keep
       * moving value after an operator hit stop.
       */
      AUTO_INVEST_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(true)
        .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(v.toLowerCase()))),

      /**
       * Owner-published page size for auto-invest convert
       * `GET /api/v1/markets?limit=` (trade window 1..500).
       * Blank / unset stays unpublished — listedSpot refuses
       * `bank.convert_markets_limit_unset` rather than inventing 50.
       * Boot stays up; the convert path is the refuse.
       */
      CONVERT_MARKETS_LIMIT: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.coerce.number().int().min(1).max(500).optional(),
      ),

      /**
       * How often the in-process recovery pass re-drives pending loan opens,
       * unknown loan repayments/releases, and pending earn deposits.
       *
       * Unset uses 60000, the same default as TRADE_HOLD_UNKNOWN_SWEEP_INTERVAL_MS
       * (the other lost-acknowledgement sweep). Blank disables the timer and
       * svc-bank logs a startup warning. A non-integer refuses boot. There is
       * no silent "do nothing" and no invented 8h.
       */
      BANK_RECOVERY_JOBS_INTERVAL_MS: z
        .unknown()
        .optional()
        .transform((v, ctx) => {
          try {
            return parseRecoveryInterval(v);
          } catch (err) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: err instanceof Error ? err.message : 'invalid recovery interval',
            });
            return z.NEVER;
          }
        }),

      /**
       * Rows one recovery pass may scan. Unset uses 50, the same default as
       * svc-trade `sweepHoldUnknown`. Blank disables the timer and svc-bank
       * logs a startup warning — blank is not 0 and not the old invented 100.
       * The HTTP jobs still require their own body.limit; this is the timer's
       * cap, passed into the same assert functions.
       */
      BANK_RECOVERY_JOBS_BATCH_LIMIT: z
        .unknown()
        .optional()
        .transform((v, ctx) => {
          try {
            return parseRecoveryBatchLimit(v);
          } catch (err) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: err instanceof Error ? err.message : 'invalid recovery batch',
            });
            return z.NEVER;
          }
        }),
    }),
  );

export const env = loadEnv(schema);
export type Env = typeof env;
