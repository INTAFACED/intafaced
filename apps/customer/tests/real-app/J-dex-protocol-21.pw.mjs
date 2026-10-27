import { test, expect } from '@playwright/test';
import { CHAIN_ID, TOKEN_A, TOKEN_B, UNBUILT, connectWallet, dexRun } from './dex.mjs';
import { installTestWallet, testWalletKey, TEST_WALLET } from './test-wallet.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-dex-protocol-21, in the running app (docs/roadmap/journeys.json): lend and borrow peer to peer for a fixed term,
// and settle a trade in escrow. One test per step, titled "J-dex-protocol-21 #<n>", run in order with two TEST wallets
// (the lender, and a borrower in a second browser) holding TEST token A (principal) and TEST token B (collateral).
// Collateral and principal lock in contracts under each person's own signature; nothing posts to the ledger and fees
// are only as published. rail.crypto while the node is absent.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - the Web3 side has no fixed-term loan book (/dex/lend/fixed): no offers, counter offers, accept, repay or claim
//   (D-limit-dca-07);
// - the P2P room has no sovereign escrow choice (RC-p2p-01, -02); the on-chain escrow is proven by
//   services/svc-protocol/src/escrow/sovereign-escrow.onchain.test.ts, but no room opens it;
// - the stack has no TEST chain, so nothing a step signs can mine and #5's maturity cannot pass.
const J = 'J-dex-protocol-21';
const dex = dexRun(J);
const TOKENS = [TOKEN_A, TOKEN_B];

test.describe.configure({ mode: 'default' });

const book = (page) => tableIn(page.getByRole('main'), 'Loan offers');
const loans = (page) => tableIn(page.getByRole('main'), 'Your loans');
const offerRow = (page) => bodyRows(book(page)).filter({ hasText: '100 TEST Token A · 30 days · 150 TEST Token B' });

/** Opens the fixed-term loan book with the run's lender wallet connected. */
async function openBook(page) {
  const wallet = await connectWallet(page, dex, { tokens: TOKENS });
  await page.goto('/dex/lend/fixed');
  await expect(book(page)).toBeVisible(UNBUILT);
  return wallet;
}

/** The borrower: a second TEST wallet of this run, in its own browser, on the loan book. */
async function borrower(browser) {
  const state = dex.run.read();
  const privateKey = state.borrowerKey ?? dex.run.write({ borrowerKey: testWalletKey() }).borrowerKey;
  const context = await browser.newContext();
  const page = await context.newPage();
  const wallet = await installTestWallet(page, { chainId: CHAIN_ID, tokens: TOKENS, privateKey });
  await page.goto('/wallet');
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
  await page.goto('/dex/lend/fixed');
  await expect(book(page)).toBeVisible(UNBUILT);
  return { context, page, wallet };
}

/** Signs whatever the open sheet asks for. */
async function sign(page) {
  await page.getByRole('dialog', { name: 'Check before you sign' }).getByRole('button', { name: 'Continue in wallet' }).click();
}

test(`${J} starts: a TEST lender wallet and a TEST borrower wallet holding TEST tokens`, async ({ page }) => {
  dex.start();
  await connectWallet(page, dex, { tokens: TOKENS });
});

test(`${J} #1 posts a lender offer of 100 for 30 days against 150 collateral: the offer in the book with rate, term and fee`, async ({
  page,
}) => {
  await openBook(page);
  await page.getByRole('button', { name: 'Offer a loan' }).click();
  const form = page.getByRole('form', { name: 'Loan offer' });
  await form.getByRole('textbox', { name: /^Amount of TEST Token A/ }).fill('100');
  await form.getByRole('spinbutton', { name: /^Term \(days\)/ }).fill('30');
  await form.getByRole('textbox', { name: /^Collateral in TEST Token B/ }).fill('150');
  await form.getByRole('textbox', { name: /^Rate/ }).fill('5');
  await form.getByRole('button', { name: 'Review' }).click();
  await sign(page);
  await expect(offerRow(page)).toHaveCount(1, { timeout: 60_000 });
  for (const header of ['Rate', 'Term', 'Fee']) await expect(book(page).getByRole('columnheader', { name: header })).toBeVisible();
});

test(`${J} #2 makes a counter offer as a borrower: the original stays open until one is accepted`, async ({ page, browser }) => {
  await openBook(page);
  const other = await borrower(browser);
  try {
    await offerRow(other.page).getByRole('button', { name: 'Counter' }).click();
    const counter = other.page.getByRole('form', { name: 'Counter offer' });
    await counter.getByRole('textbox', { name: /^Rate/ }).fill('4');
    await counter.getByRole('button', { name: 'Review' }).click();
    await sign(other.page);
    await page.reload();
    await expect(offerRow(page)).toContainText('Open');
    await expect(bodyRows(tableIn(page.getByRole('main'), 'Counter offers')).filter({ hasText: '4%' })).toHaveCount(1);
  } finally {
    await other.context.close();
  }
});

test(`${J} #3 accepts an offer: collateral locks and 100 is paid to the borrower; a replayed signature reverts`, async ({
  page,
  browser,
}) => {
  await openBook(page);
  const other = await borrower(browser);
  try {
    await offerRow(other.page).getByRole('button', { name: 'Accept' }).click();
    await sign(other.page);
    const loan = bodyRows(loans(other.page)).filter({ hasText: '100 TEST Token A' });
    await expect(loan).toContainText('Collateral locked: 150 TEST Token B', { timeout: 60_000 });
    await expect(loan).toContainText('Received 100 TEST Token A');
    // The same acceptance sent again is refused by the contract, never a second loan.
    await other.page.getByRole('button', { name: 'Reuse last signature' }).click();
    await expect(other.page.getByRole('alert')).toContainText('This signature was already used');
    await expect(bodyRows(loans(other.page))).toHaveCount(1);
  } finally {
    await other.context.close();
  }
});

test(`${J} #4 repays before maturity: collateral returns`, async ({ page, browser }) => {
  await openBook(page);
  const other = await borrower(browser);
  try {
    const loan = bodyRows(loans(other.page)).filter({ hasText: '100 TEST Token A' });
    await loan.getByRole('button', { name: 'Repay' }).click();
    await sign(other.page);
    await expect(loan).toContainText('Repaid · collateral returned', { timeout: 60_000 });
  } finally {
    await other.context.close();
  }
});

test(`${J} #5 a borrower misses maturity: only the lender can claim the collateral`, async ({ page, browser }) => {
  await openBook(page);
  // A TEST loan of this run whose term has already passed unpaid.
  const overdue = bodyRows(loans(page)).filter({ hasText: 'Overdue' });
  await expect(overdue).toHaveCount(1, UNBUILT);
  const other = await borrower(browser);
  try {
    await expect(bodyRows(loans(other.page)).filter({ hasText: 'Overdue' }).getByRole('button', { name: 'Claim collateral' })).toHaveCount(
      0,
    );
  } finally {
    await other.context.close();
  }
  await overdue.getByRole('button', { name: 'Claim collateral' }).click();
  await sign(page);
  await expect(overdue).toContainText('Collateral claimed', { timeout: 60_000 });
});

test(`${J} #6 chooses the sovereign escrow for a P2P trade: funds lock; release pays the seller in full, refund returns it, a dispute settles on timeout; nothing is left in the contract`, async ({
  page,
}) => {
  await connectWallet(page, dex, { tokens: TOKENS });
  await page.goto('/p2p');
  const escrow = page.getByRole('radiogroup', { name: 'Escrow' });
  await escrow.getByRole('radio', { name: /^Sovereign escrow/ }).check(UNBUILT);
  await expect(page.getByRole('note').filter({ hasText: 'Sovereign escrow' })).toContainText(
    'Your funds lock in a contract. Release pays the seller in full; refund returns them; a dispute settles on timeout by the refund you both agreed.',
  );
  const trades = tableIn(page.getByRole('main'), 'Escrow trades');
  for (const state of ['Released', 'Refunded', 'Settled on timeout'])
    await expect(bodyRows(trades).filter({ hasText: state }).filter({ hasText: 'Left in contract: 0' })).not.toHaveCount(0);
});
