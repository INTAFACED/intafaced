// World: none
import { test, expect } from './journey.mjs';
import { journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { closedBarsSince, tapeWindow } from './tape.mjs';

// J-algo-dev-05, in the running app (docs/roadmap/journeys.json): a strategy's orders obey order types, sizing and risk
// settings. One test per step, titled "J-algo-dev-05 #<n>", on one TEST developer who starts signed in with a strategy
// running as a backtest (the bar backtest room) or on paper (the sandbox's paper run). Written by an independent
// test-writer from the step's words (OWNER 212). Every figure is simulated; nothing here moves money.
// This file holds the steps the app already passes; the rest are in the unbuilt-steps draft PR.
const J = 'J-algo-dev-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

/** Signs the journey's TEST developer in, making and verifying them on the first step that runs. */
async function developer(page) {
  let who = run.read().account;
  if (!who) {
    who = await signUp(page, 'jo');
    await verify(page, who);
    run.reset({ account: who });
  }
  await signIn(page, who);
  return who;
}

/** Saves a new signal-rules strategy on 1 minute bars of BTC/USDT at version 1. Every figure is a TEST simulation input. */
async function saveSignalStrategy(page, name, { stopLoss = '', takeProfit = '', size = '0.01' } = {}) {
  await page.goto('/quant/studio');
  const fresh = page.getByRole('button', { name: 'Start a new strategy' });
  if (await fresh.isVisible()) await fresh.click();
  await page.getByLabel('Strategy name').fill(name);
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
  await builder.getByLabel('Size', { exact: true }).fill(size);
  await builder.getByLabel('Stop loss (percent, optional)', { exact: true }).fill(stopLoss);
  await builder.getByLabel('Take profit (percent, optional)', { exact: true }).fill(takeProfit);
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect(page.getByTestId('quant-save-state')).toHaveText('Saved as version 1.');
}

/** Runs a saved strategy in the bar backtest room on a window of the TEST tape, with no slippage and no delay. */
async function backtest(page, strategy, window) {
  await page.goto('/quant/backtest');
  const room = page.getByTestId('quant-bar-backtest');
  await room.getByRole('combobox', { name: /^Strategy/ }).selectOption({ label: strategy });
  await room.getByLabel('From (UTC)').fill(window.from);
  await room.getByLabel('To (UTC)').fill(window.to);
  await room.getByRole('combobox', { name: /^Fill a signal at/ }).selectOption('next_open');
  await room.getByRole('combobox', { name: /^Fee rate/ }).selectOption('taker');
  await room.getByLabel('Delay (bars)').fill('0');
  await room.getByLabel('Slippage (basis points)').fill('0');
  await room.getByTestId('quant-backtest-run').click();
  await expect(room.getByTestId('quant-bar-result')).toBeVisible();
  return room;
}

test(`${J} #3 attaches a take profit and a stop loss and runs a bar that hits both: the stop fills first and the result says the pessimistic rule applied`, async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  await developer(page);
  // A stop loss and a take profit a thousandth of a percent either side of the entry: a TEST bar that moves at all
  // both ways from its open reaches both.
  const STOP = '0.001';
  const TARGET = '0.001';
  await saveSignalStrategy(page, 'TEST both exits', { stopLoss: STOP, takeProfit: TARGET });
  const window = await tapeWindow(60);
  const room = await backtest(page, 'TEST both exits', window);

  // Each stop-loss exit is paired with the entry before it; on the bar it filled, the tape reached the take profit too.
  const bars = new Map((await closedBarsSince(window.from)).map(([at, open, high, low]) => [at, { open, high, low }]));
  const rows = await room
    .getByTestId('quant-bar-trade')
    .evaluateAll((els) =>
      els.map((el) => ({ ts: el.dataset.ts, side: el.dataset.side, cells: [...el.querySelectorAll('td')].map((td) => td.textContent) })),
    );
  const both = [];
  for (let i = 1; i < rows.length; i++) {
    const [entry, exit] = [rows[i - 1], rows[i]];
    if (entry.side !== 'buy' || exit.side !== 'sell' || exit.cells[2] !== 'Stop loss') continue;
    const bar = bars.get(Date.parse(exit.ts));
    if (!bar) continue;
    const entered = Number(entry.cells[5]);
    const target = entered * (1 + Number(TARGET) / 100);
    const stop = entered * (1 - Number(STOP) / 100);
    if (bar.high >= target && bar.low <= stop) both.push({ exit, stop, bar });
  }
  expect(both.length, 'no bar in the window reached both the stop loss and the take profit of an open position').toBeGreaterThan(0);

  // The stop filled first: the exit on that bar is the stop loss, at the stop (or the open, had the bar gapped past
  // it), and no take-profit exit shares its bar.
  for (const { exit, stop, bar } of both) {
    const price = Number(exit.cells[5]);
    expect(price).toBeCloseTo(bar.open <= stop ? bar.open : stop, 6);
    expect(rows.filter((r) => r.ts === exit.ts && r.cells[2] === 'Take profit')).toHaveLength(0);
  }
  // The result says the pessimistic rule applied.
  await expect(room.getByTestId('quant-bar-assumptions').locator('[data-assumption="stop_loss_first"]')).toHaveText(
    'A bar reached both the stop loss and the take profit; the stop loss was taken first.',
  );
});
