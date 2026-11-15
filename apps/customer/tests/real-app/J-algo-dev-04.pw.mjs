// World: book
// Market: live
import { test, expect } from './journey.mjs';
import { journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { tapeWindow } from './tape.mjs';
import { NAME, openStrategy, read, runRows, saveSignalStrategy, startForm } from './paper-strategy.mjs';

// J-algo-dev-04, in the running app (docs/roadmap/journeys.json): run a strategy on paper with the exchange's own prices
// and get notified. One test per step, titled "J-algo-dev-04 #<n>", on a TEST developer who starts signed in with a saved
// signal-rules strategy version and a completed backtest. The paper run trades on the local TEST market maker's own 1 minute
// bars of BTC/USDT; every figure is paper and nothing here moves money (svc-quant imports no ledger client).
// The journey runs in three files, each on its own TEST developer, so no one file holds a shard for long: this one holds
// #1; J-algo-dev-04-start.pw.mjs holds #2 to #4 (the run #2 starts, which #3 and #4 count); J-algo-dev-04-alerts.pw.mjs
// holds #5 to #8 (the channels #5 saves, the alert #6 adds, the fills #7 waits for and the stop #8 makes, on one run).
const J = 'J-algo-dev-04';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

test(`${J} #1 opens the strategy and starts a paper run with starting cash left blank: a refusal naming the cash; nothing starts`, async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  const who = await signUp(page, 'jp');
  await verify(page, who);
  run.reset({ account: who });
  await signIn(page, who);
  await saveSignalStrategy(page);
  await page.goto('/quant/strategies');
  const strategyId = await page.getByTestId('quant-strategy-row').first().getAttribute('data-id');
  expect(strategyId).toBeTruthy();

  // The journey starts from a completed backtest of the saved version, on the TEST tape's last half hour.
  const window = await tapeWindow(30);
  await page.goto('/quant/backtest');
  const room = page.getByTestId('quant-bar-backtest');
  await room.getByRole('combobox', { name: /^Strategy/ }).selectOption({ label: NAME });
  await room.getByLabel('From (UTC)').fill(window.from);
  await room.getByLabel('To (UTC)').fill(window.to);
  await room.getByRole('combobox', { name: /^Fill a signal at/ }).selectOption('next_open');
  await room.getByRole('combobox', { name: /^Fee rate/ }).selectOption('taker');
  await room.getByLabel('Delay (bars)').fill('0');
  await room.getByLabel('Slippage (basis points)').fill('5');
  await room.getByTestId('quant-backtest-run').click();
  await expect(room.getByTestId('quant-bar-result')).toBeVisible({ timeout: 60_000 });
  run.write({ strategyId });

  // Start with the cash blank: the refusal names the cash, next to it, and no run is added.
  const paper = await openStrategy(page, strategyId);
  await expect(paper.getByText('This strategy has no paper run yet.')).toBeVisible();
  const form = await startForm(paper, { cash: '' });
  await form.getByRole('button', { name: 'Start', exact: true }).click();
  const refusal = form.getByTestId('quant-paper-refusal');
  await expect(refusal).toHaveAttribute('data-input', 'cash');
  await expect(refusal).toHaveAttribute('data-code', 'quant.paper_cash_unset');
  await expect(refusal).toContainText('Starting cash: starting cash is unset; no amount is assumed. Nothing was started.');
  await page.reload();
  await expect(paper.getByText('This strategy has no paper run yet.')).toBeVisible();
  await expect(runRows(paper)).toHaveCount(0);
  expect((await read(who, 'quant', 'paper.list', { strategyId, limit: 50 })).runs).toEqual([]);
});
