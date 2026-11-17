// The paper-run helpers J-algo-dev-04's files share (J-algo-dev-04.pw.mjs, -start, -alerts): one TEST developer's
// signal-rules strategy on 1 minute bars of BTC/USDT, its paper runs and its fill notices, read through Edge. Every figure
// is paper; nothing here moves money.
import { expect } from './journey.mjs';
import { api } from './stack.mjs';

export const NAME = 'TEST paper alerts';
export const LABEL = 'Paper — not live performance';

export const dataOf = (body) => body?.result?.data?.json ?? body?.result?.data;

/** A signed-in read of one of the developer's own procedures, through Edge. */
export async function read(who, service, procedure, input) {
  const client = await api(who);
  const res = await client.get(`/api/${service}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`);
  expect(res.status, `${procedure}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
  return dataOf(res.body);
}

/** The developer's paper strategy fill notices, as svc-notify stores them. */
export async function fillNotices(who) {
  const list = await read(who, 'notify', 'notify.list', { limit: 100 });
  return list.items.filter((item) => item.kind === 'quant.fill');
}

/** The run's fills made at or after the alert was created: the ones the alert announces. */
export async function announcedFills(who, runId, since) {
  const paper = await read(who, 'quant', 'paper.get', { runId });
  return paper.trades.filter((trade) => Date.parse(trade.ts) >= Date.parse(since));
}

/** Saves a new signal-rules strategy on 1 minute bars of BTC/USDT at version 1. Every figure is a TEST simulation input. */
export async function saveSignalStrategy(page) {
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

/** The strategy id of the developer's only saved strategy, read from the library. */
export async function savedStrategyId(page) {
  await page.goto('/quant/strategies');
  const strategyId = await page.getByTestId('quant-strategy-row').first().getAttribute('data-id');
  expect(strategyId).toBeTruthy();
  return strategyId;
}

export async function openStrategy(page, strategyId) {
  await page.goto(`/quant/strategies/${encodeURIComponent(strategyId)}`);
  await expect(page.getByTestId('quant-paper')).toBeVisible();
  return page.getByTestId('quant-paper');
}

/** Opens the start dialog and fills it: TEST cash (blank when given ''), no holdings, our own prices, taker, 5 bp, 0 bars. */
export async function startForm(paper, { cash = '1000', feed = 'own_venue' } = {}) {
  await paper.getByRole('button', { name: 'Start a paper run' }).click();
  const form = paper.getByTestId('quant-paper-start');
  await form.getByLabel('Starting cash (simulated)').fill(cash);
  await expect(form.getByTestId('quant-paper-holdings')).toHaveText('Starting holdings: None: the run starts from cash only.');
  await form.getByRole('combobox', { name: /^Price data/ }).selectOption(feed);
  await form.getByRole('combobox', { name: /^Fee rate/ }).selectOption('taker');
  await form.getByLabel('Slippage (basis points)').fill('5');
  await form.getByLabel('Delay (bars)').fill('0');
  return form;
}

export const runRows = (paper) => paper.getByTestId('quant-paper-run');

/** Stops one of the developer's paper runs through Edge: it places no new order, and its record stays. */
export async function stopRun(who, runId) {
  const client = await api(who);
  const res = await client.post('/api/quant/trpc/paper.stop', { runId });
  expect(res.status, `paper.stop: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
  expect(dataOf(res.body).state).toBe('stopped');
}
