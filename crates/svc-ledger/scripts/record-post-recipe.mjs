// Records, from `@intafaced/ledger-client` in this checkout, what the Rust ledger's `postRecipe` door is held to now
// that the TypeScript svc-ledger is gone (`record-door.mjs` recorded the rest before it was deleted, and its files are
// the reference for what they hold):
//
// - `src/door/schemas.json`: the `postRecipe` input and the `postRecipeReply` output, as the record
//   (`post-recipe-record.ts`) writes them, in the tree of zod 4 parts the kit's schema engine runs; and the
//   `operatorReverse` input and `operatorReverseReply` output from that door's record (`operator-reverse-record.ts`),
//   a door the TypeScript service never had. Every other part is kept as recorded; a part nothing names any more is
//   dropped.
// - `tests/fixtures/input-parity.golden.json`: zod's verdict on each `postRecipe` and `postRecipeReply` input there,
//   and on the record's own samples; the same for the `operatorReverse` record's samples.
// - `tests/fixtures/post-recipe-bank.golden.jsonl`: what the door answers each caller for bodies made to reach each
//   check of svc-bank's recipes (`bankTransfer`, `payReceivedHold`, `payReceivedRelease`, `payReceivedReturn`,
//   `earnDeposit`, `earnWithdraw`, `earnPoolFund`, `earnInterest`): its refusal on the wire, or the post it hands the
//   ledger. Same shape as `post-recipe.golden.jsonl`.
// - `tests/fixtures/post-recipe-bank-2.golden.jsonl`: the same for svc-bank's other recipes (`BANK_RECIPES_2`: loans,
//   business approvals and payroll, ramps and card holds, cashback), in its own file so each stays reviewable.
//
// The door is `handleS2sPostRecipe` as the deleted service ran it up to `ledger.post` (read it in git history:
// `git show 653924e16^:services/svc-ledger/src/s2s-http.ts`), over this package's own record, gate and recipes. Before
// it writes anything, it replays every body of the frozen `post-recipe.golden.jsonl` and stops unless it gives each
// recorded caller the very answer the TypeScript service gave: the stand-in is held to the service it replaces.
//
// Run from the repository root, with the workspace packages built (`pnpm --filter "@intafaced/ledger-client^..." build`):
//   TZ=UTC node --import tsx crates/svc-ledger/scripts/record-post-recipe.mjs          writes the files
//   TZ=UTC node --import tsx crates/svc-ledger/scripts/record-post-recipe.mjs --check  fails when a written file is stale

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CRATE = fileURLToPath(new URL('../', import.meta.url));
const NAME = 'record-post-recipe';
const CHECK = process.argv.includes('--check');
if (process.env.TZ !== 'UTC') {
  console.error(`${NAME}: run with TZ=UTC`);
  process.exit(2);
}

// Literal paths, so the dead-code scan (knip.jsonc) sees what this reads.
const record = await import('../../../packages/ledger-client/src/post-recipe-record.ts');
const { LEDGER_OPERATOR_REVERSE } = await import('../../../packages/ledger-client/src/operator-reverse-record.ts');
const gate = await import('../../../packages/ledger-client/src/gate/index.ts');
const { LedgerError, postRequestSchema } = await import('../../../packages/ledger-client/src/types.ts');
const { ledgerPostWire } = await import('../../../packages/ledger-client/src/http-client.ts');
const { formatAmount, parseAmount } = await import('../../../packages/ledger-client/src/money.ts');
// zod as the ledger client resolves it, so a refusal of its schemas is this zod's error.
const { z } = await import(
  pathToFileURL(createRequire(fileURLToPath(new URL('../../../packages/ledger-client/src/types.ts', import.meta.url))).resolve('zod')).href
);

const { isRecord } = await import('../../../packages/contracts/src/guards.ts');
const { LEDGER_POST_RECIPE, POST_RECIPE_NAMES, POST_RECIPE_UNKNOWN, POST_RECIPE_INPUT_INVALID, isPostRecipeName, postRecipeRequest } =
  record;
const { CALLER_FORBIDDEN, CALLER_UNBOUND, RECIPE_REQUIRED_CODE, assertKnownRecipePost, grantFor, judgeCallerPost } = gate;

// ── The door, up to `ledger.post` ──────────────────────────────────────────────────────────────────────────────────

/** `caller-binding.ts` `violationMessage`. */
function violationMessage(v) {
  if (v.code === CALLER_UNBOUND) return 'Ledger post requires a per-service key.';
  if (v.reason === 'module') return `Caller ${v.service} may not post module ${v.module}${v.recipe ? ` as ${v.recipe}` : ''}.`;
  return `Caller ${v.service} may not post recipe ${v.recipe ?? 'unknown'} (module ${v.module}).`;
}

/**
 * `handleS2sPostRecipe` then `postChecked` up to `ledger.post`, with no binding options (no keys configured): only a
 * proven caller is held to the allowlist. The four binding checks that read the book act on reasons none of the door's
 * recipes books; the frozen replay below would show it if one did.
 */
function door(caller, body) {
  const named = isRecord(body) ? body.recipe : undefined;
  if (!isPostRecipeName(named)) throw new LedgerError(`postRecipe does not post ${JSON.stringify(named ?? null)}.`, POST_RECIPE_UNKNOWN);
  const grant = caller?.kind === 'bound' ? grantFor(caller.service, named) : undefined;
  if (caller?.kind === 'bound' && !grant) throw new LedgerError(`Caller ${caller.service} may not post recipe ${named}.`, CALLER_FORBIDDEN);
  const { request } = postRecipeRequest(body);
  if (caller?.kind === 'bound' && grant?.module !== request.module) {
    throw new LedgerError(`Caller ${caller.service} may not post module ${request.module} as ${named}.`, CALLER_FORBIDDEN);
  }
  const input = postRequestSchema.parse(ledgerPostWire(request));
  if (caller) {
    const judged = judgeCallerPost(caller, input);
    if (!judged.ok && caller.kind === 'bound') throw new LedgerError(violationMessage(judged.violation), judged.violation.code);
  }
  assertKnownRecipePost(input);
  // What `ledger.post` was handed, written as the recording writes it.
  return {
    post: {
      idempotencyKey: input.idempotencyKey,
      module: input.module,
      reason: input.reason,
      entries: input.entries.map((e) => ({ account: e.account, direction: e.direction, amount: formatAmount(parseAmount(e.amount)) })),
      ...(input.meta ? { meta: input.meta } : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    },
  };
}

/** `s2s-http.ts` `httpError`, for the refusals the door raises before the ledger; any other stops the recording. */
const STATUS = {
  [POST_RECIPE_UNKNOWN]: 400,
  [POST_RECIPE_INPUT_INVALID]: 400,
  [RECIPE_REQUIRED_CODE]: 400,
  'ledger.owner_identity_space': 400,
  [CALLER_UNBOUND]: 401,
  [CALLER_FORBIDDEN]: 403,
};
function answer(caller, body) {
  try {
    return JSON.stringify(door(caller, body));
  } catch (err) {
    if (err instanceof z.ZodError) return JSON.stringify({ status: 400, body: { message: err.message } });
    if (err instanceof LedgerError && STATUS[err.code]) {
      return JSON.stringify({ status: STATUS[err.code], body: { message: err.message, code: err.code } });
    }
    throw err;
  }
}

const BANK_RECIPES = [
  'bankTransfer',
  'payReceivedHold',
  'payReceivedRelease',
  'payReceivedReturn',
  'earnDeposit',
  'earnWithdraw',
  'earnPoolFund',
  'earnInterest',
];
const BANK_RECIPES_2 = [
  'loanCollateralLock',
  'loanCollateralRelease',
  'loanDraw',
  'loanRepay',
  'loanReserveFund',
  'loanLiquidate',
  'loanBadDebt',
  'businessApprovalHold',
  'businessApprovalRelease',
  'businessApprovalSettle',
  'businessPayroll',
  'deposit',
  'withdrawHold',
  'withdrawSettle',
  'withdrawReverse',
  'rewardPay',
  'sweepFeesToRewards',
];
// A frozen body that names one of svc-bank's recipes (the deleted service did not post `deposit`) is held by svc-bank's
// recording instead: the frozen answer was the door before it took the recipe.
const SUPERSEDED = [];

// ── The frozen recording, replayed ─────────────────────────────────────────────────────────────────────────────────

const FROZEN = `${CRATE}tests/fixtures/post-recipe.golden.jsonl`;
{
  const [head, ...lines] = readFileSync(FROZEN, 'utf8').trimEnd().split('\n');
  const { callers, answers } = JSON.parse(head);
  let replayed = 0;
  for (const line of lines) {
    const [text, said] = JSON.parse(line);
    const body = text === null ? undefined : JSON.parse(text);
    if (isRecord(body) && [...BANK_RECIPES, ...BANK_RECIPES_2].includes(body.recipe)) {
      SUPERSEDED.push(body);
      continue;
    }
    callers.forEach((caller, i) => {
      const got = answer(caller, body);
      if (got !== answers[said[i]]) {
        console.error(
          `${NAME}: the door no longer answers as the TypeScript service did\n  body ${text}\n  caller ${JSON.stringify(caller)}`,
        );
        console.error(`  then ${answers[said[i]]}\n  now  ${got}`);
        process.exit(1);
      }
      replayed++;
    });
  }
  console.log(`${replayed} frozen answers replayed, all the same; ${SUPERSEDED.length} bodies held by svc-bank's recording`);
}

// ── svc-bank's bodies ──────────────────────────────────────────────────────────────────────────────────────────────

const CALLERS = [
  { kind: 'bound', service: 'svc-bank' },
  { kind: 'bound', service: 'svc-academy' },
  { kind: 'bound', service: 'svc-pay' },
  { kind: 'legacy', claimed: 'svc-bank' },
  { kind: 'legacy', claimed: null },
  null,
];
const USER = '22222222-2222-4222-8222-222222222222';
const PAYEE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SPACE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const user = (ownerId, assetId = 'USDC') => ({ ownerType: 'user', ownerId, assetId, kind: 'available' });
const space = (ownerId, assetId = 'USDC') => ({ ownerType: 'subaccount', ownerId, assetId, kind: 'available' });
const rail = (railId, assetId = 'USDC') => ({ ownerType: 'treasury', ownerId: `rail:${railId}`, assetId, kind: 'available' });
const TRANSFER = {
  transferId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  occurrence: 0,
  from: user(USER),
  to: user(PAYEE),
  amount: '12.5',
  kind: 'manual',
  keySpace: 'p2p',
};
const HOLD = { holdId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', userId: PAYEE, assetId: 'USDC', amount: '12.5' };
const OUTCOME = { ...HOLD, heldAmount: '12.5' };
const RETURN = { ...OUTCOME, payerUserId: USER };
const POOL = '99999999-9999-4999-8999-999999999999';
const POSITION = { positionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', poolId: POOL, userId: USER, assetId: 'USDT', amount: '100' };
const FUND = { poolId: POOL, fundingId: 'treasury-2026-11', assetId: 'USDT', amount: '50' };
const INTEREST = {
  poolId: POOL,
  date: '2026-11-22',
  assetId: 'USDT',
  payouts: [
    { userId: USER, amount: '0.013698630136986301' },
    { userId: PAYEE, amount: '0.5' },
  ],
};
const MAX = `${'9'.repeat(20)}.${'9'.repeat(18)}`;

const AMOUNTS = [
  '0',
  '0.0',
  '00',
  '01',
  '1.',
  '.5',
  '+1',
  '-1',
  '1e3',
  ' 1',
  '12.50',
  '0.000000000000000001',
  '1.0000000000000000001',
  '9'.repeat(20),
  `${'9'.repeat(20)}.${'9'.repeat(18)}`,
  `1${'0'.repeat(20)}`,
  '9'.repeat(64),
  '9'.repeat(65),
  '',
  12.5,
  null,
];
const IDS = [USER.toUpperCase(), USER.replaceAll('-', ''), `${USER}0`, 'x', '', 7, null];
const ACCOUNTS = [
  user(USER),
  user(PAYEE),
  space(SPACE),
  space(USER),
  rail('card-sandbox'),
  rail('crypto-native:base'),
  rail('A_b.c'),
  user(PAYEE, 'USDT'),
  user(PAYEE, 'U'.repeat(16)),
  user(PAYEE, 'U'.repeat(17)),
  user(PAYEE, ' USDC'),
  user(PAYEE, ''),
  user(PAYEE.toUpperCase()),
  user('fees:bank'),
  space('rail:x'),
  { ...rail('x'), ownerId: 'rail:' },
  { ...rail('x'), ownerId: 'rail:a b' },
  { ...rail('x'), ownerId: `rail:${'r'.repeat(123)}` },
  { ...rail('x'), ownerId: `rail:${'r'.repeat(124)}` },
  { ...rail('x'), ownerId: 'fees:bank' },
  { ...rail('x'), ownerId: PAYEE },
  { ...user(PAYEE), ownerType: 'house', ownerId: 'fees:bank' },
  { ...user(PAYEE), ownerType: 'module', ownerId: 'bank:x' },
  { ...user(PAYEE), kind: 'hold', purpose: 'x' },
  { ...user(PAYEE), purpose: '' },
  { ...user(PAYEE), extra: 1 },
  { ownerType: 'user', ownerId: PAYEE, assetId: 'USDC' },
  { ownerId: PAYEE, assetId: 'USDC', kind: 'available' },
  'user',
  null,
];
const FIELDS = {
  bankTransfer: {
    transferId: ['x', 'a:b', 'a b', '', ' x', 'x ', 't'.repeat(160), 't'.repeat(161), 7, null],
    occurrence: [1, 2_147_483_647, 2_147_483_648, -1, 1.5, '0', true, null],
    from: ACCOUNTS,
    to: ACCOUNTS,
    amount: AMOUNTS,
    kind: ['scheduled', 'auto', '', null],
    keySpace: ['own', 'sched', 'rail', 'recovery', 'legacy', '', null],
  },
  payReceivedHold: {
    holdId: ['x', 'a:b', 'a b', '', ' h', 'h'.repeat(119), 'h'.repeat(120), 7, null],
    userId: IDS,
    assetId: ['BTC', '', 'U'.repeat(16), 'U'.repeat(17), ' USDC', 'US DC', 'ü', 7, null],
    amount: AMOUNTS,
  },
};
FIELDS.payReceivedRelease = { ...FIELDS.payReceivedHold, heldAmount: [...AMOUNTS, '5'] };
FIELDS.payReceivedReturn = { ...FIELDS.payReceivedRelease, payerUserId: [PAYEE, ...IDS] };
const EARN_ASSETS = FIELDS.payReceivedHold.assetId;
FIELDS.earnDeposit = { positionId: IDS, poolId: IDS, userId: IDS, assetId: EARN_ASSETS, amount: AMOUNTS };
FIELDS.earnWithdraw = FIELDS.earnDeposit;
FIELDS.earnPoolFund = {
  poolId: IDS,
  fundingId: ['x', 'a:b', 'a b', '', ' f', 'ü', 'f'.repeat(128), 'f'.repeat(129), 7, null],
  assetId: EARN_ASSETS,
  amount: AMOUNTS,
  from: [{ ownerType: 'house', ownerId: 'fees:bank', assetId: 'USDT', kind: 'available' }],
};
const payout = (userId, amount) => ({ userId, amount });
FIELDS.earnInterest = {
  poolId: IDS,
  date: [
    '2026-02-31',
    '2026-02-29',
    '2028-02-29',
    '2000-02-29',
    '2100-02-29',
    '0000-02-29',
    '2026-04-31',
    '2026-04-30',
    '2026-12-31',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '2026-01-32',
    '2026-1-01',
    '2026-01-01T00:00:00Z',
    ' 2026-01-01',
    '2026/01/01',
    '',
    20260101,
    null,
  ],
  assetId: EARN_ASSETS,
  payouts: [
    [],
    [payout(USER, '0')],
    [payout(USER, '1'), payout(PAYEE, '0')],
    [payout(USER, '1')],
    [payout(USER, '1'), payout(USER, '2')],
    [payout(USER, MAX)],
    [payout(USER, MAX), payout(PAYEE, '0.000000000000000001')],
    [payout(USER, MAX), payout(PAYEE, MAX)],
    [payout(USER, '1'), payout(PAYEE, '9'.repeat(21))],
    ...AMOUNTS.map((a) => [payout(USER, a)]),
    ...IDS.map((id) => [payout(id, '1')]),
    [{ userId: USER }],
    [{ amount: '1' }],
    [{ ...payout(USER, '1'), extra: 1 }],
    [null],
    'x',
    {},
    null,
  ],
};

const BODIES = [
  // Every key space as svc-bank books it, in the kind that goes with it.
  { recipe: 'bankTransfer', input: { ...TRANSFER, keySpace: 'own', to: space(SPACE) } },
  { recipe: 'bankTransfer', input: { ...TRANSFER, keySpace: 'own', from: space(SPACE), to: user(USER) } },
  { recipe: 'bankTransfer', input: { ...TRANSFER, occurrence: 4, kind: 'scheduled', keySpace: 'sched' } },
  { recipe: 'bankTransfer', input: { ...TRANSFER, keySpace: 'rail', to: rail('card-sandbox') } },
  { recipe: 'bankTransfer', input: { ...TRANSFER, occurrence: 1, keySpace: 'rail', from: rail('card-sandbox'), to: user(USER) } },
  {
    recipe: 'bankTransfer',
    input: {
      ...TRANSFER,
      transferId: `ffffffff-ffff-4fff-8fff-ffffffffffff:user:${USER}:USDC:available:`,
      occurrence: 2,
      keySpace: 'recovery',
    },
  },
  { recipe: 'bankTransfer', input: { ...TRANSFER, occurrence: 4, kind: 'scheduled', keySpace: 'p2p' } },
  { recipe: 'bankTransfer', input: { ...TRANSFER, kind: 'manual', keySpace: 'sched' } },
  // A longest key: the record's widest transfer id and occurrence.
  { recipe: 'bankTransfer', input: { ...TRANSFER, transferId: 't'.repeat(160), occurrence: 2_147_483_647, keySpace: 'recovery' } },
  { recipe: 'payReceivedHold', input: { ...HOLD, holdId: 'h'.repeat(119), assetId: 'U'.repeat(16) } },
  { recipe: 'payReceivedRelease', input: { ...OUTCOME, amount: '5' } },
  { recipe: 'payReceivedReturn', input: { ...RETURN, amount: '12.50', heldAmount: '12.5' } },
  { recipe: 'payReceivedReturn', input: { ...RETURN, payerUserId: PAYEE } },
  // Another service's recipe and body, and svc-bank's recipe with another's inputs.
  { recipe: 'academyPurchase', input: { ...TRANSFER } },
  { recipe: 'bankTransfer', input: HOLD },
  { recipe: 'payReceivedHold', input: TRANSFER },
  { recipe: 'payReceivedHold', input: OUTCOME },
  { recipe: 'payReceivedRelease', input: RETURN },
  // The earn recipes' own mix-ups: one's inputs under another's name.
  { recipe: 'earnPoolFund', input: POSITION },
  { recipe: 'earnInterest', input: FUND },
  { recipe: 'earnDeposit', input: FUND },
  { recipe: 'bankTransfer', input: POSITION },
  // svc-bank's own shapes: a funding id at its widest, a position in another asset.
  { recipe: 'earnPoolFund', input: { ...FUND, fundingId: `ops:${'x'.repeat(60)}` } },
  { recipe: 'earnDeposit', input: { ...POSITION, assetId: 'BTC', amount: '0.000000000000000001' } },
  { recipe: 'earnWithdraw', input: { ...POSITION, amount: MAX } },
];
for (const [recipe, base] of [
  ['bankTransfer', TRANSFER],
  ['payReceivedHold', HOLD],
  ['payReceivedRelease', OUTCOME],
  ['payReceivedReturn', RETURN],
  ['earnDeposit', POSITION],
  ['earnWithdraw', POSITION],
  ['earnPoolFund', FUND],
  ['earnInterest', INTEREST],
]) {
  BODIES.push({ recipe, input: base });
  for (const [field, values] of Object.entries(FIELDS[recipe])) {
    const without = { ...base };
    delete without[field];
    BODIES.push({ recipe, input: without });
    for (const v of values) BODIES.push({ recipe, input: { ...base, [field]: v } });
  }
  BODIES.push({ recipe, input: { ...base, extra: 1 } }, { recipe, input: base, idempotencyKey: 'mine' });
}

// svc-bank's loans (`loans/service.rs`, `loans/sweep.rs`), business (`business/service.rs`), ramps and card holds
// (`ramps/`, `cards/moves/`, `partner_account/cash_out/ledger.rs`) and cashback (`cards/moves/cashback.rs`), as it
// sends them.
const LOAN = '55555555-5555-4555-8555-555555555555';
// Shorter lists than the earlier recipes' (the schema engine is held field by field by the zod verdicts): each still
// reaches the record's bound, a value the recipe refuses, and one the book cannot hold.
const SEQUENCES = [1, 2_147_483_648, -1, '0'];
const ASSETS = ['BTC', 'U'.repeat(16), 'U'.repeat(17), ' USDC', ''];
const SOME_AMOUNTS = ['0', '12.50', '0.000000000000000001', MAX, `1${'0'.repeat(20)}`, '-1', 12.5];
const SOME_IDS = [USER.toUpperCase(), 'x', null];
const COLLATERAL = { loanId: LOAN, userId: USER, collateralAssetId: 'BTC', amount: '0.5', sequence: 0 };
const DRAW = { loanId: LOAN, userId: USER, debtAssetId: 'USDT', principal: '1000' };
const REPAY = { ...DRAW, principal: '100', interest: '1.25', sequence: 1 };
const RESERVE = { fundingId: 'treasury-2026-11', debtAssetId: 'USDT', amount: '50000' };
const mm = (assetId) => ({ ownerType: 'house', ownerId: 'market-maker', assetId, kind: 'available' });
const LIQUIDATE = {
  loanId: LOAN,
  userId: USER,
  tranche: 0,
  collateralAssetId: 'BTC',
  collateralSold: '0.1',
  debtAssetId: 'USDT',
  proceeds: '6000',
  principalRepaid: '5000',
  interestRepaid: '10',
  penalty: '300',
  surplusToBorrower: '690',
  buyer: { collateralTo: mm('BTC'), proceedsFrom: mm('USDT') },
  markPrice: '60000',
};
const BAD_DEBT = { loanId: LOAN, debtAssetId: 'USDT', shortfall: '12.5' };
const APPROVAL = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const APPROVE = { approvalId: APPROVAL, from: user(USER), amount: '250' };
const SETTLE = { ...APPROVE, to: space(SPACE) };
const PAYROLL = {
  payrollId: APPROVAL,
  from: user(USER),
  recipients: [
    { to: space(SPACE), amount: '100' },
    { to: user(PAYEE), amount: '50' },
  ],
};
const DEPOSIT = { userId: USER, assetId: 'USDC', amount: '25', rail: 'bank-crypto-ledger', railRef: '0xabc' };
const WITHDRAW = { userId: USER, assetId: 'USDC', amount: '25', rail: 'bank-crypto-ledger', withdrawalId: SPACE };
const REWARD = { rewardId: `bank.card.cashback:${SPACE}`, userId: USER, assetId: 'USDC', amount: '0.25', reason: 'bank.card.cashback' };
const SWEEP = { windowId: 'bank.card:2026-11', sourceModule: 'bank', assetId: 'USDC', amount: '10' };
const SPACE_ACCOUNTS = [
  space(SPACE),
  user(USER, 'USDT'),
  rail('card-sandbox'),
  { ...user(PAYEE), ownerType: 'house', ownerId: 'fees:bank' },
  { ...user(PAYEE), kind: 'hold', purpose: 'x' },
  null,
];
const RAILS = ['card-sim', 'crypto-native:base', 'r'.repeat(123), 'r'.repeat(124), 'a b', 'a:', ''];
FIELDS.loanCollateralLock = { loanId: SOME_IDS, userId: SOME_IDS, collateralAssetId: ASSETS, amount: SOME_AMOUNTS, sequence: SEQUENCES };
FIELDS.loanCollateralRelease = FIELDS.loanCollateralLock;
FIELDS.loanDraw = { loanId: SOME_IDS, userId: SOME_IDS, debtAssetId: ASSETS, principal: SOME_AMOUNTS };
FIELDS.loanRepay = { ...FIELDS.loanDraw, interest: SOME_AMOUNTS, sequence: SEQUENCES };
FIELDS.loanReserveFund = {
  fundingId: FIELDS.earnPoolFund.fundingId,
  debtAssetId: ASSETS,
  amount: SOME_AMOUNTS,
  from: [{ ownerType: 'house', ownerId: 'fees:bank', assetId: 'USDT', kind: 'available' }],
};
FIELDS.loanLiquidate = {
  loanId: ['x'],
  userId: ['x'],
  tranche: SEQUENCES,
  collateralAssetId: ['USDT', 'U'.repeat(17), ''],
  collateralSold: ['0', '1.0000000000000000001', MAX],
  debtAssetId: ['BTC', ''],
  proceeds: ['6001', '0', '-1', 6000],
  principalRepaid: ['5001', '6000', MAX],
  interestRepaid: ['9', MAX],
  penalty: ['301', MAX],
  surplusToBorrower: ['691', '0'],
  buyer: [
    { collateralTo: mm('USDT'), proceedsFrom: mm('USDT') },
    { collateralTo: mm('BTC'), proceedsFrom: mm('BTC') },
    { collateralTo: user(USER, 'BTC'), proceedsFrom: mm('USDT') },
    { collateralTo: mm('BTC'), proceedsFrom: { ...mm('USDT'), ownerId: 'fees:bank' } },
    { collateralTo: mm('BTC') },
    { collateralTo: mm('BTC'), proceedsFrom: mm('USDT'), extra: 1 },
    null,
  ],
  markPrice: ['0', 60000],
};
FIELDS.loanBadDebt = { loanId: SOME_IDS, debtAssetId: ASSETS, shortfall: SOME_AMOUNTS };
FIELDS.businessApprovalHold = { approvalId: SOME_IDS, from: SPACE_ACCOUNTS, amount: SOME_AMOUNTS };
FIELDS.businessApprovalRelease = FIELDS.businessApprovalHold;
FIELDS.businessApprovalSettle = { ...FIELDS.businessApprovalHold, to: [user(USER), ...SPACE_ACCOUNTS] };
const line = (to, amount) => ({ to, amount });
FIELDS.businessPayroll = {
  payrollId: [APPROVAL.toUpperCase(), ...SOME_IDS],
  from: SPACE_ACCOUNTS,
  recipients: [
    [],
    [line(user(USER), '1')],
    [line(space(SPACE), '1'), line(space(SPACE), '2')],
    [line(space(SPACE), '0')],
    [line(user(PAYEE, 'USDT'), '1')],
    [line(space(SPACE), MAX), line(user(PAYEE), MAX)],
    [line(space(SPACE), MAX)],
    [line(space(SPACE), '-1')],
    [line(user(PAYEE.toUpperCase()), '1')],
    [line(rail('card-sandbox'), '1')],
    [{ to: space(SPACE) }],
    [{ ...line(space(SPACE), '1'), extra: 1 }],
    [null],
    'x',
    null,
  ],
};
FIELDS.deposit = {
  userId: SOME_IDS,
  assetId: ASSETS,
  amount: SOME_AMOUNTS,
  rail: RAILS,
  railRef: ['tx 0xabc', `cash-out-return:${SPACE}`, 'r'.repeat(256), 'r'.repeat(257), '', 7, null],
  subAccountId: [SPACE],
  confirmed: [true, false],
};
FIELDS.withdrawHold = {
  userId: SOME_IDS,
  assetId: ASSETS,
  amount: SOME_AMOUNTS,
  rail: RAILS,
  withdrawalId: [`cash-out:${SPACE}`, 'w'.repeat(119), 'w'.repeat(120), 'a b', ''],
  fee: ['0', '1'],
};
FIELDS.withdrawSettle = FIELDS.withdrawHold;
FIELDS.withdrawReverse = FIELDS.withdrawHold;
FIELDS.rewardPay = {
  rewardId: ['r', 'r'.repeat(160), 'r'.repeat(161), 'a b', '', 7, null],
  userId: SOME_IDS,
  assetId: ASSETS,
  amount: SOME_AMOUNTS,
  reason: ['staking.yield', 'Cash Back', '', 'r'.repeat(65), 7, null],
};
FIELDS.sweepFeesToRewards = {
  windowId: ['w', 'w'.repeat(128), 'w'.repeat(129), 'a b', '', 7, null],
  sourceModule: ['trade', 'Bank', '', null],
  assetId: ASSETS,
  amount: SOME_AMOUNTS,
};

const BODIES_2 = [
  // svc-bank's own shapes for the rest: a repayment of only interest or only principal, a liquidation with no house share
  // or no surplus, a release from a named space, the widest payroll run, a card hold on its issuer's rail.
  { recipe: 'loanRepay', input: { ...REPAY, principal: '0' } },
  { recipe: 'loanRepay', input: { ...REPAY, interest: '0' } },
  { recipe: 'loanRepay', input: { ...REPAY, principal: '0', interest: '0' } },
  { recipe: 'loanRepay', input: { ...REPAY, principal: MAX, interest: '1' } },
  { recipe: 'loanLiquidate', input: { ...LIQUIDATE, interestRepaid: '0', penalty: '0', principalRepaid: '5310' } },
  { recipe: 'loanLiquidate', input: { ...LIQUIDATE, surplusToBorrower: '0', principalRepaid: '5690' } },
  { recipe: 'loanLiquidate', input: { ...LIQUIDATE, principalRepaid: '0', surplusToBorrower: '5690' } },
  { recipe: 'businessApprovalRelease', input: { ...APPROVE, from: space(SPACE) } },
  { recipe: 'businessApprovalSettle', input: { ...SETTLE, from: space(SPACE), to: user(USER) } },
  { recipe: 'businessApprovalSettle', input: { ...SETTLE, to: space(SPACE, 'USDT') } },
  { recipe: 'withdrawHold', input: { ...WITHDRAW, rail: 'card-sim' } },
  { recipe: 'deposit', input: { ...DEPOSIT, railRef: `cash-out-return:${SPACE}` } },
  { recipe: 'deposit', input: { ...DEPOSIT, rail: 'r'.repeat(60), railRef: 'r'.repeat(131) } },
  { recipe: 'deposit', input: { ...DEPOSIT, rail: 'r'.repeat(60), railRef: 'r'.repeat(132) } },
  // One recipe's inputs under another's name.
  { recipe: 'loanDraw', input: COLLATERAL },
  { recipe: 'loanCollateralLock', input: DRAW },
  { recipe: 'withdrawHold', input: DEPOSIT },
  { recipe: 'deposit', input: WITHDRAW },
  { recipe: 'businessApprovalSettle', input: APPROVE },
  // The frozen bodies that name one of these recipes.
  ...SUPERSEDED,
];
/** Each recipe's own body, then each field missing and each of its values, then an extra field and a key of its own. */
function fuzz(bodies, recipe, base) {
  bodies.push({ recipe, input: base });
  for (const [field, values] of Object.entries(FIELDS[recipe])) {
    const without = { ...base };
    delete without[field];
    bodies.push({ recipe, input: without });
    for (const v of values) bodies.push({ recipe, input: { ...base, [field]: v } });
  }
  bodies.push({ recipe, input: { ...base, extra: 1 } }, { recipe, input: base, idempotencyKey: 'mine' });
}
for (const [recipe, base] of [
  ['loanCollateralLock', COLLATERAL],
  ['loanCollateralRelease', COLLATERAL],
  ['loanDraw', DRAW],
  ['loanRepay', REPAY],
  ['loanReserveFund', RESERVE],
  ['loanLiquidate', LIQUIDATE],
  ['loanBadDebt', BAD_DEBT],
  ['businessApprovalHold', APPROVE],
  ['businessApprovalRelease', APPROVE],
  ['businessApprovalSettle', SETTLE],
  ['businessPayroll', PAYROLL],
  ['deposit', DEPOSIT],
  ['withdrawHold', WITHDRAW],
  ['withdrawSettle', WITHDRAW],
  ['withdrawReverse', WITHDRAW],
  ['rewardPay', REWARD],
  ['sweepFeesToRewards', SWEEP],
]) {
  fuzz(BODIES_2, recipe, base);
}

/** Each distinct body's answer for each caller; every recipe must book for svc-bank at least once. */
function recording(recipes, bodies) {
  const answers = [];
  const answerIndex = new Map();
  const cases = [];
  const seen = new Set();
  for (const body of bodies) {
    const text = JSON.stringify(body);
    if (seen.has(text)) continue;
    seen.add(text);
    const said = CALLERS.map((caller) => {
      const a = answer(caller, JSON.parse(text));
      if (!answerIndex.has(a)) answerIndex.set(a, answers.push(a) - 1);
      return answerIndex.get(a);
    });
    cases.push([text, said]);
  }
  for (const recipe of recipes) {
    if (!POST_RECIPE_NAMES.includes(recipe)) throw new Error(`${NAME}: the door does not post ${recipe}`);
    const booked = cases.some(([text, said]) => JSON.parse(text).recipe === recipe && answers[said[0]].startsWith('{"post"'));
    if (!booked) throw new Error(`${NAME}: no body books ${recipe} for svc-bank`);
  }
  const posts = answers.filter((a) => a.startsWith('{"post"')).length;
  // One line each: the recipes, the callers and the distinct answers, then one body a line (`[body, [answer per caller]]`).
  const text = `${[JSON.stringify({ recipes, callers: CALLERS, answers }), ...cases.map((c) => JSON.stringify(c))].join('\n')}\n`;
  return { cases: cases.length, posts, text };
}
const bank = recording(BANK_RECIPES, BODIES);
const bank2 = recording(BANK_RECIPES_2, BODIES_2);

// ── The record's schemas, in the door's tree ───────────────────────────────────────────────────────────────────────

const SCHEMAS = `${CRATE}src/door/schemas.json`;
const tree = JSON.parse(readFileSync(SCHEMAS, 'utf8'));
const canon = (v) => JSON.stringify(v);
const byContent = new Map();
tree.nodes.forEach((n, i) => {
  if (!byContent.has(canon(n))) byContent.set(canon(n), i);
});
/** A part already in the tree with this content, or a new one at its end. */
function place(n) {
  const key = canon(n);
  if (!byContent.has(key)) byContent.set(key, tree.nodes.push(n) - 1);
  return byContent.get(key);
}

function checkOf(c) {
  const d = c._zod.def;
  if (d.when && !(['min_length', 'max_length'].includes(d.check) && d.when.toString().includes('val.length !== undefined'))) {
    throw new Error(`a check with its own when: ${d.check}`);
  }
  if (d.error || d.abort) throw new Error(`a check with its own error or abort: ${d.check}`);
  switch (d.check) {
    case 'min_length':
      return { k: 'min_length', n: d.minimum };
    case 'max_length':
      return { k: 'max_length', n: d.maximum };
    case 'string_format':
      if (d.format === 'regex') return { k: 'regex', src: d.pattern.toString() };
      throw new Error(`string format ${d.format}`);
    case 'greater_than':
      return { k: 'gt', v: d.value, incl: d.inclusive };
    case 'less_than':
      return { k: 'lt', v: d.value, incl: d.inclusive };
    case 'number_format':
      if (d.format !== 'safeint') throw new Error(`number format ${d.format}`);
      return { k: 'int' };
    default:
      // A record is portable: no refine reaches here (`defineProcedure` refuses one).
      throw new Error(`check ${d.check}`);
  }
}

/** One schema as the door's flat parts (`record-door.mjs` `build`, for what a portable record holds). */
function node(s) {
  const d = s._zod.def;
  if (d.error) throw new Error(`a ${d.type} schema with its own error`);
  const self = s._zod.traits.has('$ZodCheck') && d.type === 'string' ? [s] : [];
  const checks = [...self, ...(d.checks ?? [])].map(checkOf);
  const withChecks = (o) => place(checks.length ? { ...o, checks } : o);
  switch (d.type) {
    case 'string':
    case 'number':
    case 'boolean':
      if (d.coerce) throw new Error('a coerced schema');
      return withChecks({ t: d.type });
    case 'unknown':
      return withChecks({ t: 'unknown' });
    case 'enum':
      return withChecks({ t: 'enum', values: s.options });
    case 'literal':
      return withChecks({ t: 'literal', values: d.values });
    case 'object': {
      const shape = Object.entries(d.shape).map(([k, v]) => [k, node(v)]);
      let catchall = null;
      if (d.catchall) {
        const t = d.catchall._zod.def.type;
        if (t === 'never') catchall = 'strict';
        else if (t === 'unknown') catchall = 'passthrough';
        else throw new Error(`catchall ${t}`);
      }
      return withChecks({ t: 'object', shape, ...(catchall ? { catchall } : {}) });
    }
    case 'array':
      return withChecks({ t: 'array', el: node(d.element) });
    case 'optional':
    case 'nullable':
      return withChecks({ t: d.type, in: node(d.innerType) });
    case 'union':
      if (d.discriminator !== undefined) {
        if (d.unionFallback) throw new Error('a discriminated union with a fallback');
        return withChecks({ t: 'dunion', disc: d.discriminator, options: d.options.map(node) });
      }
      if (d.inclusive === false) throw new Error('an exclusive union');
      return withChecks({ t: 'union', options: d.options.map(node) });
    default:
      throw new Error(`schema type ${d.type}`);
  }
}

tree.inputs.postRecipe = node(LEDGER_POST_RECIPE.input);
tree.inputs.postRecipeReply = node(LEDGER_POST_RECIPE.output);
tree.inputs.operatorReverse = node(LEDGER_OPERATOR_REVERSE.input);
tree.inputs.operatorReverseReply = node(LEDGER_OPERATOR_REVERSE.output);

// Drop the parts no input reaches any more, keeping the order of the rest.
const reached = new Set();
const visit = (id) => {
  if (reached.has(id)) return;
  reached.add(id);
  const n = tree.nodes[id];
  for (const [, c] of n.shape ?? []) visit(c);
  for (const c of n.options ?? []) visit(c);
  for (const k of ['el', 'in', 'key']) if (n[k] !== undefined) visit(n[k]);
  if (n.t === 'record' || n.t === 'pipe') {
    if (n.value !== undefined) visit(n.value);
    if (n.out !== undefined) visit(n.out);
  }
};
Object.values(tree.inputs).forEach(visit);
const renumber = new Map();
const nodes = [];
tree.nodes.forEach((n, i) => {
  if (reached.has(i)) renumber.set(i, nodes.push(n) - 1);
});
const re = (id) => renumber.get(id);
const nodesOut = nodes.map((n) => {
  const o = { ...n };
  if (o.shape) o.shape = o.shape.map(([k, c]) => [k, re(c)]);
  if (o.options) o.options = o.options.map(re);
  for (const k of ['el', 'in', 'key']) if (o[k] !== undefined) o[k] = re(o[k]);
  if (o.t === 'record' || o.t === 'pipe') {
    if (o.value !== undefined) o.value = re(o.value);
    if (o.out !== undefined) o.out = re(o.out);
  }
  return o;
});
const inputsOut = Object.fromEntries(Object.entries(tree.inputs).map(([k, id]) => [k, re(id)]));

// ── zod's verdicts on the door's inputs ────────────────────────────────────────────────────────────────────────────

/** `record-door.mjs` `verdict`: `ok <output>` (`ok =` when the output is the input as sent), `issues <zod's issues>`. */
function verdict(schema, text) {
  const input = text === null ? undefined : JSON.parse(text);
  let r;
  try {
    r = schema.safeParse(input);
  } catch (err) {
    return `throws ${err.message}`;
  }
  if (!r.success) return `issues ${JSON.stringify(r.error.issues)}`;
  const out = JSON.stringify(r.data) ?? 'undefined';
  return out === text ? 'ok =' : `ok ${out}`;
}
const PARITY = `${CRATE}tests/fixtures/input-parity.golden.json`;
const parity = JSON.parse(readFileSync(PARITY, 'utf8'));
const SCHEMA_OF = {
  postRecipe: LEDGER_POST_RECIPE.input,
  postRecipeReply: LEDGER_POST_RECIPE.output,
  operatorReverse: LEDGER_OPERATOR_REVERSE.input,
  operatorReverseReply: LEDGER_OPERATOR_REVERSE.output,
};
const parityCases = parity.cases.map(([door, text, i]) => [door, text, SCHEMA_OF[door] ? null : parity.verdicts[i]]);
const known = new Set(parityCases.filter(([door]) => door === 'postRecipe').map(([, text]) => text));
for (const { input } of LEDGER_POST_RECIPE.samples) {
  const text = JSON.stringify(input);
  if (known.has(text)) continue;
  parityCases.push(['postRecipe', text, null]);
  known.add(text);
}
// The operatorReverse door's record: its samples, the edges of each field, and replies the door may and may not give.
const REVERSE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const reverseBase = { originalTxId: REVERSE_ID, ordinal: '1', reason: 'LOCAL TEST', caseRef: 'case-1' };
const replyBase = {
  txId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  idempotencyKey: `ops:reversal:${REVERSE_ID}:1`,
  postedAt: '2026-11-24T00:00:00.000Z',
  reverses: REVERSE_ID,
};
const reverseCases = [
  ...LEDGER_OPERATOR_REVERSE.samples.map(({ input }) => ['operatorReverse', input]),
  ['operatorReverse', null],
  ['operatorReverse', {}],
  ['operatorReverse', { ...reverseBase, ordinal: '12345678901234567890' }],
  ['operatorReverse', { ...reverseBase, ordinal: 1 }],
  ['operatorReverse', { ...reverseBase, reason: 'r'.repeat(500) }],
  ['operatorReverse', { ...reverseBase, reason: 'r'.repeat(501) }],
  ['operatorReverse', { ...reverseBase, caseRef: 'c'.repeat(129) }],
  ['operatorReverse', { ...reverseBase, originalTxId: `${REVERSE_ID}0` }],
  ['operatorReverseReply', replyBase],
  ['operatorReverseReply', { ...replyBase, extra: 1 }],
  ['operatorReverseReply', { ...replyBase, txId: replyBase.txId.toUpperCase() }],
  ['operatorReverseReply', { ...replyBase, idempotencyKey: 'deposit:x:1' }],
];
const knownReverse = new Set(parityCases.filter(([door]) => door.startsWith('operatorReverse')).map(([door, text]) => `${door} ${text}`));
for (const [door, input] of reverseCases) {
  const text = JSON.stringify(input);
  if (knownReverse.has(`${door} ${text}`)) continue;
  parityCases.push([door, text, null]);
  knownReverse.add(`${door} ${text}`);
}
const verdictsOut = [];
const verdictIndex = new Map();
const casesOut = parityCases.map(([door, text, kept]) => {
  const v = kept ?? verdict(SCHEMA_OF[door], text);
  if (!verdictIndex.has(v)) verdictIndex.set(v, verdictsOut.push(v) - 1);
  return [door, text, verdictIndex.get(v)];
});

// ── Writing ────────────────────────────────────────────────────────────────────────────────────────────────────────

const PRETTIER = fileURLToPath(new URL('../../../node_modules/.bin/prettier', import.meta.url));
const pretty = (file, text) => execFileSync(PRETTIER, ['--stdin-filepath', file], { input: text, encoding: 'utf8', maxBuffer: 1 << 28 });
const outputs = [
  [SCHEMAS, pretty(SCHEMAS, `${JSON.stringify({ nodes: nodesOut, inputs: inputsOut })}\n`)],
  [PARITY, pretty(PARITY, `${JSON.stringify({ verdicts: verdictsOut, cases: casesOut })}\n`)],
  [`${CRATE}tests/fixtures/post-recipe-bank.golden.jsonl`, bank.text],
  [`${CRATE}tests/fixtures/post-recipe-bank-2.golden.jsonl`, bank2.text],
];
let stale = 0;
for (const [file, text] of outputs) {
  if (CHECK) {
    let was = '';
    try {
      was = readFileSync(file, 'utf8');
    } catch {}
    if (was !== text) {
      console.error(`stale: ${file.slice(ROOT.length)}`);
      stale++;
    }
  } else writeFileSync(file, text);
}
console.log(
  `${bank.cases} + ${bank2.cases} svc-bank bodies (${bank.posts} + ${bank2.posts} distinct posts) for ${CALLERS.length} callers, ${nodesOut.length} schema parts, ${casesOut.length} input cases`,
);
if (stale) process.exit(1);
