import { z } from 'zod';
import { isRecord } from '@intafaced/contracts/guards';
import { defineProcedure } from '@intafaced/contracts/procedure';
import { MoneyError, parseAmount } from './money.js';
import { recipes, type RecipeName } from './recipes/index.js';
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
 * recipes, and svc-agents' usage charge (`feeCharge` in its asset mode, `chargeEarn`, `chargeCollect`).
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

export const LEDGER_POST_RECIPE = defineProcedure({
  name: 'ledger.postRecipe',
  service: 'svc-ledger',
  transport: 'http',
  method: 'POST',
  path: '/trpc/postRecipe',
  /** The services granted a recipe on this door (`gate/caller-allowlist.ts`); svc-ledger's `post-recipe-door.test.ts` holds them equal. */
  access: { caller: 'service', callers: ['svc-academy', 'svc-agents'] },
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
    { verdict: 'refuse', input: { recipe: 'deposit', input: samplePurchase } },
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
