import { z } from 'zod';
import { isRecord } from '@intafaced/contracts/guards';
import { defineProcedure } from '@intafaced/contracts/procedure';
import { MoneyError, parseAmount, sum } from './money.js';
import { recipes, type RecipeName } from './recipes/index.js';
import { BANK_TRANSFER_KEY_SPACES } from './recipes/bank.js';
import { LedgerError, type PostRequest } from './types.js';

/**
 * svc-ledger's `postRecipe` door: a service names a recipe and gives that recipe's business inputs, and the ledger builds
 * the post itself with the recipe from this package, then books it through exactly the pipeline `/trpc/post` runs (caller
 * binding, recipe gate, idempotency, freeze, custody switch). A caller in another language (a Rust port) never assembles
 * ledger entries: the legs live only here (floor rule 1).
 *
 * Kept with the ledger's own types (here, not in contracts, so contracts never depends on the money package), as
 * `history-page-record.ts` is. svc-ledger serves it (`s2s-http.ts`); callers reach it through `createHttpRecipePoster`.
 *
 * On the wire every amount is a decimal string and every bigint counter a decimal string of digits; the door turns them
 * into the recipe's `bigint`s. The idempotency key is the recipe's own business key, built from the inputs, so the same
 * inputs are the same key and the same body: a retry books nothing twice, and the same key with a different body is
 * refused (`ledger.idempotency_conflict`) as on `/trpc/post`.
 *
 * Adding a recipe to the door is one entry in `RECIPE_DOORS` (its inputs' wire shape and the conversion to its bigints),
 * its line in `postRecipeInput`, and its grant in the ledger gate's `gate/caller-allowlist.ts`. On the door now: svc-academy's two
 * recipes, svc-agents' usage charge (`feeCharge` in its asset mode, `chargeEarn`, `chargeCollect`), and svc-bank's
 * transfer (`bankTransfer`, every key space), its holds on received funds (`payReceivedHold`, `payReceivedRelease`,
 * `payReceivedReturn`), its earn pools (`earnDeposit`, `earnWithdraw`, `earnPoolFund`, `earnInterest`), its loans
 * (`loanCollateralLock`, `loanCollateralRelease`, `loanDraw`, `loanRepay`, `loanReserveFund`, `loanLiquidate`,
 * `loanBadDebt`), its business approvals and payroll (`businessApprovalHold`, `businessApprovalRelease`,
 * `businessApprovalSettle`, `businessPayroll`), its ramps and card holds (`deposit`, `withdrawHold`, `withdrawSettle`,
 * `withdrawReverse`) and its card cashback (`rewardPay`, `sweepFeesToRewards`).
 */

/** A positive or zero decimal string, at most 18 places: the recipe refuses zero where it must. */
const AMOUNT = z
  .string()
  .max(64)
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/);
/** A whole number from one, as a decimal string (a bigint counter: the buyer's n-th purchase). */
const COUNTER = z.string().regex(/^[1-9][0-9]{0,18}$/);
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const COURSE = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const ASSET = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[^\s]+$/);
const CHAIN_TX = z.string().regex(/^0x[0-9a-f]{64}$/);
const PLACE_ID = z
  .string()
  .max(128)
  .regex(/^[a-z0-9][a-z0-9:_-]*$/);
const PLACE = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('treasury-wallet'), walletId: PLACE_ID }).strict(),
  z.object({ kind: z.literal('venue-builder-account'), venueId: PLACE_ID }).strict(),
  z.object({ kind: z.literal('partner-reserve'), partnerId: PLACE_ID }).strict(),
]);

/** A selling module, as its fee pot names it (`fees:<module>`; `charge.ts` `MODULE_ID`). */
const MODULE = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
/** A sale, usage window or payment id (`charge.ts` `REF`): no spaces, no `:`. */
const REF = z
  .string()
  .max(128)
  .regex(/^[^\s:]+$/);
/** A fee charge's own id: no spaces (a usage window's `agent.usage:<session>:<window>`). */
const CHARGE_ID = z
  .string()
  .max(128)
  .regex(/^[^\s]+$/);
/** The reason a fee charge is booked under: a dotted lower-case code (`agents.usage.metered`). */
const REASON = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

/**
 * A bank transfer's own id, without spaces: a transfer id, a standing order's id, or a recovery sweep's
 * `<claim>:<account>` (`recoverySweepTransferId`). At most 160, so `bank.transfer.<space>:<id>:<occurrence>` stays
 * within the ledger's 200-character key.
 */
const TRANSFER_ID = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[^\s]+$/);
/** Which firing of a transfer this is: a whole number from zero (`requireOccurrence`), at most ten digits in the key. */
const OCCURRENCE = z.number().int().min(0).max(2_147_483_647);
/** A hold on received funds' own id (svc-bank's hold row), without spaces; its pot `pay:recv:<holdId>` fits the ledger's 128. */
const HOLD_ID = z
  .string()
  .min(1)
  .max(119)
  .regex(/^[^\s]+$/);
/** An asset as the ledger's account names it (at most 16), without spaces. */
const ACCOUNT_ASSET = z
  .string()
  .min(1)
  .max(16)
  .regex(/^[^\s]+$/);
/** A rail's boundary account (`railBoundary`): `rail:<railId>`, a platform id that is never a UUID. */
const RAIL_OWNER = z
  .string()
  .max(128)
  .regex(/^rail:[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)*$/);
/**
 * An account a bank transfer moves between: a person's or a named space's available balance (`accountForSpace`, an
 * heir's `userAvailable`), or a rail's boundary (`railBoundary`). Never a lock: those have their own recipes.
 */
const BANK_ACCOUNT = z.discriminatedUnion('ownerType', [
  z.object({ ownerType: z.enum(['user', 'subaccount']), ownerId: UUID, assetId: ACCOUNT_ASSET, kind: z.literal('available') }).strict(),
  z.object({ ownerType: z.literal('treasury'), ownerId: RAIL_OWNER, assetId: ACCOUNT_ASSET, kind: z.literal('available') }).strict(),
]);

/**
 * A pool funding's own id (`earnPoolFund`'s `fundingId`: a treasury transfer reference, a window id), as svc-bank's
 * operator door takes it. At most 128, so `bank.earn.fund:<poolId>:<fundingId>` stays within the ledger's 200.
 */
const FUNDING_ID = z.string().min(1).max(128);
/** An accrual's day as it is written (`YYYY-MM-DD`); the recipe refuses a day the calendar does not have (2026-02-31). */
const ACCRUAL_DATE = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);

/** One recipe on the door: its inputs' wire shape, and how they become the registry recipe's own inputs. */
interface RecipeDoor {
  readonly wire: z.ZodObject;
  /** Parses the wire inputs by `wire` and builds the post with the registry recipe (`recipes.<name>`), never a copy. */
  readonly run: (input: unknown) => PostRequest;
}

function door<S extends z.ZodObject>(wire: S, build: (input: z.output<S>) => PostRequest): RecipeDoor {
  return { wire, run: (input) => build(wire.parse(input)) };
}

/** The fields both academy recipes take; only the place's side differs. */
const academyFields = { course: COURSE, userId: UUID, n: COUNTER, assetId: ASSET, amount: AMOUNT, paymentId: CHAIN_TX };
const academyPurchaseWire = z.object({ ...academyFields, to: PLACE }).strict();
const academyRefundWire = z.object({ ...academyFields, from: PLACE }).strict();
/** `feeCharge` in its asset mode only: the custodial charge (refused while the custody layer is off). */
const feeChargeWire = z
  .object({
    chargeId: CHARGE_ID,
    userId: UUID,
    module: MODULE,
    mode: z.literal('asset'),
    assetId: ASSET,
    amount: AMOUNT,
    reason: REASON.optional(),
  })
  .strict();
/** `chargeEarn`: the price is required here; an unset price never reaches the door (the caller refuses first). */
const chargeEarnWire = z
  .object({
    module: MODULE,
    saleId: REF,
    userId: UUID,
    memberUserId: UUID.optional(),
    assetId: ASSET,
    price: z.object({ perUnit: AMOUNT }).strict(),
    units: COUNTER,
  })
  .strict();
const chargeCollectWire = z.object({ module: MODULE, userId: UUID, to: PLACE, paymentId: REF, assetId: ASSET, amount: AMOUNT }).strict();
/**
 * `bankTransfer`: the two accounts as svc-bank resolves them (`accountForSpace`, a rail boundary, an heir), every key
 * space named (the legacy shared `bank.transfer:` key is not on the door), and the kind that goes with it.
 */
const bankTransferWire = z
  .object({
    transferId: TRANSFER_ID,
    occurrence: OCCURRENCE,
    from: BANK_ACCOUNT,
    to: BANK_ACCOUNT,
    amount: AMOUNT,
    kind: z.enum(['manual', 'scheduled']),
    keySpace: z.enum(BANK_TRANSFER_KEY_SPACES),
  })
  .strict();
const receivedHoldFields = { holdId: HOLD_ID, userId: UUID, assetId: ACCOUNT_ASSET, amount: AMOUNT };
const payReceivedHoldWire = z.object(receivedHoldFields).strict();
/** A release or a return moves the whole hold: the amount the hold was placed for is sent beside it (RH-2). */
const payReceivedReleaseWire = z.object({ ...receivedHoldFields, heldAmount: AMOUNT }).strict();
const payReceivedReturnWire = z.object({ ...receivedHoldFields, heldAmount: AMOUNT, payerUserId: UUID }).strict();
/**
 * `earnDeposit` and `earnWithdraw`: one position (`bank.earn_positions.id`) in one pool (`bank.earn_pools.id`), its
 * owner and the principal. The stake pot `bank:earn:<positionId>` is the recipe's.
 */
const earnPositionWire = z.object({ positionId: UUID, poolId: UUID, userId: UUID, assetId: ACCOUNT_ASSET, amount: AMOUNT }).strict();
/** `earnPoolFund` from the bank's own fee revenue: svc-bank never names another source, so `from` is not on the wire. */
const earnPoolFundWire = z.object({ poolId: UUID, fundingId: FUNDING_ID, assetId: ACCOUNT_ASSET, amount: AMOUNT }).strict();
/** `earnInterest`: one pool's day, one payout a person; the recipe refuses an empty list and a zero payout. */
const earnInterestWire = z
  .object({
    poolId: UUID,
    date: ACCRUAL_DATE,
    assetId: ACCOUNT_ASSET,
    payouts: z.array(z.object({ userId: UUID, amount: AMOUNT }).strict()),
  })
  .strict();

/** Which lock, release, repayment or liquidation rung of one loan this is: a whole number from zero (`requireSequence`). */
const SEQUENCE = z.number().int().min(0).max(2_147_483_647);
/**
 * `loanCollateralLock` and `loanCollateralRelease`: one loan (`bank.loans.id`), its borrower, the pledged asset and the
 * n-th lock or release. The pot is the borrower's own `collateral`, purpose `loan:<loanId>`.
 */
const loanCollateralWire = z
  .object({ loanId: UUID, userId: UUID, collateralAssetId: ACCOUNT_ASSET, amount: AMOUNT, sequence: SEQUENCE })
  .strict();
/** `loanDraw`: the one draw of a loan's principal from the lending reserve. */
const loanDrawWire = z.object({ loanId: UUID, userId: UUID, debtAssetId: ACCOUNT_ASSET, principal: AMOUNT }).strict();
/** `loanRepay`: principal back to the reserve, interest to the bank's revenue; either may be zero, not both. */
const loanRepayWire = z
  .object({ loanId: UUID, userId: UUID, debtAssetId: ACCOUNT_ASSET, principal: AMOUNT, interest: AMOUNT, sequence: SEQUENCE })
  .strict();
/** `loanReserveFund` from the bank's own fee revenue: svc-bank never names another source, so `from` is not on the wire. */
const loanReserveFundWire = z.object({ fundingId: FUNDING_ID, debtAssetId: ACCOUNT_ASSET, amount: AMOUNT }).strict();
/**
 * A liquidation's buyer, as svc-bank's venue names it today: the house market maker's available balance
 * (`marketMaker(assetId)`). A taker's accounts are not on the door until svc-bank sends one.
 */
const MARKET_MAKER = z
  .object({ ownerType: z.literal('house'), ownerId: z.literal('market-maker'), assetId: ACCOUNT_ASSET, kind: z.literal('available') })
  .strict();
/** `loanLiquidate`: one rung of the ladder, seized, sold and repaid in one post. */
const loanLiquidateWire = z
  .object({
    loanId: UUID,
    userId: UUID,
    tranche: SEQUENCE,
    collateralAssetId: ACCOUNT_ASSET,
    collateralSold: AMOUNT,
    debtAssetId: ACCOUNT_ASSET,
    proceeds: AMOUNT,
    principalRepaid: AMOUNT,
    interestRepaid: AMOUNT,
    penalty: AMOUNT,
    surplusToBorrower: AMOUNT,
    buyer: z.object({ collateralTo: MARKET_MAKER, proceedsFrom: MARKET_MAKER }).strict(),
    markPrice: AMOUNT,
  })
  .strict();
/** `loanBadDebt`: the shortfall the insurance fund covers, once per loan. */
const loanBadDebtWire = z.object({ loanId: UUID, debtAssetId: ACCOUNT_ASSET, shortfall: AMOUNT }).strict();

/** A business space's available balance as svc-bank resolves it (`ledgerAccount`): the owner's own, or a named space's. */
const SPACE_ACCOUNT = z
  .object({ ownerType: z.enum(['user', 'subaccount']), ownerId: UUID, assetId: ACCOUNT_ASSET, kind: z.literal('available') })
  .strict();
/** `businessApprovalHold` and `businessApprovalRelease`: one approval (`bank.business_approvals.id`) on its debit space. */
const businessApprovalHoldWire = z.object({ approvalId: UUID, from: SPACE_ACCOUNT, amount: AMOUNT }).strict();
/** `businessApprovalSettle`: the approval's hold to the destination space. */
const businessApprovalSettleWire = z.object({ approvalId: UUID, from: SPACE_ACCOUNT, to: SPACE_ACCOUNT, amount: AMOUNT }).strict();
/** A payroll run's id as the client sends it (`z.string().guid()` on svc-bank's call): either case. */
const PAYROLL_ID = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
/** `businessPayroll`: every recipient paid in one post, or none. */
const businessPayrollWire = z
  .object({
    payrollId: PAYROLL_ID,
    from: SPACE_ACCOUNT,
    recipients: z.array(z.object({ to: SPACE_ACCOUNT, amount: AMOUNT }).strict()),
  })
  .strict();

/** A rail's own id (`railBoundary`), as `rail:<rail>` fits the ledger's 128: `bank-crypto-ledger`, a card issuer. */
const RAIL = z
  .string()
  .max(123)
  .regex(/^[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)*$/);
/** A rail's own reference for a deposit, as svc-bank's operator door takes it (1 to 256). */
const RAIL_REF = z.string().min(1).max(256);
/** `deposit` as svc-bank books it: no sub-account and no unconfirmed deposit on the wire. */
const depositWire = z.object({ userId: UUID, assetId: ACCOUNT_ASSET, amount: AMOUNT, rail: RAIL, railRef: RAIL_REF }).strict();
/** A withdrawal's own id without spaces (a ramp row, a card authorisation, `cash-out:<id>`); `withdraw:<id>` fits the ledger's 128. */
const WITHDRAWAL_ID = z
  .string()
  .min(1)
  .max(119)
  .regex(/^[^\s]+$/);
/** `withdrawHold`, `withdrawSettle` and `withdrawReverse` as svc-bank books them: no fee on the wire (its holds carry none). */
const withdrawWire = z.object({ userId: UUID, assetId: ACCOUNT_ASSET, amount: AMOUNT, rail: RAIL, withdrawalId: WITHDRAWAL_ID }).strict();
/** A reward's own id without spaces (`bank.card.cashback:<authorizationId>`); `reward:<id>` fits the ledger's 200. */
const REWARD_ID = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[^\s]+$/);
/** `rewardPay`: the rewards engine to one person; the reason is the caller's (`bank.card.cashback`). */
const rewardPayWire = z.object({ rewardId: REWARD_ID, userId: UUID, assetId: ACCOUNT_ASSET, amount: AMOUNT, reason: REASON }).strict();
/** A revenue window's own id without spaces (`bank.card:<windowId>`). */
const WINDOW_ID = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\s]+$/);
/** `sweepFeesToRewards` from the bank's own fee revenue: svc-bank sweeps only `fees:bank`. */
const sweepFeesWire = z.object({ windowId: WINDOW_ID, sourceModule: z.literal('bank'), assetId: ACCOUNT_ASSET, amount: AMOUNT }).strict();

/**
 * The recipes the door posts, one entry each, plus its line in `postRecipeInput` below. TypeScript checks each `build`
 * against the recipe's own input type, so a wire shape that drifts from its recipe does not compile.
 */
const RECIPE_DOORS = {
  academyPurchase: door(academyPurchaseWire, (i) => recipes.academyPurchase({ ...i, n: BigInt(i.n), amount: parseAmount(i.amount) })),
  academyPurchaseRefund: door(academyRefundWire, (i) =>
    recipes.academyPurchaseRefund({ ...i, n: BigInt(i.n), amount: parseAmount(i.amount) }),
  ),
  feeCharge: door(feeChargeWire, (i) => recipes.feeCharge({ ...i, amount: parseAmount(i.amount) })),
  chargeEarn: door(chargeEarnWire, (i) => {
    const perUnit = parseAmount(i.price.perUnit);
    const units = BigInt(i.units);
    // The charge the price and the units give must fit the book, as every amount the door takes does.
    parseAmount(perUnit * units);
    return recipes.chargeEarn({ ...i, price: { perUnit }, units });
  }),
  chargeCollect: door(chargeCollectWire, (i) => recipes.chargeCollect({ ...i, amount: parseAmount(i.amount) })),
  bankTransfer: door(bankTransferWire, (i) => recipes.bankTransfer({ ...i, amount: parseAmount(i.amount) })),
  payReceivedHold: door(payReceivedHoldWire, (i) => recipes.payReceivedHold({ ...i, amount: parseAmount(i.amount) })),
  payReceivedRelease: door(payReceivedReleaseWire, (i) =>
    recipes.payReceivedRelease({ ...i, amount: parseAmount(i.amount), heldAmount: parseAmount(i.heldAmount) }),
  ),
  payReceivedReturn: door(payReceivedReturnWire, (i) =>
    recipes.payReceivedReturn({ ...i, amount: parseAmount(i.amount), heldAmount: parseAmount(i.heldAmount) }),
  ),
  earnDeposit: door(earnPositionWire, (i) => recipes.earnDeposit({ ...i, amount: parseAmount(i.amount) })),
  earnWithdraw: door(earnPositionWire, (i) => recipes.earnWithdraw({ ...i, amount: parseAmount(i.amount) })),
  earnPoolFund: door(earnPoolFundWire, (i) => recipes.earnPoolFund({ ...i, amount: parseAmount(i.amount) })),
  earnInterest: door(earnInterestWire, (i) => {
    const payouts = i.payouts.map((p) => ({ userId: p.userId, amount: parseAmount(p.amount) }));
    // The day's total must fit the book, as every amount the door takes does.
    parseAmount(sum(payouts.map((p) => p.amount)));
    return recipes.earnInterest({ ...i, payouts });
  }),
  loanCollateralLock: door(loanCollateralWire, (i) => recipes.loanCollateralLock({ ...i, amount: parseAmount(i.amount) })),
  loanCollateralRelease: door(loanCollateralWire, (i) => recipes.loanCollateralRelease({ ...i, amount: parseAmount(i.amount) })),
  loanDraw: door(loanDrawWire, (i) => recipes.loanDraw({ ...i, principal: parseAmount(i.principal) })),
  loanRepay: door(loanRepayWire, (i) => {
    const principal = parseAmount(i.principal);
    const interest = parseAmount(i.interest);
    // The repayment's total must fit the book, as every amount the door takes does.
    parseAmount(principal + interest);
    return recipes.loanRepay({ ...i, principal, interest });
  }),
  loanReserveFund: door(loanReserveFundWire, (i) => recipes.loanReserveFund({ ...i, amount: parseAmount(i.amount) })),
  loanLiquidate: door(loanLiquidateWire, (i) => {
    const interestRepaid = parseAmount(i.interestRepaid);
    const penalty = parseAmount(i.penalty);
    // The house's share (interest and penalty together) must fit the book.
    parseAmount(interestRepaid + penalty);
    return recipes.loanLiquidate({
      ...i,
      collateralSold: parseAmount(i.collateralSold),
      proceeds: parseAmount(i.proceeds),
      principalRepaid: parseAmount(i.principalRepaid),
      interestRepaid,
      penalty,
      surplusToBorrower: parseAmount(i.surplusToBorrower),
      markPrice: parseAmount(i.markPrice),
    });
  }),
  loanBadDebt: door(loanBadDebtWire, (i) => recipes.loanBadDebt({ ...i, shortfall: parseAmount(i.shortfall) })),
  businessApprovalHold: door(businessApprovalHoldWire, (i) => recipes.businessApprovalHold({ ...i, amount: parseAmount(i.amount) })),
  businessApprovalRelease: door(businessApprovalHoldWire, (i) => recipes.businessApprovalRelease({ ...i, amount: parseAmount(i.amount) })),
  businessApprovalSettle: door(businessApprovalSettleWire, (i) => recipes.businessApprovalSettle({ ...i, amount: parseAmount(i.amount) })),
  businessPayroll: door(businessPayrollWire, (i) => {
    const recipients = i.recipients.map((r) => ({ to: r.to, amount: parseAmount(r.amount) }));
    // The run's total must fit the book, as every amount the door takes does.
    parseAmount(sum(recipients.map((r) => r.amount)));
    return recipes.businessPayroll({ ...i, recipients });
  }),
  deposit: door(depositWire, (i) => recipes.deposit({ ...i, amount: parseAmount(i.amount) })),
  withdrawHold: door(withdrawWire, (i) => recipes.withdrawHold({ ...i, amount: parseAmount(i.amount) })),
  withdrawSettle: door(withdrawWire, (i) => recipes.withdrawSettle({ ...i, amount: parseAmount(i.amount) })),
  withdrawReverse: door(withdrawWire, (i) => recipes.withdrawReverse({ ...i, amount: parseAmount(i.amount) })),
  rewardPay: door(rewardPayWire, (i) => recipes.rewardPay({ ...i, amount: parseAmount(i.amount) })),
  sweepFeesToRewards: door(sweepFeesWire, (i) => recipes.sweepFeesToRewards({ ...i, amount: parseAmount(i.amount) })),
} as const satisfies Partial<Record<RecipeName, RecipeDoor>>;

export type PostRecipeName = keyof typeof RECIPE_DOORS;

export function isPostRecipeName(name: unknown): name is PostRecipeName {
  return typeof name === 'string' && Object.hasOwn(RECIPE_DOORS, name);
}

export const POST_RECIPE_NAMES: readonly PostRecipeName[] = Object.keys(RECIPE_DOORS).filter(isPostRecipeName);

/** The door's refusal when the body names no recipe it posts. Nothing is read or booked. */
export const POST_RECIPE_UNKNOWN = 'ledger.recipe_unknown';
/** The door's refusal when the inputs are not that recipe's, or the recipe refuses them. Nothing is read or booked. */
export const POST_RECIPE_INPUT_INVALID = 'ledger.recipe_input_invalid';

const variant = <N extends PostRecipeName>(name: N) => z.object({ recipe: z.literal(name), input: RECIPE_DOORS[name].wire }).strict();
const postRecipeInput = z.discriminatedUnion('recipe', [
  variant('academyPurchase'),
  variant('academyPurchaseRefund'),
  variant('feeCharge'),
  variant('chargeEarn'),
  variant('chargeCollect'),
  variant('bankTransfer'),
  variant('payReceivedHold'),
  variant('payReceivedRelease'),
  variant('payReceivedReturn'),
  variant('earnDeposit'),
  variant('earnWithdraw'),
  variant('earnPoolFund'),
  variant('earnInterest'),
  variant('loanCollateralLock'),
  variant('loanCollateralRelease'),
  variant('loanDraw'),
  variant('loanRepay'),
  variant('loanReserveFund'),
  variant('loanLiquidate'),
  variant('loanBadDebt'),
  variant('businessApprovalHold'),
  variant('businessApprovalRelease'),
  variant('businessApprovalSettle'),
  variant('businessPayroll'),
  variant('deposit'),
  variant('withdrawHold'),
  variant('withdrawSettle'),
  variant('withdrawReverse'),
  variant('rewardPay'),
  variant('sweepFeesToRewards'),
]);

const postedEntry = z.object({
  id: z.string(),
  txId: z.string(),
  accountId: z.string(),
  assetId: z.string(),
  direction: z.enum(['debit', 'credit']),
  /** Decimal string. */
  amount: z.string(),
  /** Decimal string; may be below zero on an account allowed to run negative (a treasury place). */
  balanceAfter: z.string(),
});

const SAMPLE_USER = '11111111-1111-4111-8111-111111111111';
const SAMPLE_TX = `0x${'ab'.repeat(32)}`;
const samplePurchase = {
  course: 'perps-101',
  userId: SAMPLE_USER,
  n: '1',
  assetId: 'USDC',
  amount: '2.5',
  to: { kind: 'treasury-wallet', walletId: '0x00000000000000000000000000000000000000aa' },
  paymentId: SAMPLE_TX,
};
const SAMPLE_BUSINESS = '22222222-2222-4222-8222-222222222222';
const sampleFee = {
  chargeId: `agent.usage:${SAMPLE_BUSINESS}:w1`,
  userId: SAMPLE_USER,
  module: 'agents',
  mode: 'asset',
  assetId: 'USDC',
  amount: '0.25',
  reason: 'agents.usage.metered',
};
const sampleEarn = {
  module: 'agents',
  saleId: `${SAMPLE_BUSINESS}.w1`,
  userId: SAMPLE_BUSINESS,
  memberUserId: SAMPLE_USER,
  assetId: 'USDC',
  price: { perUnit: '0.25' },
  units: '1',
};
const sampleCollect = {
  module: 'agents',
  userId: SAMPLE_USER,
  to: { kind: 'partner-reserve', partnerId: 'reserve-a' },
  paymentId: 'pay_123',
  assetId: 'USDC',
  amount: '0.25',
};

const SAMPLE_PAYEE = '33333333-3333-4333-8333-333333333333';
const sampleTransfer = {
  transferId: SAMPLE_BUSINESS,
  occurrence: 0,
  from: { ownerType: 'user', ownerId: SAMPLE_USER, assetId: 'USDC', kind: 'available' },
  to: { ownerType: 'user', ownerId: SAMPLE_PAYEE, assetId: 'USDC', kind: 'available' },
  amount: '12.5',
  kind: 'manual',
  keySpace: 'p2p',
};
const sampleHold = { holdId: SAMPLE_BUSINESS, userId: SAMPLE_PAYEE, assetId: 'USDC', amount: '12.5' };
const SAMPLE_POOL = '44444444-4444-4444-8444-444444444444';
const samplePosition = { positionId: SAMPLE_BUSINESS, poolId: SAMPLE_POOL, userId: SAMPLE_USER, assetId: 'USDT', amount: '100' };
const sampleFund = { poolId: SAMPLE_POOL, fundingId: 'treasury-2026-11', assetId: 'USDT', amount: '50' };
const sampleInterest = {
  poolId: SAMPLE_POOL,
  date: '2026-11-22',
  assetId: 'USDT',
  payouts: [
    { userId: SAMPLE_USER, amount: '0.013698630136986301' },
    { userId: SAMPLE_PAYEE, amount: '0.5' },
  ],
};
const SAMPLE_LOAN = '55555555-5555-4555-8555-555555555555';
const sampleCollateral = { loanId: SAMPLE_LOAN, userId: SAMPLE_USER, collateralAssetId: 'BTC', amount: '0.5', sequence: 0 };
const sampleDraw = { loanId: SAMPLE_LOAN, userId: SAMPLE_USER, debtAssetId: 'USDT', principal: '1000' };
const sampleRepay = { ...sampleDraw, principal: '100', interest: '1.25', sequence: 1 };
const marketMaker = (assetId: string) => ({ ownerType: 'house', ownerId: 'market-maker', assetId, kind: 'available' });
const sampleLiquidate = {
  loanId: SAMPLE_LOAN,
  userId: SAMPLE_USER,
  tranche: 0,
  collateralAssetId: 'BTC',
  collateralSold: '0.1',
  debtAssetId: 'USDT',
  proceeds: '6000',
  principalRepaid: '5000',
  interestRepaid: '10',
  penalty: '300',
  surplusToBorrower: '690',
  buyer: { collateralTo: marketMaker('BTC'), proceedsFrom: marketMaker('USDT') },
  markPrice: '60000',
};
const SAMPLE_SPACE = '66666666-6666-4666-8666-666666666666';
const sampleSpace = { ownerType: 'subaccount', ownerId: SAMPLE_SPACE, assetId: 'USDC', kind: 'available' };
const samplePrimary = { ownerType: 'user', ownerId: SAMPLE_USER, assetId: 'USDC', kind: 'available' };
const sampleApproval = { approvalId: SAMPLE_BUSINESS, from: samplePrimary, amount: '250' };
const samplePayroll = {
  payrollId: SAMPLE_BUSINESS.toUpperCase(),
  from: samplePrimary,
  recipients: [
    { to: sampleSpace, amount: '100' },
    { to: { ...samplePrimary, ownerId: SAMPLE_PAYEE }, amount: '50' },
  ],
};
const sampleDeposit = { userId: SAMPLE_USER, assetId: 'USDC', amount: '25', rail: 'bank-crypto-ledger', railRef: 'tx 0xabc' };
const sampleWithdraw = {
  userId: SAMPLE_USER,
  assetId: 'USDC',
  amount: '25',
  rail: 'card-sim',
  withdrawalId: `cash-out:${SAMPLE_BUSINESS}`,
};
const sampleReward = {
  rewardId: `bank.card.cashback:${SAMPLE_BUSINESS}`,
  userId: SAMPLE_USER,
  assetId: 'USDC',
  amount: '0.25',
  reason: 'bank.card.cashback',
};
const sampleSweep = { windowId: 'bank.card:2026-11', sourceModule: 'bank', assetId: 'USDC', amount: '10' };

export const LEDGER_POST_RECIPE = defineProcedure({
  name: 'ledger.postRecipe',
  service: 'svc-ledger',
  transport: 'http',
  method: 'POST',
  path: '/trpc/postRecipe',
  /** The services granted a recipe on this door (`gate/caller-allowlist.ts`); each holds a grant for one of its recipes (`post-recipe-client.test.ts`). */
  access: { caller: 'service', callers: ['svc-academy', 'svc-agents', 'svc-bank'] },
  /** Plain-HTTP refusals: status and `{ message, code }` from svc-ledger's `httpError`. */
  refusals: {
    [POST_RECIPE_UNKNOWN]: 'BAD_REQUEST',
    [POST_RECIPE_INPUT_INVALID]: 'BAD_REQUEST',
    'ledger.recipe_required': 'BAD_REQUEST',
    'ledger.insufficient_funds': 'BAD_REQUEST',
    'ledger.owner_identity_space': 'BAD_REQUEST',
    'ledger.unauthenticated': 'UNAUTHORIZED',
    'ledger.caller_unbound': 'UNAUTHORIZED',
    'ledger.caller_forbidden': 'FORBIDDEN',
    'ledger.idempotency_conflict': 'CONFLICT',
    'ledger.frozen': 'PRECONDITION_FAILED',
    'ledger.custody_layer_off': 'PRECONDITION_FAILED',
    'ledger.writes_blocked_store_unavailable': 'SERVICE_UNAVAILABLE',
    'ledger.writes_blocked_store_disk_full': 'SERVICE_UNAVAILABLE',
    'ledger.writes_blocked_clock_skew': 'SERVICE_UNAVAILABLE',
  },
  input: postRecipeInput,
  samples: [
    { verdict: 'accept', input: { recipe: 'academyPurchase', input: samplePurchase } },
    {
      verdict: 'accept',
      input: {
        recipe: 'academyPurchaseRefund',
        input: {
          course: 'perps-101',
          userId: SAMPLE_USER,
          n: '12',
          assetId: 'USDC',
          amount: '0.000000000000000001',
          from: { kind: 'partner-reserve', partnerId: 'reserve-a' },
          paymentId: SAMPLE_TX,
        },
      },
    },
    { verdict: 'accept', input: { recipe: 'feeCharge', input: sampleFee } },
    { verdict: 'accept', input: { recipe: 'chargeEarn', input: sampleEarn } },
    { verdict: 'accept', input: { recipe: 'chargeCollect', input: sampleCollect } },
    { verdict: 'accept', input: { recipe: 'bankTransfer', input: sampleTransfer } },
    {
      verdict: 'accept',
      input: { recipe: 'bankTransfer', input: { ...sampleTransfer, occurrence: 3, kind: 'scheduled', keySpace: 'sched' } },
    },
    { verdict: 'accept', input: { recipe: 'payReceivedHold', input: sampleHold } },
    { verdict: 'accept', input: { recipe: 'payReceivedRelease', input: { ...sampleHold, heldAmount: '12.5' } } },
    {
      verdict: 'accept',
      input: { recipe: 'payReceivedReturn', input: { ...sampleHold, heldAmount: '12.5', payerUserId: SAMPLE_USER } },
    },
    { verdict: 'accept', input: { recipe: 'earnDeposit', input: samplePosition } },
    { verdict: 'accept', input: { recipe: 'earnWithdraw', input: samplePosition } },
    { verdict: 'accept', input: { recipe: 'earnPoolFund', input: sampleFund } },
    { verdict: 'accept', input: { recipe: 'earnInterest', input: sampleInterest } },
    { verdict: 'accept', input: { recipe: 'loanCollateralLock', input: sampleCollateral } },
    { verdict: 'accept', input: { recipe: 'loanCollateralRelease', input: { ...sampleCollateral, sequence: 2 } } },
    { verdict: 'accept', input: { recipe: 'loanDraw', input: sampleDraw } },
    { verdict: 'accept', input: { recipe: 'loanRepay', input: sampleRepay } },
    {
      verdict: 'accept',
      input: { recipe: 'loanReserveFund', input: { fundingId: 'treasury-2026-11', debtAssetId: 'USDT', amount: '50000' } },
    },
    { verdict: 'accept', input: { recipe: 'loanLiquidate', input: sampleLiquidate } },
    { verdict: 'accept', input: { recipe: 'loanBadDebt', input: { loanId: SAMPLE_LOAN, debtAssetId: 'USDT', shortfall: '12.5' } } },
    { verdict: 'accept', input: { recipe: 'businessApprovalHold', input: sampleApproval } },
    { verdict: 'accept', input: { recipe: 'businessApprovalRelease', input: { ...sampleApproval, from: sampleSpace } } },
    { verdict: 'accept', input: { recipe: 'businessApprovalSettle', input: { ...sampleApproval, to: sampleSpace } } },
    { verdict: 'accept', input: { recipe: 'businessPayroll', input: samplePayroll } },
    { verdict: 'accept', input: { recipe: 'deposit', input: sampleDeposit } },
    { verdict: 'accept', input: { recipe: 'withdrawHold', input: sampleWithdraw } },
    { verdict: 'accept', input: { recipe: 'withdrawSettle', input: sampleWithdraw } },
    { verdict: 'accept', input: { recipe: 'withdrawReverse', input: sampleWithdraw } },
    { verdict: 'accept', input: { recipe: 'rewardPay', input: sampleReward } },
    { verdict: 'accept', input: { recipe: 'sweepFeesToRewards', input: sampleSweep } },
    { verdict: 'refuse', input: { recipe: 'loanCollateralLock', input: { ...sampleCollateral, sequence: '0' } } },
    { verdict: 'refuse', input: { recipe: 'loanCollateralLock', input: { ...sampleCollateral, sequence: -1 } } },
    { verdict: 'refuse', input: { recipe: 'loanDraw', input: { ...sampleDraw, principal: 1000 } } },
    { verdict: 'refuse', input: { recipe: 'loanRepay', input: { ...sampleRepay, interest: undefined } } },
    {
      verdict: 'refuse',
      input: { recipe: 'loanReserveFund', input: { fundingId: 'f', debtAssetId: 'USDT', amount: '1', from: samplePrimary } },
    },
    {
      verdict: 'refuse',
      input: { recipe: 'loanLiquidate', input: { ...sampleLiquidate, buyer: { ...sampleLiquidate.buyer, collateralTo: samplePrimary } } },
    },
    {
      verdict: 'refuse',
      input: { recipe: 'businessApprovalHold', input: { ...sampleApproval, from: { ...samplePrimary, ownerType: 'house' } } },
    },
    { verdict: 'refuse', input: { recipe: 'businessPayroll', input: { ...samplePayroll, payrollId: 'run-1' } } },
    { verdict: 'refuse', input: { recipe: 'deposit', input: { ...sampleDeposit, subAccountId: SAMPLE_SPACE } } },
    { verdict: 'refuse', input: { recipe: 'withdrawHold', input: { ...sampleWithdraw, fee: '1' } } },
    { verdict: 'refuse', input: { recipe: 'withdrawSettle', input: { ...sampleWithdraw, rail: 'card sim' } } },
    { verdict: 'refuse', input: { recipe: 'rewardPay', input: { ...sampleReward, reason: 'Cash Back' } } },
    { verdict: 'refuse', input: { recipe: 'sweepFeesToRewards', input: { ...sampleSweep, sourceModule: 'trade' } } },
    { verdict: 'refuse', input: { recipe: 'tradeFill', input: samplePurchase } },
    { verdict: 'refuse', input: { recipe: 'deposit', input: samplePurchase } },
    { verdict: 'refuse', input: { recipe: 'earnDeposit', input: { ...samplePosition, amount: '-1' } } },
    { verdict: 'refuse', input: { recipe: 'earnDeposit', input: { ...samplePosition, positionId: 'position-1' } } },
    { verdict: 'refuse', input: { recipe: 'earnWithdraw', input: { ...samplePosition, poolId: undefined } } },
    { verdict: 'refuse', input: { recipe: 'earnPoolFund', input: { ...sampleFund, from: { ownerType: 'house', ownerId: 'fees:bank' } } } },
    { verdict: 'refuse', input: { recipe: 'earnPoolFund', input: { ...sampleFund, fundingId: 'f'.repeat(129) } } },
    { verdict: 'refuse', input: { recipe: 'earnInterest', input: { ...sampleInterest, date: '2026-11-2' } } },
    { verdict: 'refuse', input: { recipe: 'earnInterest', input: { ...sampleInterest, payouts: [{ userId: SAMPLE_USER, amount: 0.5 }] } } },
    { verdict: 'refuse', input: { recipe: 'bankTransfer', input: { ...sampleTransfer, keySpace: undefined } } },
    { verdict: 'refuse', input: { recipe: 'bankTransfer', input: { ...sampleTransfer, keySpace: 'legacy' } } },
    { verdict: 'refuse', input: { recipe: 'bankTransfer', input: { ...sampleTransfer, occurrence: -1 } } },
    { verdict: 'refuse', input: { recipe: 'bankTransfer', input: { ...sampleTransfer, occurrence: '0' } } },
    { verdict: 'refuse', input: { recipe: 'bankTransfer', input: { ...sampleTransfer, transferId: 'a b' } } },
    { verdict: 'refuse', input: { recipe: 'bankTransfer', input: { ...sampleTransfer, amount: 12.5 } } },
    {
      verdict: 'refuse',
      input: { recipe: 'bankTransfer', input: { ...sampleTransfer, to: { ...sampleTransfer.to, kind: 'hold', purpose: 'x' } } },
    },
    {
      verdict: 'refuse',
      input: {
        recipe: 'bankTransfer',
        input: { ...sampleTransfer, to: { ...sampleTransfer.to, ownerType: 'house', ownerId: 'fees:bank' } },
      },
    },
    { verdict: 'refuse', input: { recipe: 'payReceivedHold', input: { ...sampleHold, holdId: 'h'.repeat(120) } } },
    { verdict: 'refuse', input: { recipe: 'payReceivedRelease', input: sampleHold } },
    { verdict: 'refuse', input: { recipe: 'payReceivedReturn', input: { ...sampleHold, heldAmount: '12.5' } } },
    { verdict: 'refuse', input: { recipe: 'feeCharge', input: { ...sampleFee, mode: 'token' } } },
    { verdict: 'refuse', input: { recipe: 'feeCharge', input: { ...sampleFee, chargeId: 'a b' } } },
    { verdict: 'refuse', input: { recipe: 'chargeEarn', input: { ...sampleEarn, price: { perUnit: null } } } },
    { verdict: 'refuse', input: { recipe: 'chargeEarn', input: { ...sampleEarn, units: '0' } } },
    { verdict: 'refuse', input: { recipe: 'chargeEarn', input: { ...sampleEarn, saleId: 'a:b' } } },
    { verdict: 'refuse', input: { recipe: 'chargeCollect', input: { ...sampleCollect, amount: '-1' } } },
    { verdict: 'refuse', input: { recipe: 'chargeCollect', input: { ...sampleCollect, to: { kind: 'vault', walletId: 'w' } } } },
    { verdict: 'refuse', input: { recipe: 'academyPurchase', input: { ...samplePurchase, amount: 2.5 } } },
    { verdict: 'refuse', input: { recipe: 'academyPurchase', input: { ...samplePurchase, amount: '-1' } } },
    { verdict: 'refuse', input: { recipe: 'academyPurchase', input: { ...samplePurchase, n: '0' } } },
    { verdict: 'refuse', input: { recipe: 'academyPurchase', input: { ...samplePurchase, amount: '1.0000000000000000001' } } },
    {
      verdict: 'refuse',
      input: { recipe: 'academyPurchase', input: { ...samplePurchase, userId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' } },
    },
    { verdict: 'refuse', input: { recipe: 'academyPurchase', input: { ...samplePurchase, extra: true } } },
    { verdict: 'refuse', input: { recipe: 'academyPurchase', input: samplePurchase, idempotencyKey: 'mine' } },
  ],
  output: z.object({
    txId: z.string().min(1),
    /** The recipe's own business key the post was booked under. */
    idempotencyKey: z.string().min(1),
    module: z.string(),
    reason: z.string(),
    hash: z.string().min(1),
    postedAt: z.string(),
    entries: z.array(postedEntry),
  }),
});

export type PostRecipeCall = z.input<typeof LEDGER_POST_RECIPE.input>;
export type PostRecipeReceipt = z.output<typeof LEDGER_POST_RECIPE.output>;

/**
 * The post the door books for a call: the body is checked against the record, then built by the registry recipe. A
 * name the door does not post refuses `ledger.recipe_unknown`; inputs the record or the recipe refuses refuse
 * `ledger.recipe_input_invalid`. Both before anything is read or booked. The server and the in-process poster share it.
 */
export function postRecipeRequest(body: unknown): { readonly recipe: PostRecipeName; readonly request: PostRequest } {
  const named = isRecord(body) ? body.recipe : undefined;
  if (!isPostRecipeName(named)) {
    throw new LedgerError(
      `postRecipe posts only ${POST_RECIPE_NAMES.join(', ')}; got ${JSON.stringify(named ?? null)}`,
      POST_RECIPE_UNKNOWN,
    );
  }
  const parsed = LEDGER_POST_RECIPE.input.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new LedgerError(
      `${named}: ${issue ? `${issue.path.join('.') || '(body)'}: ${issue.message}` : 'invalid'}`,
      POST_RECIPE_INPUT_INVALID,
    );
  }
  try {
    return { recipe: named, request: RECIPE_DOORS[named].run(parsed.data.input) };
  } catch (err) {
    // The recipe's own refusal (`InvalidEntryError`) or an amount the book cannot hold (`MoneyError`): the caller's inputs.
    if (err instanceof MoneyError || (err instanceof LedgerError && err.code === 'ledger.invalid_entry')) {
      throw new LedgerError(`${named}: ${err.message}`, POST_RECIPE_INPUT_INVALID);
    }
    throw err;
  }
}
