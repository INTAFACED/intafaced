import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Playwright fixtures exercise the public feature/session and network seams only.
// No test application, fixture route or production sample dataset is exposed.
const userId = '11111111-1111-4111-8111-111111111111';
const spaceId = '22222222-2222-4222-8222-222222222222';
const merchantId = '33333333-3333-4333-8333-333333333333';
const orderId = '44444444-4444-4444-8444-444444444444';
const source = {
  id: spaceId,
  assetId: 'USDT',
  kind: 'primary',
  name: 'Main',
  goalTarget: null,
  lockedUntil: null,
  balance: '4.000000000000000001',
  ledgerAccount: { ownerType: 'user', ownerId: userId, assetId: 'USDT', kind: 'bank:primary' },
};
const session = {
  accessToken: 'test-only-in-memory',
  refreshToken: 'test-only-in-memory-refresh',
  expiresAt: '2027-10-07T12:00:00Z',
  userId,
};
const authority = {
  verified: true,
  companyId: 'fixture-company',
  companyName: 'Company test fixture',
  userId,
  merchantId,
  scopes: ['pay:read', 'pay:write', 'pay:refund', 'pay:payout'],
};
const merchant = {
  id: merchantId,
  userId,
  mode: 'gateway',
  status: 'active',
  kybStatus: 'approved',
  kybRef: 'test-reference',
  feeBps: null,
};
const reply = (route, data, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ result: { data } }) });

async function mount(page, path, business = null, signedIn = true) {
  await page.goto('/');
  await page.evaluate(
    async ({ path, business, session, signedIn }) => {
      const React = (await import('/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
      const { SessionProvider, useSession } = await import('/src/features/session/session.tsx');
      const { PayRoutes, PayBusinessProvider } = await import('/src/features/pay/PayRoutes.tsx');
      window.history.replaceState(null, '', path);
      const host = document.createElement('main');
      document.body.replaceChildren(host);
      function Setup() {
        const context = useSession();
        React.useEffect(() => {
          if (signedIn) context.commit(session);
        }, []);
        return React.createElement(PayBusinessProvider, { authority: business }, React.createElement(PayRoutes, { path }));
      }
      createRoot(host).render(React.createElement(SessionProvider, null, React.createElement(Setup)));
    },
    { path, business, session, signedIn },
  );
}

for (const readState of ['loading', 'failed', 'empty']) {
  test(`Original transfer recovery survives ${readState} source reads`, async ({ page }) => {
    const originalId = 'original-transfer-before-source-failure';
    await page.addInitScript(
      ({ userId, originalId }) => {
        sessionStorage.setItem(`pay.unresolved:${userId}:send`, JSON.stringify({ status: 'uncertain', reference: originalId }));
      },
      { userId, originalId },
    );
    const writes = [];
    await page.route('**/api/**', (route) => {
      if (route.request().url().includes('spaces.list')) {
        if (readState === 'loading') return;
        return reply(route, readState === 'empty' ? [] : null, readState === 'failed' ? 503 : 200);
      }
      writes.push(route.request().url());
      return reply(route, null, 503);
    });
    await mount(page, '/pay/send?asset=BTC');
    await expect(page.getByRole('heading', { name: 'Sending BTC', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /Back to BTC holding/ })).toHaveAttribute('href', '/portfolio/BTC');
    const recovery = page.getByRole('region', { name: 'Original transfer is unresolved' });
    await expect(recovery.getByText(originalId, { exact: true })).toBeVisible();
    await expect(recovery.getByRole('link', { name: 'Contact Support' })).toHaveAttribute('href', '/support');
    await expect(recovery.getByRole('link', { name: 'Check Money activity' })).toHaveAttribute('href', '/uc/record');
    if (readState === 'failed') await expect(page.getByRole('heading', { name: 'Can’t connect right now' })).toBeVisible();
    if (readState === 'empty')
      await expect(page.getByRole('heading', { name: 'No BTC source account available', exact: true })).toBeVisible();
    expect(writes).toEqual([]);
  });
}

test('Personal Pay hides merchant rooms and direct Business refuses without company authority', async ({ page }) => {
  const requests = [];
  await page.route('**/api/**', (route) => {
    requests.push(route.request().url());
    return reply(route, null);
  });
  await mount(page, '/pay');
  await expect(page.getByRole('heading', { name: 'Pay', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /merchant|settlement|permission/i })).toHaveCount(0);
  await mount(page, '/pay/links');
  await expect(page.getByRole('heading', { name: 'Access is restricted' })).toBeVisible();
  await expect(page.getByText(/verified Business account and company membership/)).toBeVisible();
  expect(requests).toEqual([]);
});

test('Send reviews exact units, posts once, and a lost response survives navigation', async ({ page }) => {
  const posted = [];
  await page.route('**/api/**', async (route) => {
    if (route.request().url().includes('spaces.list')) return reply(route, [source]);
    posted.push(route.request().postDataJSON());
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Rail outcome unknown' } }),
    });
  });
  await mount(page, '/pay/send');
  await page.getByLabel('Source account').selectOption(spaceId);
  await page.getByLabel('Recipient account ID').fill(merchantId);
  await page.getByLabel('Amount · USDT', { exact: true }).fill('0.000000000000000001');
  await page.getByRole('button', { name: 'Review transfer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review transfer' });
  await expect(dialog.getByText('0.000000000000000001 USDT', { exact: true })).toBeVisible();
  expect(posted).toEqual([]);
  await dialog.getByRole('button', { name: 'Confirm transfer' }).click();
  await expect(dialog.getByRole('heading', { name: 'Outcome not confirmed' })).toBeVisible();
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ amount: '0.000000000000000001', fromSpaceId: spaceId, toUserId: merchantId });
  await mount(page, '/pay/send');
  await expect(page.getByRole('heading', { name: 'Original transfer is unresolved' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review transfer' })).toBeDisabled();
  const recovery = page.getByRole('region', { name: 'Original transfer is unresolved' });
  await expect(recovery.getByText(posted[0].transferId, { exact: true })).toBeVisible();
  await expect(recovery.getByRole('link', { name: 'Contact Support' })).toHaveAttribute('href', '/support');
  await expect(recovery.getByRole('link', { name: 'Check Money activity' })).toHaveAttribute('href', '/uc/record');
  const recoveryY = await recovery.evaluate((node) => node.getBoundingClientRect().top);
  const entryY = await page.getByLabel('Source account').evaluate((node) => node.getBoundingClientRect().top);
  expect(recoveryY).toBeLessThan(entryY);
  if (process.env.PAY_JOURNEY_SCREENSHOTS) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${process.env.PAY_JOURNEY_SCREENSHOTS}/journey-2-original-transfer-recovery.png`, fullPage: true });
  }
  expect(posted).toHaveLength(1);
});

test('Transfer review supports exact-value inspection and editing, and a receipt keeps its original asset', async ({ page }) => {
  const posted = [];
  const second = {
    ...source,
    id: orderId,
    assetId: 'BTC',
    name: 'Bitcoin source',
    ledgerAccount: { ...source.ledgerAccount, assetId: 'BTC' },
  };
  await page.route('**/api/**', (route) => {
    if (route.request().url().includes('spaces.list')) return reply(route, [source, second]);
    const input = route.request().postDataJSON();
    posted.push(input);
    return reply(route, { ledgerTxId: 'confirmed-test-transfer', amount: input.amount });
  });
  await mount(page, '/pay/send');
  await page.getByLabel('Source account').selectOption(spaceId);
  await page.getByLabel('Recipient account ID').fill(merchantId);
  await page.getByLabel('Amount · USDT', { exact: true }).fill('0.000000000000000001');
  await page.getByRole('button', { name: 'Review transfer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review transfer' });
  const value = dialog.getByRole('group', { name: 'You send' });
  await expect(value.getByText('0.000000000000000001 USDT', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Main · USDT', { exact: true })).toBeVisible();
  await expect(dialog.getByText(merchantId, { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Confirm this account ID with your recipient/)).toBeVisible();
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const fit = await dialog.evaluate((node) => ({
      viewport: innerWidth,
      left: node.getBoundingClientRect().left,
      right: node.getBoundingClientRect().right,
      scroll: node.scrollWidth,
      client: node.clientWidth,
    }));
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.right).toBeLessThanOrEqual(fit.viewport);
    expect(fit.scroll).toBeLessThanOrEqual(fit.client);
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(audit.violations.filter((item) => ['serious', 'critical'].includes(item.impact))).toEqual([]);
    for (const name of ['Edit transfer', 'Confirm transfer']) {
      const button = dialog.getByRole('button', { name });
      const bounds = await button.boundingBox();
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
    await dialog.evaluate((node) => {
      node.scrollTop = 0;
    });
    const confirm = dialog.getByRole('button', { name: 'Confirm transfer' });
    await dialog.getByRole('button', { name: 'Edit transfer' }).focus();
    await page.keyboard.press('Tab');
    await expect(confirm).toBeFocused();
    const confirmBounds = await confirm.boundingBox();
    expect(confirmBounds.y).toBeGreaterThanOrEqual(0);
    expect(confirmBounds.y + confirmBounds.height).toBeLessThanOrEqual(844);
    expect(
      await confirm.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('button') === element;
      }),
    ).toBe(true);
    if (process.env.PAY_JOURNEY_SCREENSHOTS) {
      await dialog.evaluate((node) => {
        node.scrollTop = 0;
      });
      await page.screenshot({ path: `${process.env.PAY_JOURNEY_SCREENSHOTS}/journey-2-review-${width}.png` });
    }
  }
  await dialog.getByRole('button', { name: 'Edit transfer' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review transfer' })).toBeFocused();
  await expect(page.getByLabel('Amount · USDT', { exact: true })).toHaveValue('0.000000000000000001');
  expect(posted).toEqual([]);
  await page.getByRole('button', { name: 'Review transfer' }).click();
  await dialog.getByRole('button', { name: 'Confirm transfer' }).click();
  await expect(page.getByText('confirmed-test-transfer', { exact: true })).toBeVisible();
  expect(posted).toHaveLength(1);
  await page.getByLabel('Source account').selectOption(orderId);
  await expect(page.getByText('0.000000000000000001 USDT', { exact: true })).toBeVisible();
  await expect(page.getByText('0.000000000000000001 BTC', { exact: true })).toHaveCount(0);
  expect(posted).toHaveLength(1);
});

test('A confirmed transfer receipt survives failed source refresh and subsequent recovery', async ({ page }) => {
  let reads = 0;
  let allowRefresh = false;
  const posted = [];
  await page.route('**/api/**', (route) => {
    if (route.request().url().includes('spaces.list')) {
      reads++;
      return reads <= 2 || allowRefresh ? reply(route, [source]) : reply(route, null, 503);
    }
    const input = route.request().postDataJSON();
    posted.push(input);
    return reply(route, { ledgerTxId: 'confirmed-before-refresh', amount: input.amount });
  });
  await mount(page, '/pay/send');
  const outcome = page.getByRole('status', { name: 'Transfer result' });
  await expect(outcome).toBeEmpty();
  await page.getByLabel('Source account').selectOption(spaceId);
  await page.getByLabel('Recipient account ID').fill(merchantId);
  await page.getByLabel('Amount · USDT', { exact: true }).fill('1.000000000000000001');
  await page.getByRole('button', { name: 'Review transfer' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm transfer' }).click();
  await expect(page.getByRole('heading', { name: 'Transfer confirmed' })).toBeVisible();
  await expect(page.getByText('confirmed-before-refresh', { exact: true })).toBeVisible();
  await expect(outcome.getByText('confirmed-before-refresh', { exact: true })).toBeVisible();
  await expect(outcome).toHaveAttribute('aria-live', 'polite');
  await expect(outcome).toHaveAttribute('aria-atomic', 'true');
  await expect(page.getByText('1.000000000000000001 USDT', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Can’t connect right now' })).toBeVisible();
  expect(reads).toBe(3);
  expect(posted).toHaveLength(1);
  allowRefresh = true;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByLabel('Source account')).toBeVisible();
  await expect(outcome.getByText('confirmed-before-refresh', { exact: true })).toBeVisible();
  await expect(page.getByText('confirmed-before-refresh', { exact: true })).toBeVisible();
  await expect(page.getByText('1.000000000000000001 USDT', { exact: true })).toBeVisible();
  expect(posted).toHaveLength(1);
});

test('P2P keeps release behind seller-confirmed external payment and runs the order chat', async ({ page }) => {
  const trade = {
    id: orderId,
    offerId: spaceId,
    sellerId: userId,
    buyerId: merchantId,
    asset: 'USDT',
    amount: '2',
    fiatCurrency: 'USD',
    fiatAmount: '2.1',
    price: '1.05',
    method: 'operator-method',
    status: 'escrowed',
    resolution: null,
    deadlineAt: null,
    createdAt: '2026-10-07T12:00:00Z',
    escrowedAt: '2026-10-07T12:00:00Z',
    resolvedAt: null,
    settledAt: null,
  };
  const stored = [
    {
      id: '55555555-5555-4555-8555-555555555551',
      tradeId: orderId,
      senderId: merchantId,
      clientId: 'their-1',
      text: 'I have sent the payment',
      createdAt: '2026-10-07T12:01:00Z',
    },
  ];
  const sends = [];
  const seen = { list: 0, unread: 0 };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('trades.get')) return reply(route, trade);
    if (url.includes('chat.unread')) {
      seen.unread += 1;
      return reply(route, { tradeId: orderId, unread: 1 });
    }
    if (url.includes('chat.messages.list')) {
      seen.list += 1;
      return reply(route, { messages: stored, nextCursor: null, unread: 1 });
    }
    if (url.includes('chat.messages.send')) {
      const body = route.request().postDataJSON();
      sends.push(body);
      const message = {
        id: '55555555-5555-4555-8555-55555555555' + (sends.length + 1),
        tradeId: orderId,
        senderId: userId,
        clientId: body.clientId,
        text: body.text,
        createdAt: '2026-10-07T12:02:00Z',
      };
      stored.push(message);
      return reply(route, { ...message, created: true, notify: { delivered: false, code: 'p2p.chat_notify_unwired' } });
    }
    if (url.includes('contacts.list')) return reply(route, { following: [], blocking: [] });
    return reply(route, null, 404);
  });
  await mount(page, `/chat?tradeId=${orderId}`);
  await expect(page.getByRole('heading', { name: 'Where this order is' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Release escrow' })).toHaveCount(0);
  await expect.poll(() => seen.unread).toBeGreaterThan(0);
  // Off screen, the thread is not read, so nothing is marked read that nobody has seen.
  expect(seen.list).toBe(0);
  await page.getByRole('heading', { name: 'Order chat' }).scrollIntoViewIfNeeded();
  await expect(page.getByText('I have sent the payment')).toBeVisible();
  expect(seen.list).toBeGreaterThan(0);
  await expect(page.getByText('New messages (1)')).toBeVisible();
  await expect(page.getByTestId('chat-seller-warning')).toBeVisible();
  await page.getByRole('button', { name: 'Please send the payment proof in chat' }).click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Please send the payment proof in chat');
  await page.getByRole('textbox', { name: 'Message' }).fill('');
  const send = page.getByRole('button', { name: 'Send message' });
  await expect(send).toBeDisabled();
  await page.getByRole('textbox', { name: 'Message' }).fill('Received, releasing soon');
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByText('Received, releasing soon')).toHaveCount(1);
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ tradeId: orderId, text: 'Received, releasing soon' });
  expect(sends[0].clientId.length).toBeGreaterThan(8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  trade.status = 'fiat_sent';
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.getByRole('button', { name: 'Release escrow' }).click();
  await expect(page.getByRole('dialog', { name: 'Review: Release escrow' }).getByText('2 USDT', { exact: true })).toBeVisible();
});

test('A lost chat reply is checked before it is sent again, so it posts once', async ({ page }) => {
  const trade = {
    id: orderId,
    offerId: spaceId,
    sellerId: userId,
    buyerId: merchantId,
    asset: 'USDT',
    amount: '2',
    fiatCurrency: 'USD',
    fiatAmount: '2.1',
    price: '1.05',
    method: 'operator-method',
    status: 'escrowed',
    resolution: null,
    deadlineAt: null,
    createdAt: '2026-10-07T12:00:00Z',
    escrowedAt: '2026-10-07T12:00:00Z',
    resolvedAt: null,
    settledAt: null,
  };
  const stored = [];
  const sends = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('trades.get')) return reply(route, trade);
    if (url.includes('chat.messages.list')) return reply(route, { messages: stored, nextCursor: null, unread: 0 });
    if (url.includes('chat.messages.send')) {
      const body = route.request().postDataJSON();
      sends.push(body);
      // The service stores the message, but the reply is lost on the way back.
      if (!stored.some((message) => message.clientId === body.clientId))
        stored.push({
          id: '66666666-6666-4666-8666-666666666661',
          tradeId: orderId,
          senderId: userId,
          clientId: body.clientId,
          text: body.text,
          createdAt: '2026-10-07T12:02:00Z',
        });
      return route.abort('connectionreset');
    }
    if (url.includes('contacts.list')) return reply(route, { following: [], blocking: [] });
    return reply(route, null, 404);
  });
  await mount(page, `/chat?tradeId=${orderId}`);
  await page.getByRole('heading', { name: 'Order chat' }).scrollIntoViewIfNeeded();
  await expect(page.getByText('No messages yet.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Message' }).fill('Paid, please check');
  await page.getByRole('textbox', { name: 'Message' }).press('Enter');
  await expect(page.getByTestId('chat-pending').getByText('Not confirmed')).toBeVisible();
  await page.getByRole('button', { name: 'Check and send' }).click();
  await expect(page.getByTestId('chat-pending')).toHaveCount(0);
  await expect(page.getByText('Paid, please check')).toHaveCount(1);
  expect(sends).toHaveLength(1);
});

test('Order list marks unread chat, and the counterparty page confirms before blocking', async ({ page }) => {
  const trade = {
    id: orderId,
    offerId: spaceId,
    sellerId: merchantId,
    buyerId: userId,
    asset: 'USDT',
    amount: '2',
    fiatCurrency: 'USD',
    fiatAmount: '2.1',
    price: '1.05',
    method: 'operator-method',
    status: 'escrowed',
    resolution: null,
    deadlineAt: null,
    createdAt: '2026-10-07T12:00:00Z',
    escrowedAt: '2026-10-07T12:00:00Z',
    resolvedAt: null,
    settledAt: null,
  };
  const blocks = [];
  let blocking = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('trades.page'))
      return reply(route, {
        trades: [{ ...trade, tab: 'in_progress', displayStatus: 'waiting_for_buyer_to_pay' }],
        nextCursor: null,
        counts: { in_progress: 1, in_dispute: 0, completed: 0, cancelled: 0 },
      });
    if (url.includes('chat.unread')) return reply(route, { tradeId: orderId, unread: 3 });
    if (url.includes('contacts.block')) {
      blocks.push(route.request().postDataJSON());
      blocking = [merchantId];
      return reply(route, { following: [], blocking });
    }
    if (url.includes('contacts.list')) return reply(route, { following: [], blocking });
    if (url.includes('reputation.get'))
      return reply(route, {
        tradesTotal: 2,
        completed: 1,
        cancelled: 1,
        disputed: 0,
        disputesLost: 0,
        completionRate: 0.5,
        avgReleaseSecs: 20,
        badges: [],
        merchant: null,
      });
    return reply(route, null, 404);
  });
  await mount(page, '/uc/order');
  await expect(page.getByTestId('unread-badge')).toHaveText('3 new');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await mount(page, `/checkuser?userId=${merchantId}`);
  await page.getByRole('button', { name: 'Block', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Block this member?' });
  await expect(dialog.getByText('Orders that are already open stay open, with their chat.')).toBeVisible();
  expect(blocks).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Block', exact: true }).click();
  expect(blocks).toHaveLength(1);
  expect(blocks[0].peerId).toBe(merchantId);
  expect(blocks[0].idempotencyKey.length).toBeGreaterThanOrEqual(8);
  await expect(page.getByText('You blocked this member.').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unblock', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
});

test('Legacy counterparty IDs read reputation instead of addressing an order', async ({ page }) => {
  const requests = [];
  await page.route('**/api/**', (route) => {
    requests.push(route.request().url());
    if (route.request().url().includes('contacts.list')) return reply(route, { following: [], blocking: [] });
    return reply(route, {
      tradesTotal: 2,
      completed: 1,
      cancelled: 1,
      disputed: 0,
      disputesLost: 0,
      completionRate: 0.5,
      avgReleaseSecs: 20,
      badges: [],
      merchant: null,
    });
  });
  await mount(page, `/checkuser?id=${merchantId}`);
  await expect(page.getByRole('heading', { name: 'Counterparty', exact: true })).toBeVisible();
  await expect(page.getByText('Programme unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Follow', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Block', exact: true })).toBeEnabled();
  const p2p = requests.filter((url) => url.includes('/api/p2p/'));
  expect(p2p).toHaveLength(2);
  expect(p2p.some((url) => url.includes('/api/p2p/trpc/reputation.get'))).toBe(true);
  expect(p2p.some((url) => url.includes('/api/p2p/trpc/contacts.list'))).toBe(true);
});

test('Personal P2P programme application does not create Business authority', async ({ page }) => {
  const posted = [];
  let applied = false;
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    if (url.includes('merchants.apiAccess'))
      return reply(route, {
        eligible: false,
        credential: 'session',
        merchantStatus: applied ? 'applied' : null,
        keyPlane: 'identity',
        rateLimitPlane: 'edge',
        disputeResolution: 'interactive_human_only',
      });
    const standing = {
      userId,
      status: 'applied',
      appliedCompletionRate: 1,
      appliedTradesTotal: 2,
      appliedAt: '2026-10-07T12:00:00Z',
      decidedAt: null,
    };
    if (url.includes('merchants.submitApplication')) {
      posted.push(route.request().postDataJSON());
      applied = true;
      return reply(route, standing);
    }
    return reply(route, applied ? standing : null);
  });
  await mount(page, '/p2p?view=access');
  await expect(page.locator('nav[aria-label="P2P rooms"] [aria-current="page"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Apply to P2P programme', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Apply to p2p programme' }).click();
  await expect(page.getByText('applied', { exact: true })).toBeVisible();
  expect(posted).toEqual([{}]);
  await mount(page, '/pay/links');
  await expect(page.getByRole('heading', { name: 'Access is restricted' })).toBeVisible();
});

test('Public checkout keeps fixed amount authoritative and never invents a payment handoff', async ({ page }) => {
  const posted = [];
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    if (url.includes('resolveLink'))
      return reply(route, {
        id: orderId,
        merchantId,
        profileId: null,
        label: 'Checkout test fixture',
        amount: '12.000000000000000001',
        currency: 'USD',
        expiresAt: null,
        remainingUses: 1,
        checkoutConfig: {},
      });
    const checkout = {
      id: orderId,
      status: 'open',
      label: 'Checkout test fixture',
      amount: '12.000000000000000001',
      currency: 'USD',
      method: 'card',
      expiresAt: '2027-10-07T12:00:00Z',
      instruction: null,
    };
    if (url.includes('checkout.open')) {
      posted.push(route.request().postDataJSON());
      return reply(route, { sessionToken: 'session-test-capability', session: checkout });
    }
    return reply(route, checkout);
  });
  await mount(page, '/pay/checkout?token=link-test-capability', null, false);
  await expect(page.getByText('12.000000000000000001 USD', { exact: true })).toBeVisible();
  await page.getByLabel('Your country').fill('ID');
  await page.getByLabel('Payment method', { exact: true }).selectOption('card');
  await page.getByRole('button', { name: 'Open payment session', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Open payment session' }).click();
  await expect(page.getByRole('heading', { name: 'Payment instructions were not returned' })).toBeVisible();
  expect(posted).toEqual([{ token: 'link-test-capability', geoCountry: 'ID', method: 'card' }]);
  await expect(page.getByRole('button', { name: /paid|capture|pay now/i })).toHaveCount(0);
});

test('Developer sandbox key cannot omit its mode or enter the live payment path', async ({ page }) => {
  const posted = [];
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    if (url.includes('merchant.me')) return reply(route, merchant);
    if (url.includes('apiKeys.list')) return reply(route, []);
    posted.push({ url, body: route.request().postDataJSON() });
    return reply(route, { id: orderId, key: 'ifc_test_fixture-secret', prefix: 'ifc_test_fixture', mode: 'sandbox' });
  });
  await mount(page, '/pay/developer', authority);
  await page.getByLabel('Key name').fill('Sandbox test fixture');
  await page.getByLabel('pay:read', { exact: true }).check();
  await page.getByRole('button', { name: 'Create sandbox key', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create sandbox key' }).click();
  await expect(page.getByRole('heading', { name: 'Sandbox secret returned once' })).toBeVisible();
  expect(posted).toHaveLength(1);
  expect(posted[0].body).toEqual({ name: 'Sandbox test fixture', scopes: ['pay:read'], mode: 'sandbox' });
  expect(posted[0].url).toContain('/api/identity/trpc/apiKeys.create');
  await expect(page.getByRole('button', { name: /capture|refund|payout|live payment/i })).toHaveCount(0);
});

test('Personal Pay fits desktop, tablet and phone without page overflow', async ({ page }) => {
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await mount(page, '/pay');
    await expect(page.getByRole('heading', { name: 'Pay', exact: true })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    await page.screenshot({
      path: `${process.env.PAY_PROOF_DIR ?? '/tmp/intafaced-pay-browser-results'}/personal-pay-${width}.png`,
      fullPage: true,
    });
  }
});

test('Pay uses accessible control names, page regions and contrast in the browser', async ({ page }) => {
  await mount(page, '/pay');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await mount(page, '/pay/links');
  await expect(page.getByRole('heading', { name: 'Access is restricted' })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
});

test('light appearance keeps the real Pay chrome action readable', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ theme: 'light' })));
  await mount(page, '/pay');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const action = page.getByRole('link', { name: 'Send money', exact: true });
  await expect(action).toBeVisible();
  // Axe cannot resolve gradient images. Check the actual flat face under the
  // label separately; the metallic border is outside that painted area.
  const contrast = await action.evaluate((node) => {
    const style = getComputedStyle(node);
    const faces = [...style.backgroundImage.matchAll(/rgb\(([^)]+)\)/g)].slice(0, 2).map((match) => match[1]);
    if (faces.length !== 2 || faces[0] !== faces[1]) throw new Error('The chrome face is not a flat opaque surface');
    const luminance = (rgb) =>
      rgb
        .split(',')
        .map(Number)
        .map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const text = luminance(style.color.match(/rgb\(([^)]+)\)/)[1]);
    const face = luminance(faces[0]);
    return (Math.max(text, face) + 0.05) / (Math.min(text, face) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(audit.violations.filter((item) => ['serious', 'critical'].includes(item.impact))).toEqual([]);
});

test('authored French Pay copy preserves the exact reviewed transfer and the opaque original response', async ({ page }) => {
  const posted = [];
  await page.route('**/api/**', async (route) => {
    if (route.request().url().includes('spaces.list')) return reply(route, [source]);
    posted.push(route.request().postDataJSON());
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Original source explanation' }),
    });
  });
  await mount(page, '/pay/send');
  await page.evaluate(async () => {
    const { savePreferences } = await import('/src/shared/preferences.ts');
    savePreferences({ language: 'fr' });
  });
  const heading = page.getByRole('heading', { name: 'Envoyer de l’argent', exact: true });
  await expect(heading).toBeVisible();
  expect(await heading.evaluate((element) => element.closest('[lang]')?.getAttribute('lang'))).toBe('fr');
  await page.getByLabel('Compte source').selectOption(spaceId);
  await page.getByLabel('ID du compte destinataire').fill(merchantId);
  await page.getByLabel('Montant · USDT', { exact: true }).fill('0.000000000000000001');
  await page.getByRole('button', { name: 'Vérifier le transfert' }).click();
  const dialog = page.getByRole('dialog', { name: 'Vérifier le transfert' });
  await expect(dialog.getByText('0.000000000000000001 USDT', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirmer le transfert' }).click();
  await expect(dialog.getByRole('heading', { name: 'Résultat non confirmé' })).toBeVisible();
  const originalMessage = dialog.getByText('Original source explanation', { exact: true });
  await expect(originalMessage).toBeVisible();
  expect(await originalMessage.evaluate((element) => element.closest('[lang]')?.getAttribute('lang'))).toBe('und');
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ amount: '0.000000000000000001', fromSpaceId: spaceId, toUserId: merchantId });
});

for (const count of [0, 1, 2]) {
  test(`Holding Send keeps BTC context with ${count} owned BTC sources`, async ({ page }) => {
    const btc = {
      ...source,
      id: orderId,
      name: 'Bitcoin source',
      assetId: 'BTC',
      ledgerAccount: { ...source.ledgerAccount, assetId: 'BTC' },
    };
    const second = {
      ...btc,
      id: merchantId,
      name: 'Savings',
      kind: 'named',
      ledgerAccount: { ...btc.ledgerAccount, ownerType: 'subaccount', ownerId: merchantId },
    };
    const spaces = [source, ...(count ? [btc] : []), ...(count === 2 ? [second] : [])];
    const writes = [];
    await page.route('**/api/**', (route) => {
      if (route.request().url().includes('spaces.list')) return reply(route, spaces);
      writes.push(route.request().postDataJSON());
      return reply(route, null, 503);
    });
    await mount(page, '/pay/send?asset=BTC');
    await expect(page.getByRole('heading', { name: 'Sending BTC', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /Back to BTC holding/ })).toHaveAttribute('href', '/portfolio/BTC');
    if (!count) {
      await expect(page.getByRole('heading', { name: 'No BTC source account available' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Choose another asset' })).toHaveAttribute('href', '/pay/send');
      await expect(page.getByLabel('Source account', { exact: true })).toHaveCount(0);
    } else {
      const select = page.getByLabel('Source account');
      await expect(select.locator('option')).not.toContainText(['Main · USDT']);
      await expect(select).toHaveValue(count === 1 ? orderId : '');
      if (count === 2) {
        await expect(page.getByRole('button', { name: 'Review transfer' })).toBeDisabled();
        await select.selectOption(merchantId);
      }
      await expect(page.getByLabel('Amount · BTC', { exact: true })).toBeVisible();
      await page.getByLabel('Recipient account ID').fill('recipient-context-check');
      await page.getByLabel('Amount · BTC', { exact: true }).fill('0.000000000000000001');
      await page.getByRole('button', { name: 'Review transfer' }).click();
      const dialog = page.getByRole('dialog', { name: 'Review transfer' });
      await expect(dialog.getByText('0.000000000000000001 BTC', { exact: true })).toBeVisible();
      await expect(dialog.getByText(count === 1 ? 'Bitcoin source · BTC' : 'Savings · BTC', { exact: true })).toBeVisible();
    }
    expect(writes).toEqual([]);
  });
}

test('Ambiguous incoming holding asset refuses instead of choosing another asset', async ({ page }) => {
  const writes = [];
  await page.route('**/api/**', (route) => {
    if (route.request().url().includes('spaces.list')) return reply(route, [source]);
    writes.push(route.request().url());
    return reply(route, null, 503);
  });
  await mount(page, '/pay/send?asset=BTC&asset=USDT');
  await expect(page.getByText('The holding asset could not be identified. Choose it again from Money.')).toBeVisible();
  await expect(page.getByLabel('Source account')).toHaveCount(0);
  expect(writes).toEqual([]);
});
