// World: book, stack
import { readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState, toUnits, tool } from './stack.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-derivatives-17, in the running app (docs/roadmap/journeys.json; the row in project-state
// operation-zero/modules/derivatives/acceptance/journeys.md): a finance operator reconciles futures P&L, funding and
// settlement against the ledger on the founder console's treasury desk (/ledger/treasury). One test per step, titled
// "J-derivatives-17 #<n>". The operator is the stack's LOCAL TEST founder A (admin.mjs).
// Reconciliation reads and compares only: no step here corrects anything, and a correction is a separate approved ledger
// action (the journey's money line), so the desk offers no "fix" control on a mismatch.
// The premise ("a period of TEST futures activity", a funding leg in the ledger but not in the plan, a settlement the
// payout port refused) is put in place by the stack's own world tool, `populate --only futures-recon`, which prints one
// JSON line naming the period and the planted keys: {"period":…,"fundingLeg":{"key":…,"amount":…,"asset":…},
// "refusedSettlement":{"key":…,"reason":…}}. The payout side waits on `owner.decision` (the futures payout model), so
// the refused settlement is the honest state, not a stand-in for a payout.
// Written by a test-writer from the step's words, before the feature (OWNER 212): a step whose room, control or world
// step is not built fails at its first missing part, quickly (UNBUILT), and is listed in docs/runbooks/journey-baseline.json.
const J = 'J-derivatives-17';
const UNBUILT = { timeout: 5_000 };
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

/** The planted premise, made once per run and kept in the run file, so a worker restart reads the same period and keys. */
function premise() {
  const kept = run.read();
  if (kept.period) return kept;
  const out = tool('local-test-world.mjs', 'populate', '--only', 'futures-recon').trim().split('\n').at(-1) ?? '';
  return run.reset(JSON.parse(out));
}

const signedIn = new WeakSet();
async function openRecon(page) {
  const { period } = premise();
  if (!signedIn.has(page)) await founderSignIn(page, 'a');
  signedIn.add(page);
  await page.goto(`${ADMIN}/ledger/treasury`);
  await expect(page.getByRole('heading', { name: 'Treasury', level: 1 })).toBeVisible(UNBUILT);
  await page.getByRole('tab', { name: 'Futures recon' }).click(UNBUILT);
  await page.getByRole('combobox', { name: 'Period' }).selectOption(period);
  return period;
}

const totals = (page) => tableIn(page, 'Futures totals against the ledger');
const totalRow = (page, leg) => bodyRows(totals(page)).filter({ has: page.getByRole('cell', { name: leg, exact: true }) });
const mismatches = (page) => tableIn(page, 'Mismatches');

test(`${J} #1 opens futures recon for a period: totals of P&L, funding and settlement agree with the ledger, and a matched row is green`, async ({
  page,
}) => {
  await openRecon(page);
  await expect(totals(page).getByRole('columnheader')).toHaveText(['Leg', 'Plan', 'Ledger', 'Difference', 'State']);
  for (const leg of ['P&L', 'Funding', 'Settlement']) {
    const row = totalRow(page, leg);
    await expect(row).toHaveCount(1);
    const [, plan, ledger, difference, state] = (await row.getByRole('cell').allTextContents()).map((c) => c.trim());
    // Each total is an exact decimal (never a sample figure); the difference is ledger minus plan, to the unit.
    for (const figure of [plan, ledger, difference]) expect(figure).toMatch(/^-?[\d,]+(\.\d+)?( [A-Z]+)?$/);
    const units = (s) => toUnits(s.replace(/,/g, '').replace(/ [A-Z]+$/, ''));
    expect(units(difference)).toBe(units(ledger) - units(plan));
    if (units(difference) === 0n) {
      // Matched: the row says so and is drawn green.
      expect(state).toBe('Matched');
      await expect(row).toHaveAttribute('data-state', 'matched');
      await expect(row.getByTestId('recon-state')).toHaveClass(/\bpos\b|\bsuccess\b|\bgreen\b/);
    } else {
      expect(state).toBe('Mismatch');
      await expect(row).toHaveAttribute('data-state', 'mismatch');
    }
  }
  // The planted period has P&L that agrees: its row is green.
  await expect(totalRow(page, 'P&L')).toHaveAttribute('data-state', 'matched');
  // Reading changes nothing: there is no correcting control on the recon.
  await expect(page.getByRole('button', { name: /^(Fix|Correct|Post|Adjust)\b/ })).toHaveCount(0);
});

test(`${J} #2 a funding leg in the ledger but not in the plan: the mismatch shows its key and amount`, async ({ page }) => {
  await openRecon(page);
  const { fundingLeg } = premise();
  const row = bodyRows(mismatches(page)).filter({ hasText: fundingLeg.key });
  await expect(row).toHaveCount(1, UNBUILT);
  await expect(row.getByTestId('mismatch-key')).toHaveText(fundingLeg.key);
  await expect(row.getByTestId('mismatch-amount')).toHaveText(new RegExp(`^${fundingLeg.amount.replace('.', '\\.')} ${fundingLeg.asset}$`));
  await expect(row.getByTestId('mismatch-kind')).toHaveText('In the ledger, not in the plan');
  // The funding total no longer agrees, and its row is not green.
  await expect(totalRow(page, 'Funding')).toHaveAttribute('data-state', 'mismatch');
});

test(`${J} #3 a settlement the payout port refused: the refusal and its reason are in the recon list`, async ({ page }) => {
  await openRecon(page);
  const { refusedSettlement } = premise();
  const row = bodyRows(tableIn(page, 'Recon list')).filter({ hasText: refusedSettlement.key });
  await expect(row).toHaveCount(1, UNBUILT);
  await expect(row.getByTestId('recon-item-state')).toHaveText('Refused');
  await expect(row.getByTestId('recon-item-reason')).toHaveText(refusedSettlement.reason);
});

test(`${J} #4 opens the funding recon desk: each period's legs and nets, including the pro-rata scale-down and shortfall`, async ({
  page,
}) => {
  const period = await openRecon(page);
  await page.getByRole('tab', { name: 'Funding recon' }).click(UNBUILT);
  const periods = tableIn(page, 'Funding periods');
  await expect(periods.getByRole('columnheader')).toHaveText([
    'Period',
    'Market',
    'Paid by longs',
    'Paid by shorts',
    'Net',
    'Scale-down',
    'Shortfall',
  ]);
  const rows = bodyRows(periods).filter({ hasText: period });
  expect(await rows.count(), 'the planted period has funding legs').toBeGreaterThan(0);
  for (const row of await rows.all()) {
    const [, , longs, shorts, net, scale, shortfall] = (await row.getByRole('cell').allTextContents()).map((c) => c.trim());
    const units = (s) => toUnits(s.replace(/,/g, '').replace(/ [A-Z]+$/, ''));
    // The net is what the payers paid less what the receivers got; a scale-down is a ratio, and a shortfall an amount.
    expect(units(net)).toBe(units(longs) - units(shorts));
    expect(scale).toMatch(/^(None|\d+(\.\d+)?%)$/);
    expect(shortfall).toMatch(/^(None|[\d,]+(\.\d+)? [A-Z]+)$/);
    // A period scaled down pro rata names its shortfall; one not scaled down has none.
    if (scale === 'None') expect(shortfall).toBe('None');
    else expect(shortfall).not.toBe('None');
  }
  // Each row opens its legs: one per account, with the business key it was posted under.
  await rows.first().getByRole('button', { name: 'Legs' }).click();
  const legs = bodyRows(tableIn(page, 'Funding legs'));
  expect(await legs.count()).toBeGreaterThan(0);
  for (const key of await legs.getByTestId('leg-key').allTextContents()) expect(key.trim()).toMatch(/^funding:/);
});

test(`${J} #5 exports bills for the period: a file whose rows match the ledger`, async ({ page }) => {
  await openRecon(page);
  // What the ledger holds for the period, as the recon reads it (#1's Ledger column).
  const ledgerTotals = {};
  for (const leg of ['P&L', 'Funding', 'Settlement']) {
    const cells = (await totalRow(page, leg).getByRole('cell').allTextContents()).map((c) => c.trim());
    ledgerTotals[leg] = toUnits(cells[2].replace(/,/g, '').replace(/ [A-Z]+$/, ''));
  }
  const [download] = await Promise.all([
    page.waitForEvent('download', UNBUILT),
    page.getByRole('button', { name: 'Export bills' }).click(UNBUILT),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.csv$/);
  const text = readFileSync(await download.path(), 'utf8')
    .trim()
    .split('\n');
  const header = text[0].split(',');
  for (const col of ['key', 'kind', 'account', 'asset', 'amount']) expect(header).toContain(col);
  const rows = text.slice(1).map((line) => Object.fromEntries(line.split(',').map((v, i) => [header[i], v])));
  expect(rows.length).toBeGreaterThan(0);
  // Every row is a ledger posting with its business key; the rows of each kind sum to the ledger's total for it.
  const kinds = { 'P&L': 'pnl', Funding: 'funding', Settlement: 'settlement' };
  for (const [leg, kind] of Object.entries(kinds)) {
    const sum = rows.filter((r) => r.kind === kind).reduce((acc, r) => acc + toUnits(r.amount), 0n);
    expect(sum, `${leg} rows sum to the ledger's ${leg} total`).toBe(ledgerTotals[leg]);
  }
  for (const r of rows) expect(r.key).toMatch(/^[a-z-]+:[^\s]+$/);
});
