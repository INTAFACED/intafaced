import { test, expect } from '@playwright/test';
test('Quant Studio keeps the draft on this device and offers Save to library only once the rules are complete', async ({ page }) => {
  const saves: unknown[] = [];
  await page.route('**/api/**', async (route) => {
    const proc = new URL(route.request().url()).pathname.split('/').at(-1);
    if (proc === 'studio.save') saves.push(proc);
    await route.fulfill({ json: { result: { data: { strategies: [], nextCursor: null } } } });
  });
  await page.goto('/quant/studio');
  await page.getByLabel('Strategy name').fill('My experiment');
  await page.getByLabel('Simulated starting cash').fill('0.000000000000000123');
  await page.getByLabel('Block 1 symbol').fill('ACTUAL/USD');
  await page.getByLabel('Block 1 quantity').fill('0.000000000000000456');
  const save = page.getByRole('button', { name: 'Save to library', exact: true });
  await expect(save).toBeDisabled();
  await expect(
    page.getByText('Fill in a name, the starting cash, every block or signal rule input, and the three risk limits to save.'),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Strategy name')).toHaveValue('My experiment');
  await expect(page.getByLabel('Block 1 quantity')).toHaveValue('0.000000000000000456');
  expect(saves).toEqual([]);
});
test('Quant Backtest lists only local drafts, never reads the shared library, and asks for a Studio strategy first', async ({ page }) => {
  const listed: string[] = [];
  await page.route('**/api/**', async (route) => {
    const proc = new URL(route.request().url()).pathname.split('/').at(-1);
    if (proc === 'studio.list') listed.push(proc);
    await route.fulfill({ json: { result: { data: { strategies: [] } } } });
  });
  await page.goto('/quant/backtest');
  await expect(page.getByText('Create a strategy in Studio first')).toBeVisible();
  await expect(page.getByLabel('Your hypothesis')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review historical analysis' })).toBeDisabled();
  expect(listed).toEqual([]);
});
test('campaign assessment shows the real warehouse refusal and sends no publication request', async ({ page }) => {
  let seen: unknown;
  await page.route('**/api/**', async (route) => {
    seen = route.request().postDataJSON();
    await route.fulfill({
      json: {
        result: {
          data: {
            status: 'refuse',
            reason: 'warehouse_dark',
            isPublication: false,
            published: false,
            warehouseConfigured: false,
            warehouseMayLabelLive: false,
            inventedReturns: false,
            inventedBudget: false,
          },
        },
      },
    });
  });
  await page.goto('/campaigns');
  await page.getByLabel('Campaign headline').fill('Product update');
  await page.getByLabel('Campaign copy').fill('A reviewed announcement.');
  await page.getByRole('button', { name: 'Review campaign proposal', exact: true }).click();
  expect(seen).toBeUndefined();
  await page.getByRole('dialog').getByRole('button', { name: 'Request draft assessment' }).click();
  await expect(page.getByText('No campaign proposal was produced: warehouse_dark.')).toBeVisible();
  expect(seen).toEqual({ headline: 'Product update', copy: 'A reviewed announcement.', publish: false });
});
test('More rooms keep forms and empty states within a 320px viewport with accessible input names', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 412,
      json: { error: { message: 'Published prerequisite unavailable', data: { code: 'PRECONDITION_FAILED' } } },
    }),
  );
  for (const path of [
    '/more',
    '/academy',
    '/agents',
    '/quant/studio',
    '/quant/backtest',
    '/market/mine',
    '/blueprint',
    '/support',
    '/token',
    '/mining',
    '/launch',
    '/predict',
    '/campaigns',
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), path).toBe(true);
    for (const control of await page.locator('input:not([type=hidden]),select,textarea').all()) {
      await expect(control).toHaveAccessibleName(/\S/);
    }
  }
  await page.goto('/support');
  await expect(page.locator('html')).toHaveAttribute('data-test-actor', user);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Search help')).toBeFocused();
});
test('governance refuses a new proposal with no kind chosen, without sending it', async ({ page }) => {
  let writes = 0;
  await page.route('**/api/**', async (route) => {
    const proc = new URL(route.request().url()).pathname.split('/').at(-1);
    if (route.request().method() === 'POST') writes++;
    const data =
      proc === 'accessOf'
        ? { staked: '0', tier: 'none', feeDiscountBps: 0 }
        : proc === 'burnedSupply'
          ? { burned: '0' }
          : proc === 'governanceHome'
            ? { spaceId: 'ifc', following: false, proposal: { code: null, minStake: null } }
            : [];
    await route.fulfill({ json: { result: { data } } });
  });
  await page.goto('/token');
  await page.getByRole('button', { name: 'Governance', exact: true }).click();
  await page.getByRole('button', { name: 'New proposal', exact: true }).click();
  const form = page.getByRole('form', { name: 'New proposal' });
  await form.getByRole('textbox', { name: 'Title' }).fill('A proposal with no kind');
  await form.getByRole('button', { name: 'Submit proposal', exact: true }).click();
  expect(await form.getByLabel('Kind').evaluate((el) => (el as HTMLSelectElement).validity.valueMissing)).toBe(true);
  expect(writes).toBe(0);
  await expect(form.getByRole('status')).toHaveCount(0);
});
test('private support data with another account identity is refused before rendering or replying', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const proc = new URL(route.request().url()).pathname.split('/').at(-1);
    await route.fulfill({
      json: {
        result: {
          data:
            proc === 'listMine' ? [{ ...ticket, userId: '00000000-0000-4000-8000-000000000099', subject: 'Foreign private content' }] : [],
        },
      },
    });
  });
  await page.goto('/support');
  await expect(page.getByRole('heading', { name: 'Information could not be verified' })).toBeVisible();
  await expect(page.getByText('Foreign private content')).toHaveCount(0);
});
test('numeric listing money is refused at the network boundary', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const proc = new URL(route.request().url()).pathname.split('/').at(-1);
    const data =
      proc === 'listings'
        ? [
            {
              id: '00000000-0000-4000-8000-000000000011',
              vendorId: '00000000-0000-4000-8000-000000000012',
              title: 'Numeric offer',
              description: 'Invalid wire amount',
              offerType: 'one_time',
              assetId: 'USD',
              price: 1.125,
              periodSeconds: null,
              status: 'active',
              createdAt: '2026-10-08T00:00:00Z',
              updatedAt: '2026-10-08T00:00:00Z',
            },
          ]
        : proc === 'commerceProgramme'
          ? { commissionBps: 100, commissionConfigured: true }
          : [];
    await route.fulfill({ json: { result: { data } } });
  });
  await page.goto('/market');
  await expect(page.getByRole('heading', { name: 'Information could not be verified' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buy Numeric offer' })).toHaveCount(0);
});
test('Academy media requests a real seat credential and never labels an expired credential connected', async ({ page }) => {
  const roomId = '00000000-0000-4000-8000-000000000021',
    sessionId = '00000000-0000-4000-8000-000000000022';
  let credentials = 0;
  await page.route('**/api/**', async (route) => {
    const proc = new URL(route.request().url()).pathname.split('/').at(-1);
    let data: unknown = [];
    const room = { id: roomId, slug: 'study', name: 'Study', kind: 'general', access: 'free', minStake: '0', capacity: 5, hostId: user };
    if (proc === 'rooms') data = [room];
    if (proc === 'room')
      data = {
        room,
        sessions: [
          {
            id: sessionId,
            roomId,
            title: 'Live study',
            hostId: user,
            status: 'live',
            startsAt: '2026-10-08T00:00:00Z',
            endsAt: null,
            streamProvider: 'livekit',
            scene: { version: 1 },
            sceneFingerprint: 'fp',
          },
        ],
      };
    if (proc === 'streamCredential') {
      credentials++;
      expect(route.request().postDataJSON()).toEqual({ sessionId });
      data = { url: 'wss://sfu.example.invalid', token: 'test-expired-credential', expiresAt: '2020-01-01T00:00:00Z' };
    }
    await route.fulfill({ json: { result: { data } } });
  });
  await page.goto('/academy');
  await page.getByRole('button', { name: 'Rooms', exact: true }).click();
  await page.getByRole('button', { name: 'Open Study' }).click();
  await page.getByRole('button', { name: 'Connect audio/video' }).click({ timeout: 3000 });
  await expect(page.getByText('The connection details have expired, so no connection was started.')).toBeVisible();
  expect(credentials).toBe(1);
  await expect(page.getByRole('button', { name: 'Enable microphone' })).toHaveCount(0);
});
test('Blueprint accepts local SVG gradients and refuses active service card content', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()),
      proc = url.pathname.split('/').at(-1);
    let data: unknown = null;
    if (proc === 'mentors') data = [];
    if (proc === 'card') {
      const input = JSON.parse(url.searchParams.get('input')!);
      data = {
        size: input.size,
        width: 1200,
        height: 630,
        shareMode: 'svg',
        svg:
          input.size === 'portrait'
            ? '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="ink"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#ink)"/></svg>'
            : '<svg xmlns="http://www.w3.org/2000/svg"><script>window.cardUnsafe=true</script></svg>',
        raster: { status: 'unavailable', code: 'blueprint.card_renderer_unconfigured', reason: 'No renderer' },
      };
    }
    await route.fulfill({ json: { result: { data } } });
  });
  await page.goto('/blueprint');
  await expect(page.getByRole('button', { name: 'Download SVG card' })).toBeVisible({ timeout: 3000 });
  await page.getByLabel('Card size').selectOption('landscape');
  await expect(page.getByText('The card contains unsupported active or external content and cannot be rendered.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download SVG card' })).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'cardUnsafe'))).toBeUndefined();
});
test('workbook uses the published paper flag and selected trade fill references without inventing a mark', async ({ page }) => {
  let resultInput: unknown;
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()),
      proc = url.pathname.split('/').at(-1);
    let data: unknown = [];
    let raw = url.pathname.startsWith('/api/v1');
    if (proc === 'markets') data = [{ id: 'paper-id', symbol: 'PRACTICE/USD', paper: true }];
    if (proc === 'curriculumItemLocalized')
      data = {
        slug: 'practice',
        title: 'Practice workbook',
        kind: 'workbook',
        path: 'foundations',
        order: 1,
        summary: 'Practise',
        estimatedMinutes: 4,
        body: 'Read this workbook.',
        objectives: ['Practise'],
        keyTerms: [{ term: 'Fill', definition: 'Executed order' }],
        selfCheck: ['What filled?'],
        locale: 'en',
        fellBack: false,
        i18nStrategy: 'English fallback',
      };
    if (proc === 'paperDrill')
      data = {
        ok: true,
        simulated: true,
        venue: 'paper',
        realLedger: false,
        withdrawable: false,
        realMoney: false,
        disclaimer: 'Simulated results only',
        marketId: 'paper-id',
        symbol: 'PRACTICE/USD',
        steps: [{ id: 'observe', instruction: 'Observe the published fill' }],
      };
    if (url.pathname.endsWith('/account/trades'))
      data = [
        {
          id: 'fill-ref',
          order: 'order-ref',
          symbol: 'PRACTICE/USD',
          type: 'limit',
          side: 'buy',
          timestamp: 1,
          datetime: '2026-10-08T00:00:00Z',
          price: '1.125',
          amount: '0.000000000000000123',
          cost: '0.000000000000000138',
          takerOrMaker: 'taker',
          fee: null,
        },
      ];
    if (proc === 'paperDrillResult') {
      resultInput = JSON.parse(url.searchParams.get('input')!);
      await route.fulfill({
        status: 412,
        json: { error: { message: 'paper result source unavailable', data: { code: 'PRECONDITION_FAILED' } } },
      });
      return;
    }
    await route.fulfill({ json: raw ? data : { result: { data } } });
  });
  await page.goto('/academy/practice');
  await page.getByLabel('Simulated market').selectOption('paper-id', { timeout: 3000 });
  await page.getByLabel('Complete: Observe the published fill').check();
  await page.getByLabel('Attach fill fill-ref').check();
  await page.getByRole('button', { name: 'Read drill result' }).click();
  await expect(page.getByText('paper result source unavailable')).toBeVisible();
  expect(resultInput).toMatchObject({
    market: { marketId: 'paper-id', paper: true, symbol: 'PRACTICE/USD' },
    completedStepIds: ['observe'],
    fills: [{ fillId: 'fill-ref', marketId: 'paper-id', side: 'buy', price: '1.125', size: '0.000000000000000123' }],
    markPrice: null,
  });
});
test('an uncertain purchase survives reload and is recovered only by its original client purchase ID', async ({ page }) => {
  let original: string | undefined,
    writes = 0;
  const listing = {
    id: '00000000-0000-4000-8000-000000000011',
    vendorId: '00000000-0000-4000-8000-000000000012',
    title: 'Access',
    description: 'Published access',
    offerType: 'one_time',
    assetId: 'USD',
    price: '0.000000000000000123',
    periodSeconds: null,
    status: 'active',
    createdAt: '2026-10-08T00:00:00Z',
    updatedAt: '2026-10-08T00:00:00Z',
  };
  await page.route('**/api/**', async (route) => {
    const proc = new URL(route.request().url()).pathname.split('/').at(-1);
    let data: unknown = [];
    if (proc === 'listings') data = [listing];
    if (proc === 'commerceProgramme') data = { commissionBps: 100, commissionConfigured: true };
    if (proc === 'purchase') {
      writes++;
      original = route.request().postDataJSON().purchaseId;
      await route.abort();
      return;
    }
    if (proc === 'myPurchases' && original)
      data = [
        {
          id: original,
          listingId: listing.id,
          buyerId: user,
          vendorId: listing.vendorId,
          vendorUserId: '00000000-0000-4000-8000-000000000013',
          assetId: 'USD',
          price: listing.price,
          commissionBps: 100,
          status: 'settled',
          ledgerTxId: '00000000-0000-4000-8000-000000000014',
          rejectionCode: null,
          createdAt: listing.createdAt,
          settledAt: listing.createdAt,
          accessUntil: null,
        },
      ];
    await route.fulfill({ json: { result: { data } } });
  });
  await page.goto('/market');
  await page.getByRole('button', { name: 'Buy Access' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm purchase' }).click();
  await expect(page.getByText('Outcome not confirmed', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Check original outcome' }).click({ timeout: 3000 });
  await expect(page.getByText('Original outcome verified')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buy Access' })).toBeEnabled();
  expect(writes).toBe(1);
});
const user = '00000000-0000-4000-8000-000000000001';
test('Market keeps the original purchase guard for pending responses and pending or unproved recovery rows', async ({ page }) => {
  let original = '',
    writes = 0,
    state: 'pending' | 'unproved' | 'settled' = 'pending';
  const listing = {
    id: '00000000-0000-4000-8000-000000000011',
    vendorId: '00000000-0000-4000-8000-000000000012',
    title: 'Access',
    description: 'Published access',
    offerType: 'one_time',
    assetId: 'USD',
    price: '0.000000000000000123',
    periodSeconds: null,
    status: 'active',
    createdAt: '2026-10-08T00:00:00Z',
    updatedAt: '2026-10-08T00:00:00Z',
  };
  const record = () => ({
    id: original,
    listingId: listing.id,
    buyerId: user,
    vendorId: listing.vendorId,
    vendorUserId: '00000000-0000-4000-8000-000000000013',
    assetId: listing.assetId,
    price: listing.price,
    commissionBps: 100,
    status: state === 'pending' ? 'pending' : 'settled',
    ledgerTxId: state === 'settled' ? '00000000-0000-4000-8000-000000000014' : null,
    rejectionCode: null,
    createdAt: listing.createdAt,
    settledAt: state === 'pending' ? null : listing.createdAt,
    accessUntil: null,
  });
  await page.route('**/api/**', async (route) => {
    const procedure = new URL(route.request().url()).pathname.split('/').at(-1);
    let data: unknown = [];
    if (procedure === 'listings') data = [listing];
    if (procedure === 'commerceProgramme') data = { commissionBps: 100, commissionConfigured: true };
    if (procedure === 'purchase') {
      writes++;
      original = route.request().postDataJSON().purchaseId;
      data = record();
    }
    if (procedure === 'myPurchases' && original) data = [record()];
    await route.fulfill({ json: { result: { data } } });
  });
  await page.goto('/market');
  await page.getByRole('button', { name: 'Buy Access' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm purchase' }).click();
  await expect(page.getByText('Original purchase is still pending. Settlement is not confirmed.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buy Access' })).toBeDisabled();
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).reference, `intafaced:more:pending:${user}:market`)).toBe(
    original,
  );
  await page.reload();
  await page.getByRole('button', { name: 'Check original outcome' }).click();
  await expect(page.getByText('Original purchase is still pending. Settlement is not confirmed.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buy Access' })).toBeDisabled();
  state = 'unproved';
  await page.getByRole('button', { name: 'Check original outcome' }).click();
  await expect(page.getByText('The original settlement evidence is incomplete. Keep its purchase reference.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buy Access' })).toBeDisabled();
  state = 'settled';
  await page.getByRole('button', { name: 'Check original outcome' }).click();
  await expect(page.getByText('Original outcome verified')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buy Access' })).toBeEnabled();
  expect(writes).toBe(1);
});
const ticket = {
  id: '00000000-0000-4000-8000-000000000002',
  userId: user,
  category: 'trading',
  subject: 'Order review',
  body: 'Please inspect this order.',
  status: 'open',
  assigneeId: null,
  createdAt: '2026-10-08T00:00:00Z',
  updatedAt: '2026-10-08T00:00:00Z',
};
test('customer reviews a support request before creating it and can read the resulting conversation', async ({ page }) => {
  let created = false;
  const writes: unknown[] = [];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const procedure = url.pathname.split('/').at(-1);
    const input = url.searchParams.get('input');
    if (procedure === 'listMine') expect(JSON.parse(input!)).toEqual({ limit: 50 });
    let data: unknown = [];
    if (procedure === 'create') {
      writes.push(route.request().postDataJSON());
      created = true;
      data = ticket;
    }
    if (procedure === 'listMine') data = created ? [ticket] : [];
    if (procedure === 'get') data = ticket;
    await route.fulfill({ json: { result: { data } } });
  });
  await page.goto('/support');
  await page.getByLabel('Subject').fill('Order review');
  await page.getByLabel('Message', { exact: true }).fill('Please inspect this order.');
  await page.getByLabel('Category').selectOption('trading');
  await page.getByRole('button', { name: 'Review request' }).click();
  expect(writes).toHaveLength(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByText('Request created')).toBeVisible();
  expect(writes).toEqual([{ category: 'trading', subject: 'Order review', body: 'Please inspect this order.' }]);
  await page.getByRole('button', { name: 'Open Order review' }).click();
  await expect(page.getByRole('heading', { name: 'Order review', exact: true })).toBeVisible();
});
test('prediction links actual yes/no instruments to books and refuses order consent without an outcome preview', async ({ page }) => {
  const requested: string[] = [];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    let data: unknown = [];
    if (url.pathname.endsWith('/outcomes/markets'))
      data = [
        {
          id: 'event-1',
          kind: 'outcome',
          question: 'Will the event happen?',
          closeAt: '2099-01-01T00:00:00Z',
          settlementAssetId: 'USD',
          settlementSource: 'published-result',
          collateralization: 'full',
          instruments: [
            { outcome: 'yes', symbol: 'EVENT:YES' },
            { outcome: 'no', symbol: 'EVENT:NO' },
          ],
        },
      ];
    if (url.pathname.includes('/orderbook/')) {
      const symbol = decodeURIComponent(url.pathname.split('/').at(-1)!);
      requested.push(symbol);
      data = { symbol, timestamp: Date.now(), datetime: new Date().toISOString(), nonce: 1, bids: [['0.4', '2']], asks: [['0.6', '3']] };
    }
    await route.fulfill({ json: data });
  });
  await page.goto('/predict');
  await page.getByRole('button', { name: 'Open Will the event happen?' }).click({ timeout: 3000 });
  await page.getByRole('button', { name: 'No', exact: true }).click();
  await expect(page.getByText('EVENT:NO', { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText('Outcome order preview is not published. No order can be sent from this room.', { exact: true }),
  ).toBeVisible();
  expect(requested).toContain('EVENT:NO');
});
test('agents review server guardrails and published fee units before opening a session', async ({ page }) => {
  let opens = 0;
  await page.route('**/api/**', async (route) => {
    const proc = new URL(route.request().url()).pathname.split('/').at(-1);
    let data: unknown = [];
    if (proc === 'agent.get')
      data = {
        agentId: 'navigator',
        version: 1,
        enabled: true,
        tools: [{ name: 'trade.quote', module: 'trade', mode: 'read', requiresApproval: false, maxCallsPerSession: null }],
        limits: {
          maxActionsPerSession: 60,
          maxOutputTokensPerCall: 4096,
          maxSpendPerSession: '1',
          allowedModules: ['trade'],
          allowedTasks: ['navigator.plan'],
        },
      };
    if (proc === 'routes.list')
      data = [
        {
          task: 'navigator.plan',
          maxOutputTokens: 4096,
          capability: 'complete',
          inputPerMillion: '2',
          outputPerMillion: '8',
          assetId: 'USD',
        },
      ];
    if (proc === 'session.open') {
      opens++;
      expect(route.request().postDataJSON()).toEqual({ agentId: 'navigator' });
      data = {
        id: '00000000-0000-4000-8000-000000000005',
        agentId: 'navigator',
        guardrailVersion: 1,
        status: 'open',
        metered: true,
        openedAt: '2026-10-08T00:00:00Z',
        closedAt: null,
      };
    }
    await route.fulfill({ json: { result: { data } } });
  });
  await page.goto('/agents');
  await page.getByRole('button', { name: 'Review session' }).click({ timeout: 3000 });
  await expect(page.getByRole('dialog').getByText('1 USD maximum per session', { exact: true })).toBeVisible();
  expect(opens).toBe(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Open agent session' }).click();
  await expect(page.getByText('Agent session opened')).toBeVisible();
  expect(opens).toBe(1);
});
test('academy deep link loads source learning content and reviews completion without interpreting HTML', async ({ page }) => {
  let writes = 0;
  await page.route('**/api/**', async (route) => {
    const proc = new URL(route.request().url()).pathname.split('/').at(-1);
    let data: unknown = [];
    if (proc === 'curriculumItemLocalized')
      data = {
        slug: 'risk-basics',
        title: 'Risk basics',
        kind: 'lesson',
        path: 'foundations',
        order: 1,
        summary: 'Read risk.',
        estimatedMinutes: 4,
        body: '# A real lesson\n<script>window.unsafe=true</script>',
        objectives: ['Read the limits'],
        keyTerms: [{ term: 'Limit', definition: 'A bound' }],
        selfCheck: ['What is a limit?'],
        locale: 'en',
        fellBack: false,
        i18nStrategy: 'English fallback',
      };
    if (proc === 'markCurriculumComplete') {
      writes++;
      data = { userId: user, itemSlug: 'risk-basics', completedAt: '2026-10-08T00:00:00Z' };
    }
    await route.fulfill({ json: { result: { data } } });
  });
  await page.goto('/academy/risk-basics?path=foundations');
  await expect(page.getByRole('heading', { name: 'Risk basics', exact: true })).toBeVisible({ timeout: 3000 });
  await page.getByRole('button', { name: 'Review lesson completion' }).click();
  expect(writes).toBe(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Mark complete' }).click();
  await expect(page.getByText('Lesson completion recorded')).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, 'unsafe'))).toBeUndefined();
  expect(writes).toBe(1);
});
test('blueprint session stays switched off with the reason and sends no free-text answers', async ({ page }) => {
  const sent: string[] = [];
  await page.route('**/api/**', async (route) => {
    const proc = new URL(route.request().url()).pathname.split('/').at(-1) ?? '';
    if (proc === 'onboard') sent.push(proc);
    await route.fulfill({ json: { result: { data: proc === 'mentors' ? [] : null } } });
  });
  await page.goto('/blueprint');
  await expect(page.getByText('The Blueprint service does not publish its question list', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create your Blueprint' })).toBeDisabled();
  await expect(page.getByLabel('Answer key')).toHaveCount(0);
  await expect(page.getByLabel('Initial visibility')).toBeDisabled();
  await expect(page.getByLabel('Opt in to mentor availability')).toBeDisabled();
  expect(sent).toEqual([]);
});
test('quant sandbox labels server output simulated and never offers live deployment', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const proc = new URL(route.request().url()).pathname.split('/').at(-1);
    let data: unknown = {};
    if (proc === 'sandbox.capabilities')
      data = { isolate: 'wired', languages: ['javascript', 'typescript', 'python'], venueVault: 'unset', refuse: null };
    if (proc === 'sandbox.run') {
      expect(route.request().postDataJSON()).toMatchObject({
        cash: '17.125',
        environment: 'paper',
        presentedAs: 'paper',
        idempotencyKey: expect.any(String),
      });
      expect(String(route.request().postDataJSON().idempotencyKey).trim()).not.toBe('');
      data = {
        ok: true,
        language: 'javascript',
        logs: ['Completed by the isolate'],
        cash: '17.125',
        pnl: '0',
        fills: [],
        positions: [],
        venue: 'internal',
        venueVault: 'unset',
        environment: 'paper',
        kind: 'paper',
        claimLabel: 'Paper — not live performance',
        live: false,
        simulated: true,
      };
    }
    await route.fulfill({ json: { result: { data } } });
  });
  await page.goto('/quant/sandbox');
  await page.getByLabel('Simulated starting cash').fill('17.125', { timeout: 3000 });
  await page.getByLabel('Strategy source').fill('console.log("run");');
  await page.getByRole('button', { name: 'Review simulation' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByText('Paper — not live performance', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deploy live' })).toHaveCount(0);
});
test('token funds actions refuse when the public contract omits the configured asset identity', async ({ page }) => {
  let writes = 0;
  await page.route('**/api/**', async (route) => {
    const proc = new URL(route.request().url()).pathname.split('/').at(-1);
    let data: unknown = [];
    if (proc === 'accessOf') data = { staked: '17.125', tier: 'Initiate', feeDiscountBps: 10 };
    if (proc === 'burnedSupply') data = { burned: '0' };
    if (route.request().method() === 'POST') writes++;
    await route.fulfill({ json: { result: { data } } });
  });
  await page.goto('/token');
  await expect(
    page.getByText('Staking and unstaking are off because INTAFACED does not say which token balance they would move.', { exact: true }),
  ).toBeVisible({
    timeout: 3000,
  });
  await expect(page.getByRole('button', { name: 'Review stake' })).toHaveCount(0);
  await expect(page.getByText('17.125 · token not named', { exact: true })).toBeVisible();
  expect(writes).toBe(0);
});
test('market purchase refuses a changed listing before moving value', async ({ page }) => {
  let changed = false,
    writes = 0;
  const listing = {
    id: '00000000-0000-4000-8000-000000000003',
    vendorId: '00000000-0000-4000-8000-000000000004',
    title: 'Research access',
    description: 'A published research package.',
    offerType: 'one_time',
    assetId: 'USD',
    price: '12.5',
    periodSeconds: null,
    status: 'active',
    createdAt: '2026-10-08T00:00:00Z',
    updatedAt: '2026-10-08T00:00:00Z',
  };
  await page.route('**/api/**', async (route) => {
    const proc = new URL(route.request().url()).pathname.split('/').at(-1);
    let data: unknown = [];
    if (proc === 'listings') {
      data = [{ ...listing, price: changed ? '15' : '12.5' }];
    }
    if (proc === 'commerceProgramme') data = { commissionBps: 100, commissionConfigured: true };
    if (proc === 'purchase') writes++;
    await route.fulfill({ json: { result: { data } } });
  });
  await page.goto('/market');
  await page.getByRole('button', { name: 'Buy Research access' }).click();
  await expect(page.getByRole('dialog').getByText('12.5 USD', { exact: true })).toBeVisible();
  changed = true;
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm purchase' }).click();
  await expect(page.getByText('The listing terms changed. Reload the catalogue and review again.')).toBeVisible();
  expect(writes).toBe(0);
});
