// garden/no-shared-market-on-book on planted journey files: a step that prices off a quoted shared market fires and names
// ownSpotMarket; a step on its own market, one that only compares books, one whose words name the market, and other
// files do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint');
const skip = !existsSync(OXLINT) && 'no node_modules';
const RULE = 'garden(no-shared-market-on-book)';

/** Each planted file's findings of this rule, as `file:line`. */
function findings(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-market-'));
  try {
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ ...config, jsPlugins: config.jsPlugins.map((p) => join(ROOT, p)) }));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    let out = '';
    try {
      out = execFileSync(OXLINT, ['-c', '.oxlintrc.json', '--format', 'unix', ...Object.keys(files)], { cwd: dir, encoding: 'utf8' });
    } catch (e) {
      out = String(e.stdout ?? '');
    }
    return out.split('\n').filter((l) => l.includes(RULE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const J = 'apps/customer/tests/real-app/J-x-01.pw.mjs';

const file = (...lines) => lines.join('\n');
// J-cex-spot-02 #7 as it was before #8549: a module constant, a helper reading the maker's bids with it as a default, a
// ticket helper that types a price.
const BEFORE = file(
  "const SYMBOL = 'BTC-USDC';",
  "const DESK = '/trade/spot/BTC-USDC';",
  'async function awayBid(percent, symbol = SYMBOL) { return (await testVenue(`/open-orders`, { symbol })).body; }',
  "async function reviewLimitBuy(page, price) { await page.getByRole('textbox', { name: 'Price' }).fill(price); }",
  "test('J-x-01 #7 the numbers change between Review and Confirm', async ({ page }) => {",
  '  await openVenueDesk(page, DESK);',
  '  await reviewLimitBuy(page, await awayBid(100));',
  '});',
);

test('pricing off a shared market through helpers fires and names ownSpotMarket', skip, () => {
  const out = findings({ [J]: BEFORE });
  assert.equal(out.length, 1, out.join('\n'));
  assert.ok(out[0].includes('ownSpotMarket('), out[0]);
  const direct = findings({
    [J]: file(
      "test('J-x-01 #2', async () => {",
      "  const { bid } = await venueBook('ETH-USDC');",
      "  await place({ symbol: 'ETH-USDC', side: 'buy', price: bid });",
      '});',
    ),
  });
  assert.equal(direct.length, 1, direct.join('\n'));
});

test('its own market, a book only compared, a step that names its market, and other files pass', skip, () => {
  const out = findings({
    [J]: file(
      "test('J-x-01 #7 owns its book', async ({ page }) => {",
      "  const market = await ownSpotMarket(J, 'JX', 'R');",
      "  expect((await testVenue('/book', { symbol: market.symbol })).body.value).toMatchObject({ bids: [] });",
      "  await page.getByRole('textbox', { name: 'Price' }).fill('10');",
      '});',
      "test('J-x-01 #5 shows the book', async ({ page }) => {",
      "  const { bid } = await venueBook('BTC-USDC');",
      "  await expect(page.getByTestId('best-bid')).toHaveText(bid);",
      '});',
      "test('J-x-01 #6 opens /trade/spot/BTC-USDC and sells into the bid', async () => {",
      "  const { bid } = await venueBook('BTC-USDC');",
      "  await place({ symbol: 'BTC-USDC', side: 'sell', price: bid });",
      '});',
      "test('J-x-01 #8 asks the agent', async () => {",
      "  await ask('buy BTC-USDC');",
      "  await place({ symbol: 'BTC-USDC', price: '1' });",
      '});',
    ),
    'apps/customer/tests/real-app/venue.mjs': "export async function x() { await venueBook('BTC-USDC'); await place({ price: 1 }); }\n",
  });
  assert.deepEqual(out, []);
});
