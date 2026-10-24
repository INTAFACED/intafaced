import { test, expect } from '@playwright/test';
import { api, fund, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-wallet-07, in the running app (docs/roadmap/journeys.json): I move money between my own accounts and to another
// user, instantly. One test per step, titled "J-wallet-07 #<n>", run in order on one verified TEST account funded with
// TEST 100 USDT and holding one named space. Balances are read through the person's own bank API. Not here yet: #3-#5
// (W-withdraw-14, a withdrawal to an address on the platform settles internally) need deposit addresses on the stack.
const J = 'J-wallet-07';
const SPACE = 'Savings TEST';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function person() {
  const { who } = run.read();
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

/** The person's bank API through Edge, signed in once: `{ ok, data }` or `{ ok: false, status, code }`. */
async function bankFor(who) {
  const client = await api(who);
  const call = async (method, procedure, input) => {
    const route = `/api/bank/trpc/${procedure}`;
    const { status, body } =
      method === 'query'
        ? await client.get(`${route}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`)
        : await client.post(route, input);
    if (status !== 200) {
      const data = body?.error?.data;
      return { ok: false, status, code: data?.intafacedCode ?? data?.cause?.code ?? data?.code, body };
    }
    return { ok: true, data: body.result.data };
  };
  return {
    call,
    async spaces() {
      const res = await call('query', 'spaces.list', { limit: 50 });
      if (!res.ok) throw new Error(`spaces.list refused: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
      return res.data;
    },
  };
}

const main = (rows) => rows.find((s) => s.kind === 'primary' && s.assetId === 'USDT');
const named = (rows) => rows.find((s) => s.kind === 'named' && s.name === SPACE);
/** Every USDT space of the person added up: the main balance plus the named space. */
const held = (rows) => rows.filter((s) => s.assetId === 'USDT').reduce((sum, s) => sum + toUnits(s.balance), 0n);

/** Opens the move form from main into the space and fills it, up to the review. */
async function reviewMove(page, rows, amount) {
  await page.goto('/bank/transfers');
  await page.getByLabel('From your space').selectOption(main(rows).id);
  await page.getByRole('button', { name: 'Continue' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('To which of your accounts').selectOption(named(rows).id);
  await dialog.getByLabel(/Amount/).fill(amount);
  await dialog.getByRole('button', { name: 'Review' }).click();
  return dialog;
}

test(`${J} #1 moves TEST 20 from the main balance into a space: instant, no fee, in History, and the same id twice is one move`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = await signUp(page, 'w7');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '100').tx).toBeTruthy();
  run.reset({ who });
  const bank = await bankFor(who);
  expect((await bank.call('mutation', 'spaces.create', { assetId: 'USDT', name: SPACE })).ok).toBe(true);
  const before = await bank.spaces();
  expect(named(before)).toBeTruthy();

  await signIn(page, who);
  const sent = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/bank/trpc/transfers.create')) sent.push(req.postDataJSON());
  });
  const dialog = await reviewMove(page, before, '20');
  const answered = page.waitForResponse((res) => res.url().includes('/api/bank/trpc/transfers.create'));
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  const original = (await (await answered).json()).result.data;
  await expect(dialog.getByText(/ledger/i).first()).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(original.amount).toMatch(/^20(\.0+)?$/);

  // Instant and fee-free: exactly 20 left main and exactly 20 reached the space; together they still hold 100.
  const after = await bank.spaces();
  expect(toUnits(main(before).balance) - toUnits(main(after).balance)).toBe(toUnits('20'));
  expect(toUnits(named(after).balance) - toUnits(named(before).balance)).toBe(toUnits('20'));
  expect(held(after)).toBe(toUnits('100'));

  // The same transfer id sent again is the same move: the same ledger entry, and nothing moves twice.
  const first = sent[0];
  const again = await bank.call('mutation', 'transfers.create', first);
  expect(again).toMatchObject({ ok: true, data: { ledgerTxId: original.ledgerTxId } });
  const replayed = await bank.spaces();
  expect(replayed.map((s) => [s.id, s.balance])).toEqual(after.map((s) => [s.id, s.balance]));

  await page.goto('/money/activity');
  const moves = page
    .locator('main tr, main li, main article')
    .filter({ hasText: 'Moved between your accounts' })
    .filter({ hasText: SPACE });
  await expect(moves.first()).toContainText('+20 USDT');
  await expect(moves).toHaveCount(1);
});

test(`${J} #2 tries to move more than is available: refused by name, and nothing moves`, async ({ page }) => {
  const who = person();
  const bank = await bankFor(who);
  const before = await bank.spaces();
  expect(main(before).balance).toMatch(/^80(\.0+)?$/);
  await signIn(page, who);
  const sent = [];
  page.on('request', (req) => req.method() === 'POST' && req.url().includes('/api/bank/trpc/transfers.') && sent.push(req.url()));
  const dialog = await reviewMove(page, before, '81');
  await expect(dialog.getByRole('alert')).toContainText('The amount exceeds the available quantity in this space.');
  await expect(dialog.getByRole('button', { name: 'Confirm' })).toHaveCount(0);
  expect(sent).toEqual([]);

  // The bank refuses it by its code too, when asked directly, and posts nothing.
  const direct = await bank.call('mutation', 'transfers.create', {
    transferId: `jw07-over-${main(before).id}`,
    fromSpaceId: main(before).id,
    toSpaceId: named(before).id,
    amount: '81',
  });
  expect(direct).toMatchObject({ ok: false, status: 400, code: 'bank.insufficient_funds' });
  const after = await bank.spaces();
  expect(after.map((s) => [s.id, s.balance])).toEqual(before.map((s) => [s.id, s.balance]));
  expect(held(after)).toBe(toUnits('100'));
});
