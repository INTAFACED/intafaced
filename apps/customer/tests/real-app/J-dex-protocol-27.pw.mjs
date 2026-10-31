import { test, expect } from './journey.mjs';
import { TOKEN_A, UNBUILT, connectWallet, dexRun, oneAmount, seededWallet, walletSection } from './dex.mjs';
import { toUnits, tool } from './stack.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-dex-protocol-27, in the running app (docs/roadmap/journeys.json): mint and sell NFTs, and spend with the Sovereign
// Card. One test per step, titled "J-dex-protocol-27 #<n>", run in order with one TEST wallet holding TEST Token A and a
// second TEST wallet (the buyer, in its own browser). NFT sales split on chain (royalty plus remainder equals the
// price); the card pulls an exact amount at authorisation from the person's own smart account and its issuer never
// holds a balance. audit.external for mainnet; rail.card for the issuer, whose adapter is not connected.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - there is no NFT room (/dex/nfts): no mint, listing, buy, auction or market (RC-dex-protocol-06). Mint, royalty and
//   auction settlement are proven on chain in services/svc-protocol (nft-royalty.onchain.test.ts), but no room opens
//   them;
// - the wallet room has no Sovereign Card section (RC-bank-03, RC-bank-02); the pull being a transfer, not a hold, is
//   proven statically (card-pull-honesty.test.ts);
// - the stack has no TEST chain, so nothing a step signs can mine; #3 bids on a live TEST auction of the stack and reads
//   an ended one, and #3 and #6 act as the stack's seeded TEST wallet (dex.mjs): it holds `TEST auction piece`, and the
//   stack's TEST issuer will authorise a TEST spend on its card when the card is built;
// - #1 needs a TEST royalty maximum, which no stack tool publishes yet (`local-test-gates.mjs nft-royalty-max`,
//   proposed); the step clears it again after.
const J = 'J-dex-protocol-27';
const dex = dexRun(J);
const TOKENS = [TOKEN_A];

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');

/** Chooses one section of the open NFT room. */
const nftSection = (page, section, wait) =>
  main(page).getByRole('group', { name: 'Sections' }).getByRole('button', { name: section, exact: true }).click(wait);

/** Opens the NFT room on one of its sections with the run's wallet (or `as`) connected. */
async function openNfts(page, section, as = dex) {
  const wallet = await connectWallet(page, as, { tokens: TOKENS });
  await page.goto('/dex/nfts');
  await nftSection(page, section, UNBUILT);
  return wallet;
}

/** Signs whatever the open sheet asks for. */
async function sign(page) {
  await page.getByRole('dialog', { name: 'Check before you sign' }).getByRole('button', { name: 'Continue in wallet' }).click();
}

/** Opens the Sovereign Card section of the wallet room with the run's wallet (or `as`) connected. */
async function openCard(page, as = dex) {
  await connectWallet(page, as, { tokens: TOKENS });
  await walletSection(page, 'Sovereign Card');
  const card = main(page).getByRole('region', { name: 'Sovereign Card' });
  await expect(card).toBeVisible();
  return card;
}

test(`${J} starts: a connected TEST wallet with TEST tokens`, async ({ page }) => {
  dex.start();
  await connectWallet(page, dex, { tokens: TOKENS });
});

test(`${J} #1 mints an NFT with a 5 percent royalty: the token in the wallet and the royalty on the page; above the published maximum refused, a blank maximum refuses with its code`, async ({
  page,
}) => {
  await openNfts(page, 'Create');
  const form = main(page).getByRole('form', { name: 'Mint an NFT' });
  const mint = async (royalty) => {
    await form.getByRole('textbox', { name: /^Name/ }).fill('TEST piece');
    await form.getByRole('textbox', { name: /^Royalty \(%\)/ }).fill(royalty);
    await form.getByRole('button', { name: 'Review' }).click();
  };
  // The royalty maximum is blank on the stack: a mint refuses with its code until one is published.
  await mint('5');
  await expect(form.getByRole('alert')).toContainText('nft.royalty_max_unset');
  tool('local-test-gates.mjs', 'nft-royalty-max', '10');
  try {
    await page.reload();
    await nftSection(page, 'Create');
    await mint('11');
    await expect(form.getByRole('alert')).toContainText('Above the published maximum royalty of 10%');
    await mint('5');
    await sign(page);
    const mine = bodyRows(tableIn(main(page), 'Your NFTs')).filter({ hasText: 'TEST piece' });
    await expect(mine).toContainText('Royalty 5%', { timeout: 60_000 });
  } finally {
    tool('local-test-gates.mjs', 'nft-royalty-max', 'unset');
  }
});

test(`${J} #2 lists it for 100 TEST and a buyer buys: the royalty receiver gets 5, the seller 95, the sum equals the price; a buyer without enough approval is refused`, async ({
  page,
  browser,
}) => {
  await openNfts(page, 'Mine');
  const item = bodyRows(tableIn(main(page), 'Your NFTs')).filter({ hasText: 'TEST piece' });
  await item.getByRole('button', { name: 'List for sale' }).click();
  const list = main(page).getByRole('form', { name: 'List for sale' });
  await list.getByRole('textbox', { name: /^Price in TEST Token A/ }).fill('100');
  await list.getByRole('button', { name: 'Review' }).click();
  await sign(page);
  // The buyer, in its own browser: without an approval of 100 the buy is refused; after approving, it goes through.
  const other = await browser.newContext();
  try {
    const away = await other.newPage();
    await connectWallet(away, dexRun(`${J}-buyer`), { tokens: TOKENS });
    await away.goto('/dex/nfts');
    await main(away).getByRole('group', { name: 'Sections' }).getByRole('button', { name: 'Items', exact: true }).click();
    const listed = bodyRows(tableIn(main(away), 'Items')).filter({ hasText: 'TEST piece' });
    await listed.getByRole('button', { name: 'Buy' }).click();
    await expect(main(away).getByRole('alert')).toContainText('Approve 100 TEST Token A first');
    await main(away).getByRole('button', { name: 'Approve 100 TEST Token A' }).click();
    await sign(away);
    await listed.getByRole('button', { name: 'Buy' }).click();
    await sign(away);
  } finally {
    await other.close();
  }
  const sale = main(page).getByRole('region', { name: 'Sale of TEST piece' });
  await page.reload();
  await nftSection(page, 'Mine');
  await expect(sale).toContainText('Sold', { timeout: 120_000 });
  const split = tableIn(sale, 'Payment split');
  const royalty = oneAmount(await bodyRows(split).filter({ hasText: 'Royalty' }).getByRole('cell').last().innerText());
  const seller = oneAmount(await bodyRows(split).filter({ hasText: 'Seller' }).getByRole('cell').last().innerText());
  expect(royalty).toBe(toUnits('5'));
  expect(seller).toBe(toUnits('95'));
  expect(royalty + seller).toBe(toUnits('100'));
});

test(`${J} #3 starts an auction and a bid arrives under the leader: refused as too low; at the end the highest bid pays with the same split`, async ({
  page,
}) => {
  // The stack's seeded TEST wallet starts an auction of the TEST piece it holds.
  await openNfts(page, 'Mine', seededWallet);
  const piece = bodyRows(tableIn(main(page), 'Your NFTs')).filter({ hasText: 'TEST auction piece' });
  await piece.getByRole('button', { name: 'Start an auction' }).click();
  const start = main(page).getByRole('form', { name: 'Start an auction' });
  await start.getByRole('textbox', { name: /^Reserve price in TEST Token A/ }).fill('10');
  await start.getByRole('spinbutton', { name: /^Runs for \(hours\)/ }).fill('24');
  await start.getByRole('button', { name: 'Review' }).click();
  await sign(page);
  await expect(piece).toContainText('Auction live', { timeout: 60_000 });
  // On a TEST auction of the stack that is live, a bid under the leader is refused; one that has ended paid its split.
  await nftSection(page, 'Auctions');
  const live = main(page).getByRole('region', { name: 'TEST live auction' });
  const bid = live.getByRole('form', { name: 'Bid' });
  const leader = oneAmount(await live.getByTestId('leading-bid').innerText());
  await bid.getByRole('textbox', { name: /^Your bid/ }).fill('1');
  await bid.getByRole('button', { name: 'Review' }).click();
  await expect(bid.getByRole('alert')).toContainText('Your bid must be above the leading bid');
  expect(leader).toBeGreaterThan(toUnits('1'));
  const ended = main(page).getByRole('region', { name: 'TEST ended auction' });
  const split = tableIn(ended, 'Payment split');
  let sum = 0n;
  for (const text of await bodyRows(split).getByTestId('split-amount').allInnerTexts()) sum += oneAmount(text);
  expect(sum).toBe(oneAmount(await ended.getByTestId('winning-bid').innerText()));
});

test(`${J} #4 opens the NFT market: collections, items and auctions with the testnet chip`, async ({ page }) => {
  await page.goto('/dex/nfts');
  for (const name of ['Collections', 'Items', 'Auctions'])
    await expect(main(page).getByRole('group', { name: 'Sections' }).getByRole('button', { name })).toBeVisible(UNBUILT);
  await expect(main(page).getByTestId('network-chip')).toHaveText('Base Sepolia test network');
});

test(`${J} #5 funds the Sovereign Card from the wallet: funds stay in the person's own smart account; the card shows its tier and the step that unlocks a higher limit`, async ({
  page,
}) => {
  const card = await openCard(page);
  await card.getByRole('button', { name: 'Fund the card' }).click();
  await expect(card.getByRole('note')).toContainText('Your funds stay in your own smart account. The card pulls only what you spend.');
  await expect(card.getByTestId('card-tier')).toHaveText(/^Tier: .+/);
  await expect(card.getByRole('link', { name: 'Verify to raise your limit' })).toBeVisible();
});

test(`${J} #6 spends on the card: the exact amount is pulled at authorisation; if the programme shuts down the funds remain`, async ({
  page,
}) => {
  // The stack's TEST issuer authorises a TEST spend on the seeded TEST wallet's card.
  const card = await openCard(page, seededWallet);
  const pull = bodyRows(tableIn(card, 'Card pulls')).filter({ hasText: 'TEST authorisation' });
  await expect(pull).toHaveCount(1);
  expect(oneAmount(await pull.getByTestId('pull-amount').innerText())).toBe(oneAmount(await pull.getByTestId('auth-amount').innerText()));
  await expect(card.getByRole('note')).toContainText('If the card programme ends, your funds stay in your account.');
});

test(`${J} #7 reads the card's tier and cashback: cashback in IFC and the tier, or "Not set" while the issuer is not connected`, async ({
  page,
}) => {
  const card = await openCard(page);
  // The issuer is not connected on the stack: cashback reads "Not set" with rail.card, never a rate.
  await expect(card.getByTestId('card-cashback')).toHaveText(/^Cashback in IFC: Not set · rail\.card$/);
  await expect(card.getByTestId('card-tier')).toHaveText(/^Tier: .+/);
});
