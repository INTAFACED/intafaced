// World: book, restart
import { test, expect } from './journey.mjs';
import { api, fund, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { venueForThisFile } from './venue.mjs';

// J-wallet-01's custodial check: today's custodial Deposit (`/uc/recharge`) and Withdraw (`/uc/withdraw`) pickers held to
// the asset registry, with a retired coin the person holds on our ledger (TEST funds through `local:fund`). That needs a
// ledger-funded person, so it is a custody-on check by design and this part file keeps today's custody switch
// (launch-custody.mjs, a `-custodial` part file), while J-wallet-01.pw.mjs runs the steps custody off, as launch does.
// It is no step: #5 holds the venue deposit and the venue withdrawal to the list. Every figure is TEST.
const J = 'J-wallet-01';
const run = journeyState(`${J}-custodial-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function account() {
  const s = run.read();
  if (!s.account) throw new Error(`${J}'s custodial TEST setup made no account, so this check has no one to act as`);
  return s.account;
}

test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account) return;
  test.setTimeout(180_000);
  const page = await browser.newPage();
  try {
    const who = await signUp(page, 'jwc');
    await verify(page, who);
    run.reset({ account: who });
  } finally {
    await page.close();
  }
});

const RETIRED = 'TESTRETIRED';
/** The select inside the form field of `scope` whose own caption is exactly `caption` (a panel of the same title is not the field). */
const picker = (scope, caption) =>
  scope
    .locator('label')
    .filter({ has: scope.page().getByText(caption, { exact: true }) })
    .getByRole('combobox');
/** A decimal string as the customer app writes it: the whole part grouped by thousands, the fraction as given. */
const grouped = (value) => {
  const [whole, fraction] = String(value).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''}`;
};

test('custodial Deposit and Withdraw pickers match the asset registry', async ({ page }) => {
  // Kept apart from J-wallet-01 #5 so the parked custodial rooms stay guarded without placing them in #5's beta screens.
  test.setTimeout(180_000);
  const who = account();
  const credit = fund(who.email, RETIRED, '5', `jw01-pick-${who.email.split('@')[0].replace(/[^A-Za-z0-9-]/g, '')}`.slice(0, 64));
  expect(credit.out).toMatch(/TEST FUNDS credited/);
  const customer = await api(who);
  const read = async (procedure) => {
    const { status, body } = await customer.get(`/api/bank/trpc/${procedure}`);
    expect(status, `${procedure}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
    return body.result.data;
  };
  const { assets: listed } = await read('assets.list');
  const withdrawable = await read('ramps.destinations.networks');
  const deposits = await read('deposits.assets');
  const row = (id) => listed.find((asset) => asset.assetId === id);

  await signIn(page, who);
  await page.goto('/uc/recharge');
  await page.mouse.move(0, 600);
  // Deposit's own pickers use those rows: its coins are the ones the list lets in (and any whose pairs are switched off,
  // shown with their reason), and each coin's open networks are the list's networks for it.
  const optionValues = (select, extra = '') =>
    select.locator(`option${extra}`).evaluateAll((options) => options.map((o) => o.value).filter(Boolean));
  // Deposit's own pickers sit in its "Asset" panel; the records' filter further down has an "Asset" field of its own.
  const depositPanel = page.getByRole('region', { name: 'Asset', exact: true });
  const depositAsset = picker(depositPanel, 'Asset');
  const depositNetwork = picker(depositPanel, 'Network');
  await expect(depositAsset).toHaveCount(1);
  await expect(depositNetwork).toHaveCount(1);
  const depositOffered = [...new Set([...deposits.assets, ...(deposits.halted ?? [])].map((asset) => asset.assetId))];
  await expect.poll(() => optionValues(depositAsset).then((v) => [...v].sort())).toEqual([...depositOffered].sort());
  for (const id of depositOffered) expect(row(id), `Deposit offers ${id}, which the list does not have`).toBeTruthy();
  for (const asset of deposits.assets) {
    await depositAsset.selectOption(asset.assetId);
    const open = asset.networks.map((n) => n.id);
    await expect.poll(() => optionValues(depositNetwork, ':not([data-halted])').then((v) => [...v].sort())).toEqual([...open].sort());
    for (const network of asset.networks) {
      expect(row(asset.assetId).networks.map((n) => n.networkId)).toContain(network.id);
      // The page shows that minimum exactly as the bank gives it, so Deposit shows no more places than the list's precision.
      await depositNetwork.selectOption(network.id);
      await expect(
        page
          .getByRole('term')
          .filter({ hasText: /^Minimum deposit$/ })
          .locator('xpath=following-sibling::dd[1]'),
      ).toHaveText(`${grouped(network.minimumDeposit)} ${asset.assetId}`);
      // And the page names the decimal places Deposit uses for the asset: the list's precision, exactly.
      await expect(
        page
          .getByRole('term')
          .filter({ hasText: /^Decimal places$/ })
          .locator('xpath=following-sibling::dd[1]'),
      ).toHaveText(String(row(asset.assetId).precision));
    }
  }
  await expect(page.getByRole('link', { name: 'Supported assets and networks', exact: true })).toHaveAttribute('href', '/uc/assets');

  // Withdraw links the same list.
  await page.goto('/uc/withdraw');
  await page.mouse.move(0, 600);
  await expect(page.getByRole('link', { name: 'Supported assets and networks', exact: true })).toHaveAttribute('href', '/uc/assets');
  // Withdraw's own pickers use the same rows: for every coin the person holds, the networks it offers are exactly the
  // list's withdrawal networks for that coin, and the retired coin they still hold is offered none.
  // Withdraw's own pickers sit in its form, the one with the Network field.
  const withdrawForm = page.locator('form').filter({ has: page.getByText('Network', { exact: true }) });
  const withdrawAsset = picker(withdrawForm, 'Asset');
  const withdrawNetwork = picker(withdrawForm, 'Network');
  await expect(withdrawAsset).toHaveCount(1);
  await expect(withdrawNetwork).toHaveCount(1);
  await expect.poll(() => optionValues(withdrawAsset)).toContain(RETIRED);
  for (const id of await optionValues(withdrawAsset)) {
    await withdrawAsset.selectOption(id);
    const open = (withdrawable.find((asset) => asset.assetId === id)?.networks ?? []).map((n) => n.networkId);
    await expect
      .poll(() => optionValues(withdrawNetwork).then((v) => [...v].sort()), `Withdraw's networks for ${id}`)
      .toEqual([...open].sort());
  }
  await withdrawAsset.selectOption(RETIRED);
  await expect(withdrawNetwork).toContainText('No network is open for this asset');
});
