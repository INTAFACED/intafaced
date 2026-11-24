import { expect } from './journey.mjs';
import { toUnits } from './stack.mjs';
import { confirm, reviewSheet } from './desk.mjs';
import { continueInWallet, otherTraderKey, otherTraderRun, testVenue, venueAccount, venueRecord } from './venue.mjs';

const ONE = toUnits('1');

/** The screen's dollar text for an exact amount (fmtUsd): under 1 dollar at up to 4 places, else cents, half-up. */
export function fmtLotUsd(units, signed = false) {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const places = abs < ONE ? 4 : 2;
  const step = 10n ** BigInt(18 - places);
  const rounded = (abs + step / 2n) / step;
  let frac = (rounded % 10n ** BigInt(places)).toString().padStart(places, '0');
  if (places === 4) frac = frac.replace(/0{1,2}$/, '');
  const sign = rounded === 0n ? '' : negative ? '−' : signed ? '+' : '';
  return `${sign}$${(rounded / 10n ** BigInt(places)).toLocaleString('en-US')}.${frac}`;
}

/** Another TEST trader, named for this run and this person, funded on the TEST venue with `amount` of `asset`. */
export async function fundedCounterparty(journey, owner, tag, asset, amount) {
  const name = `${journey}-${process.env.JOURNEY_RUN_ID ?? 'local'}-${owner.slice(2, 10)}-${tag}`;
  await testVenue('/test/deposit', {
    account: await venueAccount(otherTraderKey(name).address),
    asset,
    amount,
    depositRef: `seed:${name}:${asset}`,
  });
  return name;
}

/** The other TEST trader rests a GTC limit order on the venue's book. */
export async function restVenueLimit(name, symbol, side, amount, price, key) {
  const rested = await otherTraderRun(name, {
    kind: 'place_order',
    symbol,
    side,
    type: 'limit',
    amount,
    price,
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${name}:${key}`,
    builderFee: null,
  });
  expect(rested.definite && rested.accepted, JSON.stringify(rested)).toBe(true);
}

/** A limit order on the venue desk now open, reviewed once the venue's own preview answers, signed in the wallet. */
export async function placeVenueLimit(page, side, price, amount, coin) {
  const form = side === 'buy' ? 0 : 1;
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  await page.getByRole('textbox', { name: 'Price', exact: true }).nth(form).fill(price);
  const preview = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/preview' && r.request().method() === 'POST');
  await page.getByRole('textbox', { name: 'Amount', exact: true }).nth(form).fill(amount);
  expect((await preview).status()).toBe(200);
  await page.getByRole('button', { name: `${side === 'buy' ? 'Buy' : 'Sell'} ${coin}`, exact: true }).click();
  const sheet = reviewSheet(page);
  await expect(sheet).toBeVisible();
  const approve = sheet.getByRole('button', { name: 'Approve our builder fee in your wallet', exact: true });
  if (side === 'sell' && (await approve.isVisible())) {
    await approve.click();
    await continueInWallet(page);
    await expect(sheet.getByRole('button', { name: 'Confirm sell', exact: true })).toBeEnabled({ timeout: 20_000 });
  }
  await confirm(page, side);
  await continueInWallet(page);
}

/** The person's own fills on `symbol` and `side` since `since`, from the venue's own record, oldest first. */
export async function venueFillsOf(owner, symbol, side, since) {
  return (await venueRecord(owner, '/fills', { since })).value
    .filter((f) => f.symbol === symbol && f.side === side)
    .sort((a, b) => Date.parse(a.filledAt) - Date.parse(b.filledAt) || a.fillId.localeCompare(b.fillId));
}
