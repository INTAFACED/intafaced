// World: book, restart
// Market: live
import { test, expect } from './journey.mjs';
import { api, journeyState, restartWithSetting } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { userIdOf } from './copy.mjs';
import { tapeWindow } from './tape.mjs';

// J-algo-dev-09, in the running app (docs/roadmap/journeys.json): publish a strategy to the library and let others run
// and review it. One test per step, titled "J-algo-dev-09 #<n>", run in order. A TEST developer (the owner) starts signed
// in with a saved signal-rules strategy whose version 1 has a finished backtest with its costs set; a TEST reader is the
// other person. Every strategy, run and figure in Algo dev is simulated and every listing is free: nothing here moves
// money (svc-quant imports no ledger client). The licence list and the realism checklist are the stack's labelled TEST
// values (tooling/profiles/test-owner-values/quant.json); `LOCAL_STACK_QUANT_LIBRARY_LICENCES=off` blanks the list.
const J = 'J-algo-dev-09';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const NAME = 'TEST library strategy';
const TITLE = 'TEST library cross';
const CLEAN = 'Buys when the fast average crosses above the slow one on one minute bars. Every figure is a historical simulation.';
const CLAIM = 'It returns 40% a year.';
const LICENCE = 'TEST open licence';
const RULES = {
  symbol: 'BTC/USDT',
  barSize: '1m',
  signal: { kind: 'ma_cross', average: 'sma', fast: '1', slow: '2' },
  sizing: { kind: 'quantity', value: '0.01' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
};

test.describe.configure({ mode: 'default' });

function state(...keys) {
  const read = run.read();
  for (const key of ['owner', 'reader', 'strategyId', ...keys])
    if (!read[key]) throw new Error(`${J}: an earlier step left no ${key}, so this step has nothing to act on`);
  return read;
}

const dataOf = (body) => body?.result?.data?.json ?? body?.result?.data;

/** A signed-in tRPC call of svc-quant through Edge, as the person; returns the HTTP status and the data or the error. */
async function quant(who, procedure, input, method = 'GET') {
  const client = await api(who);
  const res =
    method === 'GET'
      ? await client.get(`/api/quant/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`)
      : await client.post(`/api/quant/trpc/${procedure}`, input);
  return { status: res.status, data: dataOf(res.body), body: res.body };
}
async function ok(who, procedure, input, method) {
  const res = await quant(who, procedure, input, method);
  expect(res.status, `${procedure}: ${JSON.stringify(res.body).slice(0, 400)}`).toBe(200);
  return res.data;
}

/** Every listing the library shows, all pages, oldest first, as the service answers it. */
async function browseAll(who, tag = null) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 100; i++) {
    const page = await ok(who, 'library.browse', { tag, limit: 50, cursor });
    out.push(...page.entries);
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
  throw new Error('the library never ended');
}

/** The window of the TEST tape every backtest here runs on, as ISO instants for the API and minutes for the form. */
async function window() {
  const read = run.read();
  if (read.window) return read.window;
  const tape = await tapeWindow(60);
  run.write({ window: tape });
  return tape;
}
const iso = (minute) => `${minute}:00.000Z`;

/** Saves a new signal-rules strategy in Studio at version 1. Every figure is a TEST simulation input. */
async function saveSignalStrategy(page) {
  await page.goto('/quant/studio');
  const fresh = page.getByRole('button', { name: 'Start a new strategy' });
  if (await fresh.isVisible()) await fresh.click();
  await page.getByLabel('Strategy name').fill(NAME);
  await page.getByLabel('Simulated starting cash').fill('1000');
  await page.getByLabel('Block 1 symbol').fill('BTC/USDT');
  await page.getByLabel('Block 1 quantity').fill('0.01');
  await page.getByLabel('Max drawdown (service unit unspecified)').fill('100');
  await page.getByLabel('Max notional (service unit unspecified)').fill('500');
  await page.getByLabel('Kill threshold (service unit unspecified)').fill('50');
  await page.getByLabel('How the strategy trades').selectOption('signal');
  const builder = page.getByTestId('quant-signal-builder');
  await builder.getByLabel('Symbol').fill('BTC/USDT');
  await builder.getByLabel('Bar size').selectOption('1m');
  await builder.getByLabel('Fast average (bars)').fill('1');
  await builder.getByLabel('Slow average (bars)').fill('2');
  await builder.getByRole('combobox', { name: /^Size each entry by/ }).selectOption('quantity');
  await builder.getByLabel('Size', { exact: true }).fill('0.01');
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect(page.getByTestId('quant-save-state')).toHaveText('Saved as version 1.');
}

/** Runs a saved strategy's newest version in the bar backtest room on the TEST tape, with fees, slippage and delay set. */
async function backtest(page, strategy) {
  const tape = await window();
  await page.goto('/quant/backtest');
  const room = page.getByTestId('quant-bar-backtest');
  await room.getByRole('combobox', { name: /^Strategy/ }).selectOption({ label: strategy });
  await room.getByLabel('From (UTC)').fill(tape.from);
  await room.getByLabel('To (UTC)').fill(tape.to);
  await room.getByRole('combobox', { name: /^Fill a signal at/ }).selectOption('next_open');
  await room.getByRole('combobox', { name: /^Fee rate/ }).selectOption('taker');
  await room.getByLabel('Delay (bars)').fill('0');
  await room.getByLabel('Slippage (basis points)').fill('5');
  await room.getByTestId('quant-backtest-run').click();
  await expect(room.getByTestId('quant-bar-result')).toBeVisible();
}

/** A strategy saved, backtested and listed through svc-quant's own doors, as the owner: another person's library rows. */
async function listedThroughApi(who, name, tags, visibility) {
  const tape = await window();
  const saved = await ok(
    who,
    'studio.save',
    {
      name,
      blocks: [],
      modules: RULES,
      risk: { maxDrawdown: '100', maxNotional: '500', kill: '50' },
      cash: '1000',
      environment: 'paper',
      clientStrategyId: `${J}:${name}`,
      idempotencyKey: `studio.save:${J}:${name}`,
    },
    'POST',
  );
  await ok(
    who,
    'backtest.start',
    {
      strategyId: saved.id,
      strategyVersion: 1,
      cash: '1000',
      from: iso(tape.from),
      to: iso(tape.to),
      fillTiming: 'next_open',
      costs: { feeRole: 'taker', slippageBps: '5', delayBars: '0' },
    },
    'POST',
  );
  const options = await ok(who, 'library.options', {});
  const listing = await ok(
    who,
    'library.publish',
    {
      strategyId: saved.id,
      strategyVersion: 1,
      title: name,
      description: CLEAN,
      tags,
      visibility,
      licence: LICENCE,
      checklistVersion: options.checklist.version,
      checklistAccepted: true,
    },
    'POST',
  );
  return { strategyId: saved.id, listingId: listing.listingId };
}

/** The owner's publish panel on the strategy's page. */
async function publishPanel(page, strategyId) {
  await page.goto(`/quant/strategies/${encodeURIComponent(strategyId)}`);
  const panel = page.getByTestId('quant-publish');
  await expect(panel.getByTestId('quant-publish-form')).toBeVisible();
  return panel;
}

/** Fills the publish form: version, title, description, tags, visibility, licence and, when asked, every checklist item. */
async function fillPublish(panel, { version, description = CLEAN, tags = ['Trend'], visibility = 'open', checklist = false }) {
  const form = panel.getByTestId('quant-publish-form');
  if (version) await form.getByRole('combobox', { name: 'Version to publish' }).selectOption(String(version));
  await form.getByRole('textbox', { name: 'Listing title', exact: true }).fill(TITLE);
  await form.getByRole('textbox', { name: 'Description', exact: true }).fill(description);
  for (const tag of tags) await form.getByRole('checkbox', { name: tag, exact: true }).check();
  await form.getByRole('combobox', { name: 'Visibility' }).selectOption(visibility);
  if (await form.getByRole('combobox', { name: 'Licence' }).isVisible())
    await form.getByRole('combobox', { name: 'Licence' }).selectOption(LICENCE);
  const items = form.getByTestId('quant-realism-checklist').getByRole('checkbox');
  for (let i = 0; i < (await items.count()); i++) {
    if (checklist) await items.nth(i).check();
    else await items.nth(i).uncheck();
  }
  return form;
}

/** The check rows the screen shows after Run the checks, as { id: passed }. */
async function checkRows(form) {
  const checks = form.getByTestId('quant-listing-checks');
  await expect(checks).toBeVisible();
  const rows = checks.getByTestId('quant-listing-check');
  await expect(rows).toHaveCount(5);
  return Object.fromEntries(
    await rows.evaluateAll((els) => els.map((el) => [el.getAttribute('data-check'), el.getAttribute('data-passed') === 'true'])),
  );
}

test(`${J} #1 writes a description that claims a yearly return: the performance-claim check fails naming the sentence and nothing is listed`, async ({
  page,
}) => {
  test.setTimeout(20 * 60_000);
  const owner = await signUp(page, 'lo');
  await verify(page, owner);
  const reader = await signUp(page, 'lr');
  await verify(page, reader);
  run.reset({ owner, reader });
  run.write({ ownerId: await userIdOf(owner), readerId: await userIdOf(reader) });

  // The start: a saved strategy whose version 1 has a finished backtest with fees, slippage and delay set.
  await signIn(page, owner);
  await saveSignalStrategy(page);
  const strategyId = (await ok(owner, 'studio.list', { limit: 50 })).strategies.find((row) => row.name === NAME)?.id;
  expect(strategyId).toBeTruthy();
  run.write({ strategyId });
  await backtest(page, NAME);

  const panel = await publishPanel(page, strategyId);
  await expect(panel.getByText('You have not published this strategy.')).toBeVisible();
  const form = await fillPublish(panel, { description: `${CLEAN} ${CLAIM}`, checklist: true });
  await form.getByRole('button', { name: 'Run the checks' }).click();
  const rows = await checkRows(form);
  expect(rows).toEqual({ version: true, backtest: true, costs: true, claim: false, licence: true });
  const claimRow = form.locator('[data-testid="quant-listing-check"][data-check="claim"]');
  await expect(claimRow.getByTestId('quant-listing-check-detail')).toHaveText(`performance claim: "${CLAIM}"`);
  await expect(form.getByTestId('quant-listing-checks-summary')).toHaveText('A check failed. Nothing is listed.');

  // Publish refuses by the failing check and the sentence, on the screen and at the service; nothing is listed.
  await form.getByRole('button', { name: 'Publish', exact: true }).click();
  const refusal = form.getByTestId('quant-publish-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'quant.listing_check_failed');
  await expect(refusal).toHaveText(`A check failed, so nothing was listed: performance claim: "${CLAIM}".`);
  const options = await ok(owner, 'library.options', {});
  const direct = await quant(
    owner,
    'library.publish',
    {
      strategyId,
      strategyVersion: 1,
      title: TITLE,
      description: `${CLEAN} ${CLAIM}`,
      tags: ['trend'],
      visibility: 'open',
      licence: LICENCE,
      checklistVersion: options.checklist.version,
      checklistAccepted: true,
    },
    'POST',
  );
  expect(direct.status).toBe(412);
  expect(JSON.stringify(direct.body)).toContain(`quant.listing_check_failed — claim — performance claim: \\"${CLAIM}\\"`);
  expect((await ok(owner, 'library.mine', {})).listings.filter((row) => row.strategyId === strategyId)).toEqual([]);
  expect((await browseAll(reader)).some((row) => row.title === TITLE)).toBe(false);
  await expect(panel.getByText('You have not published this strategy.')).toBeVisible();
});

test(`${J} #2 fixes the text, picks visibility and a licence, accepts the checklist: every check passes; an unset licence list and a missing checklist refuse`, async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  const { owner, strategyId } = state();
  await signIn(page, owner);

  // With the owner's licence list blank, the screen says it is not set and the checks refuse by name.
  restartWithSetting('quant', 'LOCAL_STACK_QUANT_LIBRARY_LICENCES', 'off');
  try {
    const panel = await publishPanel(page, strategyId);
    await expect(panel.getByTestId('quant-licences-unset')).toHaveText('The licence list is not set, so nothing can be published.');
    const form = await fillPublish(panel, { checklist: true });
    await form.getByRole('button', { name: 'Run the checks' }).click();
    const refusal = form.getByTestId('quant-publish-refusal');
    await expect(refusal).toHaveAttribute('data-code', 'quant.library_licences_unset');
    await expect(refusal).toHaveText('The licence list is not set, so nothing can be published.');
    await expect(form.getByTestId('quant-listing-checks')).toHaveCount(0);
    const direct = await quant(owner, 'library.check', {
      strategyId,
      strategyVersion: 1,
      title: TITLE,
      description: CLEAN,
      tags: ['trend'],
      visibility: 'open',
      licence: LICENCE,
    });
    expect(direct.status).toBe(412);
    expect(JSON.stringify(direct.body)).toMatch(/quant\.library_licences_unset — /);
  } finally {
    restartWithSetting('quant', 'LOCAL_STACK_QUANT_LIBRARY_LICENCES', null);
  }

  // With the TEST list back, the fixed text passes every check.
  const panel = await publishPanel(page, strategyId);
  const licences = panel.getByRole('combobox', { name: 'Licence' });
  await expect(licences.locator('option')).toHaveText(['Pick a licence', 'TEST open licence', 'TEST all rights reserved']);
  const form = await fillPublish(panel, { checklist: false });
  await form.getByRole('button', { name: 'Run the checks' }).click();
  expect(await checkRows(form)).toEqual({ version: true, backtest: true, costs: true, claim: true, licence: true });
  await expect(form.getByTestId('quant-listing-checks-summary')).toHaveText('Every check passed.');
  await expect(form.locator('[data-check="claim"]').getByTestId('quant-listing-check-detail')).toHaveText('no performance claim');
  await expect(form.locator('[data-check="costs"]').getByTestId('quant-listing-check-detail')).toContainText(
    'slippage 5 bps, delay 0 bars',
  );

  // Without the realism checklist accepted, Publish refuses and nothing is listed.
  await expect(form.getByTestId('quant-realism-checklist').getByRole('checkbox')).toHaveCount(3);
  await form.getByRole('button', { name: 'Publish', exact: true }).click();
  const refusal = form.getByTestId('quant-publish-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'quant.realism_checklist_unaccepted');
  await expect(refusal).toHaveText('Accept every item of the realism checklist before publishing. Nothing was listed.');
  const options = await ok(owner, 'library.options', {});
  const direct = await quant(
    owner,
    'library.publish',
    {
      strategyId,
      strategyVersion: 1,
      title: TITLE,
      description: CLEAN,
      tags: ['trend'],
      visibility: 'open',
      licence: LICENCE,
      checklistVersion: options.checklist.version,
      checklistAccepted: false,
    },
    'POST',
  );
  expect(direct.status).toBe(412);
  expect(JSON.stringify(direct.body)).toMatch(/quant\.realism_checklist_unaccepted — /);
  expect((await ok(owner, 'library.mine', {})).listings.filter((row) => row.strategyId === strategyId)).toEqual([]);
});

test(`${J} #3 publishes, then saves a new version: the old listing shows as stale and cannot be re-listed without a new check`, async ({
  page,
}) => {
  test.setTimeout(20 * 60_000);
  const { owner, reader, strategyId } = state();
  await signIn(page, owner);
  let panel = await publishPanel(page, strategyId);
  let form = await fillPublish(panel, { checklist: true });
  await form.getByRole('button', { name: 'Run the checks' }).click();
  expect(Object.values(await checkRows(form)).every(Boolean)).toBe(true);
  await form.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(form.getByTestId('quant-publish-note')).toHaveText('Published version 1 to the library.');
  const first = panel.getByTestId('quant-my-listing');
  await expect(first).toHaveCount(1);
  await expect(first).toHaveAttribute('data-version', '1');
  await expect(first).toHaveAttribute('data-stale', 'false');
  await expect(first.getByTestId('quant-my-listing-state')).toHaveText('Listed');
  const [listed] = (await ok(owner, 'library.mine', {})).listings.filter((row) => row.strategyId === strategyId);
  expect(listed).toMatchObject({ strategyVersion: 1, stale: false, visibility: 'open', licence: LICENCE, tags: ['trend'] });
  expect((await browseAll(reader)).map((row) => row.listingId)).toContain(listed.listingId);

  // A new version in Studio.
  await page.goto('/quant/studio');
  const open = page.getByRole('button', { name: `Open ${NAME}` });
  await expect(open.or(page.getByText('Open in the form')).first()).toBeVisible();
  if (await open.isVisible()) await open.click();
  await expect(page.getByLabel('Strategy name')).toHaveValue(NAME);
  await page.getByTestId('quant-signal-builder').getByLabel('Slow average (bars)').fill('3');
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect(page.getByTestId('quant-save-state')).toHaveText('Saved as version 2.');

  // The old listing shows as stale, on the screen and at the service, and leaves the library.
  panel = await publishPanel(page, strategyId);
  const stale = panel.locator(`[data-testid="quant-my-listing"][data-listing-id="${listed.listingId}"]`);
  await expect(stale).toHaveAttribute('data-stale', 'true');
  await expect(stale.getByTestId('quant-my-listing-state')).toHaveText('Stale: version 2 is newer. Re-list needs a new check.');
  const [mine] = (await ok(owner, 'library.mine', {})).listings.filter((row) => row.listingId === listed.listingId);
  expect(mine).toMatchObject({ stale: true, strategyVersion: 1, headVersion: 2 });
  expect((await browseAll(reader)).map((row) => row.listingId)).not.toContain(listed.listingId);

  // Re-listing version 1 is refused; version 2 fails its own check until it has a backtest of its own.
  form = await fillPublish(panel, { version: 1, checklist: true });
  await form.getByRole('button', { name: 'Publish', exact: true }).click();
  let refusal = form.getByTestId('quant-publish-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'quant.listing_stale');
  await expect(refusal).toHaveText('Version 1 is not the newest. Run the checks for the newest version before listing it.');
  const options = await ok(owner, 'library.options', {});
  const body = (strategyVersion) => ({
    strategyId,
    strategyVersion,
    title: TITLE,
    description: CLEAN,
    tags: ['trend'],
    visibility: 'open',
    licence: LICENCE,
    checklistVersion: options.checklist.version,
    checklistAccepted: true,
  });
  const relist = await quant(owner, 'library.publish', body(1), 'POST');
  expect(relist.status).toBe(409);
  expect(JSON.stringify(relist.body)).toMatch(/quant\.listing_stale — version 1 is not the newest \(version 2\)/);
  await form.getByRole('combobox', { name: 'Version to publish' }).selectOption('2');
  await form.getByRole('button', { name: 'Run the checks' }).click();
  expect(await checkRows(form)).toMatchObject({ version: true, backtest: false, costs: false, claim: true, licence: true });
  await form.getByRole('button', { name: 'Publish', exact: true }).click();
  refusal = form.getByTestId('quant-publish-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'quant.listing_check_failed');
  await expect(refusal).toHaveText('A check failed, so nothing was listed: no finished backtest of version 2.');
  expect((await ok(owner, 'library.mine', {})).listings.filter((row) => row.strategyId === strategyId)).toHaveLength(1);

  // A backtest of version 2 and a new check list it again, as a new listing; the old one stays stale.
  await backtest(page, NAME);
  panel = await publishPanel(page, strategyId);
  form = await fillPublish(panel, { version: 2, checklist: true });
  await form.getByRole('button', { name: 'Run the checks' }).click();
  expect(Object.values(await checkRows(form)).every(Boolean)).toBe(true);
  await form.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(form.getByTestId('quant-publish-note')).toHaveText('Published version 2 to the library.');
  const listings = (await ok(owner, 'library.mine', {})).listings.filter((row) => row.strategyId === strategyId);
  expect(listings.map((row) => [row.strategyVersion, row.stale])).toEqual([
    [1, true],
    [2, false],
  ]);
  run.write({ listingA: listings[1].listingId });
});

test(`${J} #4 as another person opens the library and filters by tag: open strategies in registration order; no control sorts by return`, async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  const { owner, reader, listingA } = state('listingA');
  const b = await listedThroughApi(owner, 'TEST library momentum', ['momentum'], 'open');
  const c = await listedThroughApi(owner, 'TEST library trend swing', ['trend', 'swing'], 'open');
  run.write({ listingB: b.listingId, listingC: c.listingId });

  await signIn(page, reader);
  await page.goto('/quant/library');
  const library = page.getByTestId('quant-library');
  await expect(library.getByTestId('quant-library-row').first()).toBeVisible();
  async function shownIds() {
    for (let i = 0; i < 50; i++) {
      const more = library.getByRole('button', { name: 'Show more' });
      if (!(await more.isVisible())) break;
      const count = await library.getByTestId('quant-library-row').count();
      await more.click();
      await expect.poll(() => library.getByTestId('quant-library-row').count()).toBeGreaterThan(count);
    }
    return library.getByTestId('quant-library-row').evaluateAll((els) => els.map((el) => el.getAttribute('data-listing-id')));
  }

  // Every open listing, in registration order: the screen's order is the service's, which is oldest first.
  const all = await browseAll(reader);
  const shown = await shownIds();
  expect(shown).toEqual(all.map((row) => row.listingId));
  const listedAt = all.map((row) => Date.parse(row.listedAt));
  expect(listedAt).toEqual([...listedAt].sort((x, y) => x - y));
  const mine = shown.filter((id) => [listingA, b.listingId, c.listingId].includes(id));
  expect(mine).toEqual([listingA, b.listingId, c.listingId]);
  expect(all.every((row) => row.visibility === 'open' || row.visibility === 'protected')).toBe(true);

  // A filter by tag narrows it, still in registration order.
  await library.getByRole('combobox', { name: 'Filter by tag' }).selectOption('trend');
  await expect(library).toHaveAttribute('data-tag', 'trend');
  await expect(library.getByTestId('quant-library-row').first()).toBeVisible();
  const trend = await shownIds();
  expect(trend).toEqual((await browseAll(reader, 'trend')).map((row) => row.listingId));
  const tags = await library.getByTestId('quant-library-row').evaluateAll((els) => els.map((el) => el.getAttribute('data-tags')));
  expect(tags.every((value) => value.split(' ').includes('trend'))).toBe(true);
  expect(trend.filter((id) => [listingA, b.listingId, c.listingId].includes(id))).toEqual([listingA, c.listingId]);

  // No control sorts by return: the one control is the tag filter, no column is a return, and the rows carry none.
  const controls = library.locator('select, button, input');
  const labels = await controls.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? el.textContent ?? ''));
  expect(labels.join(' ')).not.toMatch(/sort|return|profit|performance|rank/i);
  await expect(library.getByRole('combobox')).toHaveCount(1);
  const options = await library.getByRole('combobox', { name: 'Filter by tag' }).locator('option').allTextContents();
  expect(options).toEqual(['All tags', 'Trend', 'Mean reversion', 'Momentum', 'Breakout', 'Swing', 'Scalping']);
  const headers = await library.getByRole('columnheader').allTextContents();
  expect(headers.join(' ')).not.toMatch(/return|profit|net|equity|performance/i);
  expect(Object.keys(all[0]).sort()).toEqual([
    'licence',
    'listedAt',
    'listingId',
    'ownerId',
    'strategyVersion',
    'tags',
    'title',
    'visibility',
  ]);
});

test(`${J} #5 opens an invite-only listing without access: the title and Request access, no results; after the owner grants it opens and after revoke the next read refuses`, async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  const { owner, reader, readerId } = state('readerId');
  const d = await listedThroughApi(owner, 'TEST library invite only', ['breakout'], 'invite');
  run.write({ listingD: d.listingId });
  expect((await browseAll(reader)).map((row) => row.listingId)).not.toContain(d.listingId);

  // Without access: the title and Request access; no result, no source, and the page read refuses.
  await signIn(page, reader);
  await page.goto(`/quant/library/${d.listingId}`);
  const listing = page.getByTestId('quant-listing');
  await expect(listing).toHaveAttribute('data-access', 'none');
  await expect(page.getByRole('heading', { name: 'TEST library invite only' })).toBeVisible();
  await expect(listing.getByRole('button', { name: 'Request access' })).toBeVisible();
  await expect(listing.getByTestId('quant-listing-result')).toHaveCount(0);
  await expect(listing.getByTestId('quant-listing-source')).toHaveCount(0);
  await expect(listing.getByTestId('quant-listing-description')).toHaveCount(0);
  let read = await quant(reader, 'library.get', { listingId: d.listingId });
  expect(read.status).toBe(403);
  expect(JSON.stringify(read.body)).toMatch(/quant\.listing_access_denied — /);
  await listing.getByRole('button', { name: 'Request access' }).click();
  await expect(listing.getByTestId('quant-access-requested')).toHaveText('Access requested. The owner decides.');
  await expect(listing).toHaveAttribute('data-access', 'requested');

  // The owner sees the request and grants it.
  await signIn(page, owner);
  let panel = await publishPanel(page, d.strategyId);
  const row = panel.locator(`[data-testid="quant-access-row"][data-user="${readerId}"]`);
  await expect(row).toHaveAttribute('data-state', 'requested');
  await row.getByRole('button', { name: `Grant ${readerId}` }).click();
  await expect(row).toHaveAttribute('data-state', 'granted');

  // Granted: it opens, with its stored result and its source.
  await signIn(page, reader);
  await page.goto(`/quant/library/${d.listingId}`);
  await expect(listing).toHaveAttribute('data-access', 'granted');
  const opened = listing.getByTestId('quant-listing-page');
  await expect(opened.getByTestId('quant-listing-result')).toContainText('Historical simulation — not a forecast');
  await expect(opened.getByTestId('quant-listing-source')).toHaveText((await ok(owner, 'studio.get', { id: d.strategyId })).source);
  expect((await ok(reader, 'library.get', { listingId: d.listingId })).listingId).toBe(d.listingId);

  // Revoked: the next read refuses, at the service and on the screen.
  await signIn(page, owner);
  panel = await publishPanel(page, d.strategyId);
  await panel
    .locator(`[data-testid="quant-access-row"][data-user="${readerId}"]`)
    .getByRole('button', { name: `Revoke ${readerId}` })
    .click();
  await expect(panel.locator(`[data-testid="quant-access-row"][data-user="${readerId}"]`)).toHaveAttribute('data-state', 'revoked');
  read = await quant(reader, 'library.get', { listingId: d.listingId });
  expect(read.status).toBe(403);
  expect(JSON.stringify(read.body)).toMatch(/quant\.listing_access_denied — /);
  await signIn(page, reader);
  await page.goto(`/quant/library/${d.listingId}`);
  await expect(listing).toHaveAttribute('data-access', 'revoked');
  const refused = listing.getByTestId('quant-listing-refusal');
  await expect(refused).toHaveAttribute('data-code', 'quant.listing_access_denied');
  await expect(refused).toHaveText('Your access was revoked. This listing is invite only and you hold no grant from its owner.');
  await expect(listing.getByTestId('quant-listing-source')).toHaveCount(0);
});

test(`${J} #6 presses Clone on an open strategy: a new draft in the caller's library with lineage; the source of a protected strategy is never returned`, async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  const { owner, reader, strategyId, listingA } = state('listingA');
  const before = (await ok(reader, 'studio.list', { limit: 50 })).strategies.length;

  await signIn(page, reader);
  await page.goto(`/quant/library/${listingA}`);
  const listing = page.getByTestId('quant-listing-page');
  const source = (await ok(owner, 'studio.get', { id: strategyId })).versions.find((row) => row.version === 2);
  await expect(listing.getByTestId('quant-listing-source')).toHaveText(source.source);
  await listing.getByRole('button', { name: 'Clone to my library' }).click();
  await expect(listing.getByTestId('quant-clone-note')).toHaveText('Cloned as a new draft in your library.');
  const link = listing.getByTestId('quant-clone-link');
  const cloneId = await link.getAttribute('data-strategy-id');
  expect(cloneId).toBeTruthy();
  run.write({ cloneId });

  // The clone: a new strategy of the reader's at version 1, a draft, with the listed version's rules and its lineage.
  await link.click();
  const lineage = page.getByTestId('quant-lineage');
  await expect(lineage).toHaveAttribute('data-listing-id', listingA);
  await expect(lineage).toHaveAttribute('data-source-version', '2');
  await expect(lineage).toContainText(`Cloned from the library listing ${TITLE}, version 2`);
  const copy = await ok(reader, 'studio.get', { id: cloneId });
  expect(copy.versions).toHaveLength(1);
  expect(copy.modules).toEqual(source.modules);
  expect(copy.source).toBe(source.source);
  expect(copy.name).toBe(`${source.name} copy`);
  expect((await ok(reader, 'studio.list', { limit: 50 })).strategies).toHaveLength(before + 1);
  expect((await ok(reader, 'lifecycle.get', { strategyId: cloneId, strategyVersion: 1 })).stage).toBe('draft');
  expect((await ok(reader, 'library.lineage', { strategyId: cloneId })).lineage).toMatchObject({ listingId: listingA, sourceVersion: 2 });

  // A protected strategy: the page never shows its source, the service never returns it, and Clone refuses.
  const e = await listedThroughApi(owner, 'TEST library protected', ['swing'], 'protected');
  const hidden = (await ok(owner, 'studio.get', { id: e.strategyId })).source;
  await page.goto(`/quant/library/${e.listingId}`);
  await expect(listing.getByTestId('quant-listing-source-protected')).toHaveText(
    'The source of a protected strategy is never shown or copied.',
  );
  await expect(listing.getByTestId('quant-listing-source')).toHaveCount(0);
  const read = await quant(reader, 'library.get', { listingId: e.listingId });
  expect(read.status).toBe(200);
  expect(read.data.source).toBeNull();
  expect(JSON.stringify(read.body)).not.toContain(hidden);
  await listing.getByRole('button', { name: 'Clone to my library' }).click();
  const refusal = listing.getByTestId('quant-clone-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'quant.listing_source_protected');
  await expect(refusal).toHaveText('This strategy is protected: its source is never copied. Nothing was cloned.');
  const clone = await quant(reader, 'library.clone', { listingId: e.listingId }, 'POST');
  expect(clone.status).toBe(403);
  expect(JSON.stringify(clone.body)).not.toContain(hidden);
  expect((await ok(reader, 'studio.list', { limit: 50 })).strategies).toHaveLength(before + 1);
});

test(`${J} #7 reviews a strategy never run: the refusal that a review needs a run first; after running it the review is accepted`, async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  const { reader, readerId, listingA, cloneId } = state('readerId', 'listingA', 'cloneId');
  const REVIEW = 'TEST The rules are clear and the costs are shown.';
  expect((await ok(reader, 'backtest.history', { limit: 20, strategyId: cloneId })).runs).toHaveLength(0);

  await signIn(page, reader);
  await page.goto(`/quant/library/${listingA}`);
  const listing = page.getByTestId('quant-listing-page');
  let form = listing.getByTestId('quant-review-form');
  await form.getByLabel('Your review').fill(REVIEW);
  await form.getByRole('button', { name: 'Send review' }).click();
  const refusal = form.getByTestId('quant-review-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'quant.review_needs_run');
  await expect(refusal).toHaveText('A review needs a finished run of your own clone first. Clone it and run a backtest, then review it.');
  const direct = await quant(reader, 'library.review', { listingId: listingA, text: REVIEW }, 'POST');
  expect(direct.status).toBe(412);
  expect(JSON.stringify(direct.body)).toMatch(/quant\.review_needs_run — /);
  expect((await ok(reader, 'library.get', { listingId: listingA })).reviews).toEqual([]);

  // After running the clone, the review is accepted and shown.
  const copy = await ok(reader, 'studio.get', { id: cloneId });
  await backtest(page, copy.name);
  await page.goto(`/quant/library/${listingA}`);
  form = listing.getByTestId('quant-review-form');
  await form.getByLabel('Your review').fill(REVIEW);
  await form.getByRole('button', { name: 'Send review' }).click();
  await expect(form.getByTestId('quant-review-note')).toHaveText('Your review is saved.');
  const shown = listing.locator(`[data-testid="quant-listing-review"][data-reviewer="${readerId}"]`);
  await expect(shown).toContainText(REVIEW);
  const reviews = (await ok(reader, 'library.get', { listingId: listingA })).reviews;
  expect(reviews).toEqual([expect.objectContaining({ reviewerId: readerId, text: REVIEW })]);
});
