import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const evidence = process.env.BANK_CONTEXT_EVIDENCE;
mkdirSync(evidence, { recursive: true });
const owner = '11111111-1111-4111-8111-111111111111';
const from = '22222222-2222-4222-8222-222222222222';
const to = '33333333-3333-4333-8333-333333333333';
const loanId = '44444444-4444-4444-8444-444444444444';
const exact = '0.000000000000000001';
const journalKey = 'intafaced.customer.bank-unconfirmed.v1:' + owner;
const summaries = [];
const errors = new WeakMap();
const states = new WeakMap();
test.beforeEach(({ page }) => {
  const list = [];
  errors.set(page, list);
  page.on('pageerror', () => list.push(true));
});
test.afterEach(({ page }, info) => {
  expect(errors.get(page).length).toBe(0);
  expect(states.get(page)?.unexpected ?? 0).toBe(0);
  summaries.push({
    name: info.title,
    status: info.status,
    pageErrors: errors.get(page).length,
    unexpectedPosts: states.get(page)?.unexpected ?? 0,
    postCount: states.get(page)?.posts.length ?? 0,
  });
});
test.afterAll(() => writeFileSync(evidence + '/native-summary.json', JSON.stringify(summaries, null, 2)));
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
const unavailable = (route) => route.fulfill({ status: 503, json: { error: { message: 'Isolated unavailable' } } });
const originalLoan = {
  id: loanId,
  productId: '55555555-5555-4555-8555-555555555555',
  debtAssetId: 'USDC',
  collateralAssetId: 'BTC',
  principal: '5000',
  outstandingPrincipal: '5000',
  outstandingInterest: '12.5',
  collateral: '0.2',
  aprBps: 500,
  status: 'active',
  marginCalledAt: null,
};
async function setup(page, options = {}) {
  const state = { posts: [], reads: 0, unexpected: 0, actor: owner, loan: structuredClone(originalLoan), journalAtDispatch: null };
  states.set(page, state);
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      procedure = new URL(request.url()).pathname.split('/').at(-1);
    if (procedure === 'auth.login')
      return reply(route, {
        userId: state.actor,
        accessToken: 'isolated-bank-native',
        refreshToken: 'isolated-bank-refresh',
        expiresAt: '2027-10-09T00:00:00Z',
      });
    if (procedure === 'auth.logout') return reply(route, { ok: true });
    if (procedure === 'spaces.unnamed') return reply(route, []);
    if (procedure === 'spaces.list')
      return reply(
        route,
        [from, to].map((id) => ({
          id,
          assetId: 'USDC',
          kind: id === from ? 'primary' : 'named',
          name: id === from ? 'Main' : 'Reserve',
          goalTarget: null,
          lockedUntil: null,
          balance: '9999999999999999999.000000000000000001',
          ledgerAccount: { ownerType: 'user', ownerId: state.actor, assetId: 'USDC', kind: 'available' },
        })),
      );
    if (procedure === 'loans.list') {
      state.reads++;
      if (options.loanRead) return options.loanRead(route, state);
      return reply(route, [state.loan]);
    }
    if (procedure === 'loans.health')
      return reply(route, {
        debtValue: '5012.5',
        collateralValue: '10000',
        portfolioLtvBps: 5013,
        loans: [{ loanId, debtValue: '5012.5', collateralValue: '10000', ltvBps: 5013 }],
      });
    if (procedure === 'loans.products' || procedure === 'transfers.listSchedules') return reply(route, []);
    if (request.method() === 'POST' && ['transfers.create', 'loans.repay', 'spaces.archive'].includes(procedure)) {
      const body = request.postDataJSON();
      state.posts.push({ procedure, body });
      state.journalAtDispatch = await page.evaluate((key) => localStorage.getItem(key), journalKey);
      if (options.post) return options.post(route, state);
      return reply(
        route,
        procedure === 'spaces.archive'
          ? { archived: true }
          : procedure === 'transfers.create'
            ? { ledgerTxId: 'isolated-original-ledger', amount: body.amount }
            : {
                ledgerTxId: 'isolated-original-repayment',
                interestPaid: body.amount,
                principalPaid: '0',
                remainingPrincipal: '5000',
                remainingInterest: '12.4',
                closed: false,
              },
      );
    }
    if (request.method() === 'POST') state.unexpected++;
    return unavailable(route);
  });
  const path = options.spaces ? '/bank/spaces' : options.loan ? '/bank/loans' : '/bank/transfers?from=' + from;
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.getByLabel('Email or handle', { exact: true }).fill('bank@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('isolated-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: options.spaces ? 'Spaces' : options.loan ? 'Loans' : 'Transfers', exact: true }),
  ).toBeVisible();
  await expect(
    options.spaces
      ? page.getByRole('button', { name: 'Archive label', exact: true })
      : options.loan
        ? page.locator('[data-loan-id]')
        : page.getByRole('button', { name: 'Continue', exact: true }),
  ).toBeVisible();
  return state;
}
async function form(page, value = exact) {
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Destination space ID', { exact: true }).fill(to);
  await page.getByLabel('Amount (USDC)', { exact: true }).fill(value);
}
async function review(page, value = exact) {
  await form(page, value);
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
}
async function loanReview(page) {
  await page.locator('[data-loan-id]').getByRole('button', { name: 'Repay', exact: true }).click();
  await page.getByLabel('Amount (USDC)', { exact: true }).fill(exact);
  await page.getByRole('button', { name: 'Review', exact: true }).click();
}
const journal = (page) => page.evaluate((key) => localStorage.getItem(key), journalKey);
async function aba(page, kind = 'query', retained = 'confirm') {
  return page.evaluate(
    ({ kind, retained }) => {
      const props = (node) => node?.[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
      const buttons = [...document.querySelectorAll('button')];
      const old =
        retained === 'archive'
          ? buttons.find((button) => button.closest('dialog') && button.textContent.trim() === 'Archive label')
          : retained === 'close'
            ? document.querySelector('dialog header button')
            : buttons.find(
                (button) =>
                  button.textContent.trim() === { confirm: 'Confirm', open: 'Continue', review: 'Review', edit: 'Edit' }[retained],
              );
      const handler = props(old)?.onClick;
      const oldForm = document.querySelector('dialog form');
      const oldSubmit = props(oldForm)?.onSubmit;
      const fields = [...document.querySelectorAll('dialog input')];
      const original = location.href,
        next = new URL(original);
      if (kind === 'query' || kind === 'mixed') next.searchParams.set('from', 'different-source');
      if (kind === 'hash' || kind === 'mixed') next.hash = 'different-context';
      history.replaceState(null, '', kind === 'same' ? original : next.href);
      dispatchEvent(kind === 'hash' ? new HashChangeEvent('hashchange') : new PopStateEvent('popstate'));
      if (kind !== 'same') {
        history.replaceState(null, '', original);
        dispatchEvent(kind === 'hash' || kind === 'mixed' ? new HashChangeEvent('hashchange') : new PopStateEvent('popstate'));
      }
      const privateDiscarded = !document.querySelector('dialog[open]') && fields.every((field) => field.value === '');
      old?.click();
      handler?.({ preventDefault() {} });
      oldForm?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      oldSubmit?.({ preventDefault() {} });
      return { privateDiscarded };
    },
    { kind, retained },
  );
}

test('observed query departure and return removes private review before retained Confirm can dispatch', async ({ page }) => {
  const state = await setup(page);
  await review(page);
  expect((await aba(page)).privateDiscarded).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.posts.length).toBe(0);
  expect(await journal(page)).toBe(null);
  await review(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Confirmed by the service');
  expect(state.posts.length).toBe(1);
  expect(state.unexpected).toBe(0);
});
test('same full URL events retain valid review and exactly one original decimal dispatch', async ({ page }) => {
  const state = await setup(page);
  await review(page);
  await aba(page, 'same');
  await expect(page.getByRole('dialog')).toContainText('Confirmed by the service');
  expect(state.posts.length).toBe(1);
  expect(state.posts[0].body.amount === exact).toBe(true);
  // This is the mounted Transfer factory's nonempty private initial value.
  // It is not a rendered field: replay must retain its original wire source.
  expect(state.posts[0].body.fromSpaceId === from).toBe(true);
  expect(await journal(page)).toBe('[]');
  expect(state.unexpected).toBe(0);
});

async function archiveReview(page) {
  await page.getByRole('button', { name: 'Archive label', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Archive label', exact: true })).toBeVisible();
  await expect(dialog).toContainText('Reserve');
  await expect(dialog.locator('form')).toHaveCount(0);
}
test('fieldless Archive label initializes a legitimate review and confirms exactly one original request', async ({ page }) => {
  const state = await setup(page, { spaces: true });
  await archiveReview(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Archive label', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Confirmed by the service');
  expect(state.posts.length).toBe(1);
  expect(state.posts[0].procedure === 'spaces.archive').toBe(true);
  expect(Object.keys(state.posts[0].body)).toEqual(['spaceId']);
  expect(state.posts[0].body.spaceId === to).toBe(true);
  expect(JSON.parse(await journal(page))).toEqual([]);
});
test('fieldless Archive label discards observed ABA and retained Confirm after mount, then admits a fresh review', async ({ page }) => {
  const state = await setup(page, { spaces: true });
  await archiveReview(page);
  expect((await aba(page, 'mixed', 'archive')).privateDiscarded).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.posts.length).toBe(0);
  expect(await journal(page)).toBe(null);
  await archiveReview(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Archive label', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Confirmed by the service');
  expect(state.posts.length).toBe(1);
  expect(JSON.parse(await journal(page))).toEqual([]);
});
test('fieldless Archive label keeps an original unknown guarded through current reads', async ({ page }) => {
  const state = await setup(page, { spaces: true, post: unavailable });
  await archiveReview(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Archive label', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('may have completed');
  const original = await journal(page),
    record = JSON.parse(original);
  expect(record.length).toBe(1);
  expect(record[0].procedure === 'spaces.archive').toBe(true);
  expect(Object.keys(record[0]).sort()).toEqual(['procedure', 'recordRefs', 'reference', 'title']);
  await page.getByRole('button', { name: 'Refresh original records', exact: true }).click();
  expect((await journal(page)) === original).toBe(true);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Archive label', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.posts.length).toBe(1);
  expect((await journal(page)) === original).toBe(true);
});
test('fieldless Archive label late known reply after departure preserves original unknown journal bytes', async ({ page }) => {
  let release;
  const state = await setup(page, {
    spaces: true,
    post: async (route) => {
      await new Promise((resolve) => (release = resolve));
      return reply(route, { archived: true });
    },
  });
  await archiveReview(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Archive label', exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  const original = await journal(page);
  expect(JSON.parse(original).length).toBe(1);
  await aba(page, 'mixed', 'archive');
  release();
  await expect.poll(async () => (await page.evaluate(() => navigator.locks.query())).held.length).toBe(0);
  expect((await journal(page)) === original).toBe(true);
  await expect(page.getByText('Confirmed by the service', { exact: true })).toHaveCount(0);
  expect(state.posts.length).toBe(1);
});
for (const kind of ['hash', 'mixed'])
  test('observed ' + kind + ' ABA discards review and admits fresh current review', async ({ page }) => {
    const state = await setup(page);
    await review(page);
    expect((await aba(page, kind)).privateDiscarded).toBe(true);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(state.posts.length).toBe(0);
    await review(page);
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Confirmed by the service');
    expect(state.posts.length).toBe(1);
  });
for (const retained of ['open', 'review', 'edit', 'close'])
  test('retained ' + retained + ' and direct form handlers cannot revive departed action', async ({ page }) => {
    const state = await setup(page);
    if (retained === 'review') await form(page);
    else if (retained !== 'open') await review(page);
    expect((await aba(page, 'mixed', retained)).privateDiscarded).toBe(true);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(state.posts.length).toBe(0);
    expect(await journal(page)).toBe(null);
    await form(page);
    await expect(page.getByLabel('Amount (USDC)', { exact: true })).toHaveValue(exact);
  });

test('held native Bank lock cannot journal or dispatch a departed review', async ({ page }) => {
  const state = await setup(page);
  await review(page);
  await page.evaluate(async (owner) => {
    let acquired;
    const ready = new Promise((resolve) => (acquired = resolve));
    navigator.locks.request('bank-write:' + owner, async () => {
      acquired();
      await new Promise((resolve) => (window.releaseBankLock = resolve));
    });
    await ready;
    const native = navigator.locks.request.bind(navigator.locks);
    navigator.locks.request = (name, options, callback) => native(name, callback);
  }, owner);
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Waiting for the authoritative outcome');
  await aba(page, 'mixed');
  await page.evaluate(() => window.releaseBankLock());
  await expect.poll(async () => (await page.evaluate(() => navigator.locks.query())).pending.length).toBe(0);
  expect(state.posts.length).toBe(0);
  expect(await journal(page)).toBe(null);
  await review(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Confirmed by the service');
  expect(state.posts.length).toBe(1);
});
test('held loan preflight cannot dispatch after departure or clear a fresh action', async ({ page }) => {
  let release,
    holdPreflight = false;
  const state = await setup(page, {
    loan: true,
    loanRead: async (route, state) => {
      if (holdPreflight) {
        holdPreflight = false;
        await new Promise((resolve) => (release = resolve));
      }
      return reply(route, [state.loan]);
    },
  });
  await loanReview(page);
  holdPreflight = true;
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await aba(page, 'mixed');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await loanReview(page);
  release();
  await expect.poll(async () => (await page.evaluate(() => navigator.locks.query())).held.length).toBe(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Confirmed by the service');
  expect(state.posts.length).toBe(1);
  expect(await journal(page)).toBe('[]');
});

test('actual response text parser held beyond departure cannot clear or publish a known original reply', async ({ page }) => {
  await page.addInitScript(() => {
    const native = fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await native(...args);
      if (String(args[0]).includes('/bank/trpc/transfers.create')) {
        const text = response.text.bind(response);
        response.text = async () => {
          const bytes = await text();
          window.bankParserHeld = true;
          await new Promise((resolve) => (window.releaseBankParser = resolve));
          return bytes;
        };
      }
      return response;
    };
  });
  const state = await setup(page);
  await review(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.bankParserHeld))).toBe(true);
  const original = await journal(page);
  await aba(page, 'mixed');
  await page.evaluate(() => window.releaseBankParser());
  await expect.poll(async () => (await page.evaluate(() => navigator.locks.query())).held.length).toBe(0);
  expect((await journal(page)) === original).toBe(true);
  await expect(page.getByText('Confirmed by the service', { exact: true })).toHaveCount(0);
  expect(state.posts.length).toBe(1);
});

for (const actor of ['same owner', 'other owner'])
  test('new native sign-in as ' + actor + ' cannot establish departed original receipt', async ({ page }) => {
    let release;
    const state = await setup(page, {
      post: async (route, state) => {
        await new Promise((resolve) => (release = resolve));
        return reply(route, { ledgerTxId: 'isolated-original-ledger', amount: state.posts[0].body.amount });
      },
    });
    await review(page);
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    const original = await journal(page);
    await aba(page, 'mixed');
    await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
    await page
      .getByRole('heading', { name: 'Sign in to continue', exact: true })
      .locator('..')
      .getByRole('link', { name: 'Sign in', exact: true })
      .click();
    if (actor === 'other owner') state.actor = '66666666-6666-4666-8666-666666666666';
    await page.getByLabel('Email or handle', { exact: true }).fill('bank@example.invalid');
    await page.getByLabel('Password', { exact: true }).fill('isolated-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Transfers', exact: true })).toBeVisible();
    release();
    await expect.poll(async () => (await page.evaluate(() => navigator.locks.query())).held.length).toBe(0);
    expect((await journal(page)) === original).toBe(true);
    await expect(page.getByText('Confirmed by the service', { exact: true })).toHaveCount(0);
    expect(state.posts.length).toBe(1);
  });

test('unobserved current full URL mismatch blocks a retained Confirm before dispatch', async ({ page }) => {
  const state = await setup(page);
  await review(page);
  await page.evaluate(() => {
    const confirm = [...document.querySelectorAll('dialog button')].find((button) => button.textContent.trim() === 'Confirm');
    const props = confirm[Object.keys(confirm).find((key) => key.startsWith('__reactProps$'))];
    const next = new URL(location.href);
    next.hash = 'changed-without-event';
    history.replaceState(null, '', next.href);
    confirm.click();
    props.onClick();
  });
  expect(state.posts.length).toBe(0);
  expect(await journal(page)).toBe(null);
});
for (const outcome of ['known', 'unknown', 'malformed', 'refusal'])
  test('departed dispatched ' + outcome + ' reply preserves original minimal journal bytes', async ({ page }) => {
    let release,
      returned = false;
    const state = await setup(page, {
      post: async (route, state) => {
        await new Promise((resolve) => (release = resolve));
        if (outcome === 'known') await reply(route, { ledgerTxId: 'isolated-original-ledger', amount: state.posts[0].body.amount });
        else if (outcome === 'malformed') await reply(route, { ledgerTxId: 'isolated-original-ledger', amount: '2' });
        else await route.fulfill({ status: outcome === 'refusal' ? 403 : 503, json: { error: { message: 'Isolated response' } } });
        returned = true;
      },
    });
    await review(page);
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    const original = await journal(page);
    expect(Boolean(original)).toBe(true);
    expect(state.journalAtDispatch === original).toBe(true);
    const marker = JSON.parse(original)[0];
    expect(Object.keys(marker).sort()).toEqual(['procedure', 'recordRefs', 'reference', 'title']);
    expect(marker.recordRefs.transferId === state.posts[0].body.transferId).toBe(true);
    expect(original.includes(exact) || original.includes('isolated-bank-native')).toBe(false);
    await aba(page, 'mixed');
    release();
    await expect.poll(() => returned).toBe(true);
    // Allow the real response.text()/Zod parser and lock callback to finish.
    await expect.poll(async () => (await page.evaluate(() => navigator.locks.query())).held.length).toBe(0);
    expect((await journal(page)) === original).toBe(true);
    await expect(page.getByText('Confirmed by the service', { exact: true })).toHaveCount(0);
    await expect(page.locator('#bank-unconfirmed')).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(state.posts.length).toBe(1);
  });

test('ordinary unknown and older original records remain guarded after current reads', async ({ page }) => {
  const state = await setup(page, { post: unavailable });
  await review(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('may have completed');
  const original = await journal(page);
  await page.getByRole('button', { name: 'Refresh original records', exact: true }).click();
  expect((await journal(page)) === original).toBe(true);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.posts.length).toBe(1);
});
test('ordinary known receipt can close and new exact review uses a new original reference', async ({ page }) => {
  const state = await setup(page);
  for (const value of [exact, '9999999999999999999.000000000000000001']) {
    await review(page, value);
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Confirmed by the service');
    expect(await journal(page)).toBe('[]');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
  }
  expect(state.posts.length).toBe(2);
  expect(state.posts[0].body.transferId !== state.posts[1].body.transferId).toBe(true);
  expect(state.posts[0].body.amount === exact).toBe(true);
  expect(state.posts[1].body.amount === '9999999999999999999.000000000000000001').toBe(true);
});

test('retained known receipt close cannot close a fresh opened action', async ({ page }) => {
  const state = await setup(page);
  await review(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Confirmed by the service');
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('dialog button')].find((node) => node.textContent.trim() === 'Close');
    const props = button[Object.keys(button).find((key) => key.startsWith('__reactProps$'))];
    window.retainedBankClose = props.onClick;
  });
  await aba(page, 'mixed');
  await form(page);
  await page.evaluate(() => window.retainedBankClose());
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Amount (USDC)', { exact: true })).toHaveValue(exact);
  expect(state.posts.length).toBe(1);
});

test('an older original inserted after review still blocks journaling and POST without changing its bytes', async ({ page }) => {
  const state = await setup(page);
  await review(page);
  const older = JSON.stringify([
    {
      reference: '77777777-7777-4777-8777-777777777777',
      title: 'Transfer',
      procedure: 'transfers.create',
      recordRefs: { transferId: '88888888-8888-4888-8888-888888888888', fromSpaceId: from, toSpaceId: to },
    },
  ]);
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: journalKey, value: older });
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('still requires recovery');
  expect((await journal(page)) === older).toBe(true);
  expect(state.posts.length).toBe(0);
});

test('unavailable recovery storage refuses before POST and current edit can recover once storage returns', async ({ page }) => {
  const state = await setup(page);
  await review(page);
  await page.evaluate((key) => {
    const set = Storage.prototype.setItem;
    window.restoreBankStorage = () => (Storage.prototype.setItem = set);
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Isolated unavailable storage', 'SecurityError');
      return set.call(this, name, value);
    };
  }, journalKey);
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('No Bank request was sent.');
  expect(state.posts.length).toBe(0);
  expect(await journal(page)).toBe(null);
  await page.evaluate(() => window.restoreBankStorage());
  await page.getByRole('button', { name: 'Edit request', exact: true }).click();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Confirmed by the service');
  expect(state.posts.length).toBe(1);
  expect(await journal(page)).toBe('[]');
});

test('native changed loan preflight still refuses before journal and recovers through a fresh read', async ({ page }) => {
  const state = await setup(page, { loan: true });
  await loanReview(page);
  state.loan.outstandingInterest = '13';
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('No request was sent.');
  expect(await journal(page)).toBe(null);
  expect(state.posts.length).toBe(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh loans and health', exact: true }).click();
  await expect(page.locator('[data-loan-id]')).toContainText('13 USDC');
  await loanReview(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Confirmed by the service');
  expect(state.posts.length).toBe(1);
});
for (const width of [1440, 390, 320])
  test('current review and departure recovery fit native viewport ' + width, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await setup(page);
    await review(page);
    expect(
      await page.getByRole('dialog').evaluate((dialog) => {
        const r = dialog.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.height <= innerHeight && document.documentElement.scrollWidth <= innerWidth;
      }),
    ).toBe(true);
    await aba(page, 'mixed');
    await form(page);
    await expect(page.getByLabel('Destination space ID', { exact: true })).toHaveValue(to);
    expect(state.posts.length).toBe(0);
  });
