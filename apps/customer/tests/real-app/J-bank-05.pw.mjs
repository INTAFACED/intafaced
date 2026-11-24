// World: none
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, fund, journeyState, toUnits, signOutBrowser } from './stack.mjs';
import { STACK_PORTS } from '../../../../tooling/scripts/local-test-facts.mjs';
import { signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';
import { venueRecord } from './venue.mjs';
import { withPartner } from './partner.mjs';

// J-bank-05, in the running app (docs/roadmap/journeys.json): I send money abroad. J-bank-05 keeps the quote's SWIFT fee handling (#1), the no-partner notice (#2) and receiving details per currency (#3);
// the send, its tracking and the expired-quote refusal are J-pay-12's. The local stack chooses the TEST global-send
// stand-in (BANK_GLOBAL_PARTNER=global-sim), which pays nobody and is refused under live posture: its catalogue is the bank
// profile's TEST value BANK_GLOBAL_SIM_JSON (tooling/profiles/test-owner-values/bank.json), read here as the provider's own
// figures, so every rate, fee, receive amount and lock length a step expects comes from it, never from the screen or the
// browser. Receiving details come from the TEST partner bank: #3 compares the app with the partner's own book, read on
// loopback straight from it (svc-bank's test-partner record, venue.mjs venueRecord), never through the person's bank API.
// The tests after #3 keep guarding the send itself on this file's sender (corridor, the locked quote paid once, an expired
// lock refused); they name no J-bank-05 step, since those are J-pay-12's. Every number here is a TEST number.
const J = 'J-bank-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

async function code() {
  const now = run.read();
  const { totp } = await totpLib();
  const next = await nextCode(totp, now.secret, now.step);
  run.write({ step: next.step });
  return next.code;
}

/** A verified sender with TEST 100 USDT and an authenticator app, made on first use. */
async function sender(page) {
  const now = run.read();
  if (now.sender && now.secret) return now.sender;
  const who = await signUp(page, 'jb5s');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '100').tx).toBeTruthy();
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.reset({ sender: who, secret, step });
  await page.goto('about:blank');
  await signOutBrowser(page.context());
  return who;
}

async function signIn(page) {
  const who = await sender(page);
  const totpCode = await code();
  await page.goto('/login');
  await page.fill('input[name=totp]', totpCode);
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** The sender's free USDT through their own API, with a fresh code. */
async function usdt() {
  const { sender: who } = run.read();
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password, totpCode: await code() }),
  }).then((r) => r.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused`);
  const res = await fetch(`${EDGE}/api/v1/account/balance`, { headers: { origin: ORIGIN, authorization: `Bearer ${token}` } });
  return (await res.json()).balances?.USDT?.free ?? '0';
}

/** The person's own user id, from a sign-in of their own (the partner's book is keyed by it). */
async function userId() {
  const { sender: who } = run.read();
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password, totpCode: await code() }),
  }).then((r) => r.json());
  const id = login?.result?.data?.userId;
  if (!id) throw new Error(`sign-in for ${who.email} named no user id`);
  return id;
}

/** The global-send stand-in's catalogue, exactly as the stack hands it to svc-bank: the provider's own TEST figures. */
const CATALOGUE = JSON.parse(
  JSON.parse(readFileSync(path.join(ROOT, 'tooling/profiles/test-owner-values/bank.json'), 'utf8')).values.BANK_GLOBAL_SIM_JSON.value,
);
/** One corridor of the catalogue. */
const corridorOf = (country) => {
  const c = CATALOGUE.corridors.find((x) => x.country === country);
  if (!c) throw new Error(`the TEST catalogue has no corridor to ${country}`);
  return c;
};
/** What the provider quotes for `amount` of `asset` into `currency`: its rate, its fee (taken from what arrives) and its lock. */
function providerQuote(asset, amount, currency) {
  const r = CATALOGUE.rates.find((x) => x.asset === asset && x.toCurrency === currency);
  if (!r) throw new Error(`the TEST catalogue has no ${asset} to ${currency} rate`);
  const fee = r.fee ?? '0';
  const receive = (BigInt(amount) * BigInt(r.rate) - BigInt(fee)).toString();
  return { rate: r.rate, fee, feeAsset: r.fee ? currency : asset, receive, seconds: r.validSeconds ?? CATALOGUE.quoteValidSeconds };
}

/** The TEST partner bank's own record, on loopback (svc-bank's test-partner record). */
const PARTNER_RECORD = `http://127.0.0.1:${STACK_PORTS.bank}/test-partner`;
/** One page of the partner's own book for the person. */
async function partnerBook(id, page, extra = {}) {
  return (await venueRecord(id, page, extra, PARTNER_RECORD, null)).value;
}

/** Pay's global send with Germany, euro over SEPA chosen, and a recipient saved for it. */
async function toGermany(page) {
  await page.goto('/pay/global');
  const card = page.getByTestId('global-card');
  const where = card.getByLabel('Where it goes', { exact: true });
  await expect(where.locator('option', { hasText: 'DE · EUR · sepa' })).toHaveCount(1, { timeout: 30_000 });
  await where.selectOption({ label: 'DE · EUR · sepa' });
  return card;
}

/** Presses Get a quote and returns the service's own answer to it, as it reached this browser. */
async function quoted(page, card) {
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/api/bank/trpc/global.quote') && res.request().method() === 'POST'),
    card.getByRole('button', { name: 'Get a quote', exact: true }).click(),
  ]);
  const answer = (await response.json())?.result?.data;
  if (!answer?.validUntil) throw new Error(`global.quote gave no quote: ${response.status()}`);
  return answer;
}

let founderSessions;
/** The stack's founder sessions, signed in once for the file. */
function founders() {
  founderSessions ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    return { ctx, sessions: await gates.approverSessions(ctx) };
  })();
  // A failed sign-in is not kept: the next staff call signs in again.
  founderSessions.catch(() => {
    founderSessions = undefined;
  });
  return founderSessions;
}

/** The TEST stand-in's own record of a send it paid out, read by staff (founder `a`) straight from svc-bank's ops door. */
async function standInPayout(sendId) {
  const { ctx, sessions } = await founders();
  const res = await ctx.edge.query('bank', 'global.ops.standInPayout', { sendId }, sessions.a.token);
  if (!res.json?.result?.data) throw new Error(`standInPayout refused: ${res.status} ${res.text.slice(0, 300)}`);
  return res.json.result.data;
}

/** Pay's global send with the US, dollars over SWIFT chosen, and a US recipient saved for it once. */
async function toUs(page) {
  await page.goto('/pay/global');
  const card = page.getByTestId('global-card');
  const where = card.getByLabel('Where it goes', { exact: true });
  await expect(where.locator('option', { hasText: 'US · USD · swift' })).toHaveCount(1, { timeout: 30_000 });
  await where.selectOption({ label: 'US · USD · swift' });
  const recipient = card.getByLabel('Recipient', { exact: true });
  const grace = recipient.locator('option', { hasText: 'Grace TEST' });
  await expect(recipient.locator('option').first()).not.toHaveText('Loading…', { timeout: 30_000 });
  if ((await grace.count()) === 0) {
    await card.getByLabel('Recipient’s full name', { exact: true }).fill('Grace TEST');
    await card.getByLabel('Account number or IBAN', { exact: true }).fill('000123456789');
    await card.getByTestId('global-recipient-save').click();
    await expect(grace).toHaveCount(1, { timeout: 30_000 });
  }
  await recipient.selectOption({ label: await grace.innerText() });
  return card;
}

test(`${J} #1 reads the quote: rate, fee, receive amount and valid-until from the provider, never a typed constant, and SWIFT fee handling shown`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  // Step 1 starts the journey again: a new sender, with a recipient abroad in the book as the journey starts.
  run.reset({});
  await signIn(page);
  const card = await toGermany(page);
  await card.getByLabel('Recipient’s full name', { exact: true }).fill('Ada TEST');
  await card.getByLabel('Account number or IBAN', { exact: true }).fill('DE89 3704 0044 0532 0130 00');
  await card.getByTestId('global-recipient-save').click();
  const recipient = card.getByLabel('Recipient', { exact: true });
  await expect(recipient.locator('option', { hasText: 'Ada TEST' })).toHaveCount(1, { timeout: 30_000 });
  await recipient.selectOption({ label: await recipient.locator('option', { hasText: 'Ada TEST' }).innerText() });
  // Every figure on this card comes from the stand-in, and the card says so.
  await expect(card.getByTestId('global-stand-in')).toContainText('TEST');

  /** Asks for a quote and reads it off the screen: each figure, and the instant it is valid until. */
  const readQuote = async (on, amount, want) => {
    await on.getByLabel('You send', { exact: true }).fill(amount);
    const asked = Date.now();
    const answer = await quoted(page, on);
    const quote = on.getByTestId('global-quote');
    const cell = (term) =>
      quote
        .locator('div')
        .filter({ has: page.getByText(term, { exact: true }) })
        .locator('dd');
    // Exactly the provider's figures for this amount: its rate, its fee and what arrives after it.
    await expect(cell('Exchange rate')).toHaveText(want.rate, { timeout: 30_000 });
    await expect(cell('Fee')).toHaveText(`${want.fee} ${want.feeAsset}`);
    await expect(cell('They receive')).toHaveText(`${want.receive} ${want.currency}`);
    const answered = Date.now();
    // The service's own answer carries the provider's figures, and the screen shows its valid-until instant exactly.
    expect(answer).toMatchObject({ rate: want.rate, fee: want.fee, feeAsset: want.feeAsset, receiveAmount: want.receive });
    await expect(on.getByText(`Valid until ${answer.validUntil}`, { exact: true })).toBeVisible();
    const until = Date.parse(answer.validUntil);
    // Valid-until is the provider's own lock for this pair, counted from when it quoted: not a fixed instant.
    expect(Number.isNaN(until)).toBe(false);
    expect(until).toBeGreaterThanOrEqual(asked + want.seconds * 1000 - 2000);
    expect(until).toBeLessThanOrEqual(answered + want.seconds * 1000 + 2000);
    return until;
  };

  // SEPA to Germany: the provider's EUR rate and no fee.
  const eur = { ...providerQuote('USDT', '40', 'EUR'), currency: 'EUR' };
  const eurUntil = await readQuote(card, '40', eur);
  // SEPA is not SWIFT: no SWIFT charge line.
  await expect(card.getByTestId('global-swift-charges')).toHaveCount(0);

  // A SWIFT corridor: another rate, a fee the provider takes from what arrives, its own shorter lock, and the charge
  // handling the provider gives for the corridor shown with the quote.
  const us = await toUs(page);
  const usd = { ...providerQuote('USDT', '5', 'USD'), currency: 'USD' };
  expect(usd.rate).not.toBe(eur.rate);
  expect(usd.fee).not.toBe('0');
  const usdUntil = await readQuote(us, '5', usd);
  expect(usdUntil).not.toBe(eurUntil);
  expect(corridorOf('US').swiftCharges).toBe('SHA');
  await expect(us.getByTestId('global-swift-charges').locator('dd')).toHaveText(
    'Shared (SHA): you pay the sending charge, and the banks along the way and the receiving bank may take theirs from what arrives.',
  );
  // The lock counts down from the provider's own seconds for USD, not the catalogue's default.
  expect(usd.seconds).toBeLessThan(CATALOGUE.quoteValidSeconds);
  await expect(us.getByTestId('global-lock')).toHaveText(/^Rate locked for 0:[012]\d\. Confirm inside it/);
  await stepPicture(page);
});

test(`${J} #2 with no partner for the destination, pressing send shows the notice with rail.bank, nothing leaves, and the intent row is kept`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  await signIn(page);
  const before = await usdt();
  await page.goto('/pay/global');
  const card = page.getByTestId('global-card');
  const where = card.getByLabel('Where it goes', { exact: true });
  await expect(where.locator('option', { hasText: 'NL · EUR · sepa' })).toHaveCount(1, { timeout: 30_000 });
  await where.selectOption({ label: 'NL · EUR · sepa' });
  // The destination says before anything is sent that no partner pays out there.
  await expect(card.getByTestId('global-no-payout')).toHaveText(
    'No payout partner is connected for this destination. A send here is refused, nothing leaves your balance, and the send is kept in your history.',
  );
  await card.getByLabel('Recipient’s full name', { exact: true }).fill('Daan TEST');
  await card.getByLabel('Account number or IBAN', { exact: true }).fill('NL91 ABNA 0417 1643 00');
  await card.getByTestId('global-recipient-save').click();
  const recipient = card.getByLabel('Recipient', { exact: true });
  await expect(recipient.locator('option', { hasText: 'Daan TEST' })).toHaveCount(1, { timeout: 30_000 });
  await recipient.selectOption({ label: await recipient.locator('option', { hasText: 'Daan TEST' }).innerText() });
  await card.getByLabel('You send', { exact: true }).fill('41');
  await card.getByRole('button', { name: 'Get a quote', exact: true }).click();
  // The corridor is listed with no payout, and the rate is the provider's answer for the currency, so a quote still comes back.
  expect(corridorOf('NL').payout).toBe(false);
  const nl = providerQuote('USDT', '41', 'EUR');
  await expect(card.getByTestId('global-quote')).toContainText(`${nl.receive} EUR`, { timeout: 30_000 });
  await card.getByRole('button', { name: 'Review and send', exact: true }).click();
  const confirm = card.getByTestId('global-confirm');
  await confirm.getByLabel('Authenticator code', { exact: true }).fill(await code());
  await confirm.getByRole('button', { name: 'Confirm with a code', exact: true }).click();
  await expect(card.getByTestId('global-failure')).toContainText('No payout partner for this destination', { timeout: 30_000 });
  // The notice names the outside piece that is missing: the banking partner, rail.bank.
  await expect(card.getByTestId('global-failure')).toContainText('Needs: rail.bank', { timeout: 30_000 });
  await expect(card.getByTestId('global-sent')).toHaveCount(0);
  // The intent row is kept, refused with nothing taken.
  const row = card.getByTestId('global-history').locator('li[data-status="failed"]', { hasText: '41 USDT to EUR' });
  await expect(row).toContainText('41 USDT to EUR', { timeout: 30_000 });
  await expect(row).toContainText('It was not sent and nothing remains taken from your balance. Needs: rail.bank');
  expect(toUnits(await usdt())).toBe(toUnits(before));
  await stepPicture(page);
});

test(`${J} #3 opens receive details for a currency: the details the partner issued per currency, or with none issued the needs-a-partner notice with rail.bank and no number`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  await signIn(page);
  const id = await userId();
  await page.goto('/pay/global');
  const receive = page.getByTestId('global-receive');
  await expect(receive).toContainText('Receive money from abroad');
  const picker = receive.getByLabel('Currency to receive', { exact: true });
  await expect(picker.locator('option', { hasText: 'EUR' })).toHaveCount(1, { timeout: 30_000 });
  const currencies = (await picker.locator('option').evaluateAll((os) => os.map((o) => o.value))).filter(Boolean);
  expect(currencies).toContain('EUR');
  for (const currency of currencies) {
    // The partner's own book has issued this person no receiving details in this currency.
    expect(await partnerBook(id, '/account-details', { currency })).toMatchObject({ issued: false, sets: [] });
    await picker.selectOption(currency);
    const block = receive.getByTestId(`account-details-${currency}`);
    await expect(block).toContainText('Needs a banking partner. It is switched off in this build.');
    await expect(block).toContainText('rail.bank');
    await expect(block.getByTestId('account-details-set')).toHaveCount(0);
  }
  await expect(receive).not.toContainText(/IBAN|Sort code|Account number/);

  // With the TEST partner issuing this person receiving details: for each currency, exactly the sets the partner's own
  // book holds, labelled TEST, with no rail.bank notice.
  const { sender: who } = run.read();
  await withPartner(
    who,
    { accountDetails: 'issued' },
    async () => {
      await page.goto('/pay/global');
      await expect(picker.locator('option', { hasText: 'EUR' })).toHaveCount(1, { timeout: 30_000 });
      for (const currency of currencies) {
        const issued = await partnerBook(id, '/account-details', { currency });
        expect(issued.issued, `${currency}: the partner issued details`).toBe(true);
        expect(issued.sets.length, `${currency}: the partner issued a set`).toBeGreaterThan(0);
        await picker.selectOption(currency);
        const block = receive.getByTestId(`account-details-${currency}`);
        await expect(block).not.toContainText('rail.bank');
        const shown = block.getByTestId('account-details-set');
        await expect(shown).toHaveCount(issued.sets.length, { timeout: 30_000 });
        for (const [i, set] of issued.sets.entries()) {
          expect(set.partnerBank, 'the issuing bank is the TEST partner').toMatch(/TEST/);
          expect(set.accountNumber, 'the number is labelled TEST').toMatch(/^TEST-/);
          await expect(shown.nth(i)).toContainText(set.accountNumber);
          await expect(shown.nth(i)).toContainText(set.partnerBank);
        }
      }
      await picker.selectOption('EUR');
      await receive.scrollIntoViewIfNeeded();
      await stepPicture(page);
    },
    { code },
  );
});

/*
 * The send itself is J-pay-12's. These tests name no J-bank-05 step and keep guarding it on this file's sender
 * until J-pay-12's own file covers it: the corridor and its fields, the locked quote paid once, an expired lock refused.
 */

test(`${J}, the send (J-pay-12's): opens global send and picks the corridor: its limits and recipient fields show, and an unsupported corridor says so`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signIn(page);
  const card = await toGermany(page);
  // Every figure on this card comes from the stand-in, and the card says so.
  await expect(card.getByTestId('global-stand-in')).toContainText('TEST');
  await expect(card.getByTestId('global-stand-in')).toContainText('Nobody receives the money');
  const where = card.getByLabel('Where it goes', { exact: true });
  // Exactly the stand-in's four TEST corridors: nothing typed in the app, nothing more.
  await expect(where.locator('option')).toHaveText([
    'Choose a country and currency',
    'DE · EUR · sepa',
    'GB · GBP · bank_account',
    'NL · EUR · sepa',
    'US · USD · swift',
  ]);
  await expect(card.getByTestId('global-limits')).toHaveText('The smallest send is 1. The largest send is 1000.');
  // The corridor's requirement fields: who receives it, their account or IBAN, and their bank's code.
  await expect(card.getByLabel('Recipient’s full name', { exact: true })).toBeEditable();
  await expect(card.getByLabel('Account number or IBAN', { exact: true })).toBeEditable();
  await expect(card.getByLabel('Bank code (SWIFT/BIC)', { exact: true })).toBeEditable();
  // A destination the catalogue has no corridor for says so; one it has says to pick it.
  const check = card.getByLabel('Not in the list? Enter a country code', { exact: true });
  await check.fill('jp');
  await card.getByTestId('global-country-check').click();
  await expect(card.getByTestId('global-country-unsupported')).toHaveText(
    'Sending to JP is not supported: there is no corridor there. Only the destinations in the list can be sent to.',
  );
  await check.fill('de');
  await card.getByTestId('global-country-check').click();
  await expect(card.getByTestId('global-country-supported')).toHaveText('Sending to DE is supported: choose it in the list above.');
  await expect(card.getByTestId('global-country-unsupported')).toHaveCount(0);
  // The recipient form for the corridor: name and IBAN, checked for format before it is saved.
  await card.getByLabel('Recipient’s full name', { exact: true }).fill('Bea TEST');
  await card.getByLabel('Account number or IBAN', { exact: true }).fill('DE02 1203 0000 0000 2020 51');
  await card.getByTestId('global-recipient-save').click();
  await expect(card.getByLabel('Recipient', { exact: true }).locator('option', { hasText: 'Bea TEST' })).toHaveCount(1, {
    timeout: 30_000,
  });
});

test(`${J}, the send (J-pay-12's): locks the rate and confirms: the send is paid at exactly the locked quote, once`, async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  const before = await usdt();
  const card = await toGermany(page);
  await card.getByLabel('Recipient', { exact: true }).selectOption({ index: 1 });
  await card.getByLabel('You send', { exact: true }).fill('40');
  const lock = await quoted(page, card);
  // The quote is a lock, counting down from the stand-in's TEST 300 seconds.
  await expect(card.getByTestId('global-lock')).toHaveText(/^Rate locked for [45]:\d{2}\. Confirm inside it/, { timeout: 30_000 });
  await expect(card.getByTestId('global-quote')).toContainText('80 EUR');
  await card.getByRole('button', { name: 'Review and send', exact: true }).click();
  const confirm = card.getByTestId('global-confirm');
  await expect(confirm.getByTestId('global-confirm-lock')).toContainText('Rate locked for');
  await expect(confirm).toContainText('80 EUR');
  await confirm.getByLabel('Authenticator code', { exact: true }).fill(await code());
  const [sendResponse] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/api/bank/trpc/global.send') && res.request().method() === 'POST', {
      timeout: 60_000,
    }),
    confirm.getByRole('button', { name: 'Confirm with a code', exact: true }).click(),
  ]);
  const sent = (await sendResponse.json())?.result?.data;
  expect(sent).toMatchObject({ status: 'sent', quoteId: lock.quoteId, quoteRate: '2', quoteReceive: '80' });
  await expect(card.getByTestId('global-sent')).toBeVisible({ timeout: 30_000 });
  // The partner's side, read from the TEST stand-in itself: it converted this send once, at exactly the lock's figures.
  expect(await standInPayout(sent.id)).toMatchObject({
    sendId: sent.id,
    quoteId: lock.quoteId,
    assetId: 'USDT',
    amount: '40',
    toCurrency: 'EUR',
    rate: '2',
    receiveAmount: '80',
    conversions: 1,
  });
  const row = card.getByTestId('global-history').locator('li').first();
  await expect(row).toContainText('40', { timeout: 30_000 });
  // The signed receipt carries the locked figures: rate 2, they receive 80 EUR.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    row.getByRole('button', { name: 'Download receipt', exact: true }).click(),
  ]);
  const receipt = readFileSync(await download.path(), 'utf8');
  expect(receipt).toContain('Sent: 40 USDT');
  expect(receipt).toContain('They receive: 80 EUR');
  expect(receipt).toContain('Rate: 2');
  // Exactly the amount left, once: one send, converted once at the lock.
  expect(toUnits(await usdt())).toBe(toUnits(before) - toUnits('40'));
  await expect(card.getByTestId('global-history').locator('li', { hasText: '40 USDT to EUR' })).toHaveCount(1);
});

test(`${J}, the send (J-pay-12's): a lock that ran out is refused by the service itself, nothing leaves, and only a new quote goes on`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  await signIn(page);
  const before = await usdt();
  const card = await toUs(page);
  await card.getByLabel('You send', { exact: true }).fill('5');
  await card.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect(card.getByTestId('global-lock')).toContainText('Rate locked for', { timeout: 30_000 });
  // This browser's clock stops here, so the screen keeps showing the lock as live and lets the send go to the service; the
  // service keeps its own time, and its 20-second TEST lock for USD runs out in real time meanwhile.
  await page.clock.setFixedTime(new Date(await page.evaluate(() => Date.now())));
  await new Promise((resolve) => setTimeout(resolve, 25_000));
  await expect(card.getByTestId('global-lock')).toContainText('Rate locked for');
  await card.getByRole('button', { name: 'Review and send', exact: true }).click();
  const confirm = card.getByTestId('global-confirm');
  await confirm.getByLabel('Authenticator code', { exact: true }).fill(await code());
  await confirm.getByRole('button', { name: 'Confirm with a code', exact: true }).click();
  // The service's refusal, in its words for an expired lock (the screen's own check words it differently).
  await expect(card.getByTestId('global-failure')).toHaveText('That price has expired Get a fresh price and confirm again.', {
    timeout: 30_000,
  });
  await expect(card.getByTestId('global-sent')).toHaveCount(0);
  // The refused lock is dropped, the send is kept refused, and nothing left the balance.
  await expect(card.getByTestId('global-lock')).toHaveCount(0);
  const row = card.getByTestId('global-history').locator('li[data-status="failed"]', { hasText: '5 USDT to USD' });
  await expect(row).toContainText('It was not sent and nothing remains taken from your balance.', { timeout: 30_000 });
  expect(toUnits(await usdt())).toBe(toUnits(before));
  // A new quote is a new lock, and the send can go on from there.
  await card.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect(card.getByTestId('global-lock')).toContainText('Rate locked for', { timeout: 30_000 });
  await card.getByRole('button', { name: 'Review and send', exact: true }).click();
  await expect(card.getByTestId('global-confirm')).toBeVisible();
});

test(`${J}, the send (J-pay-12's): after the lock runs out, the quote must be taken again before anything is sent`, async ({ page }) => {
  test.setTimeout(240_000);
  // The browser's clock only: it is moved past the lock without waiting five minutes. The service keeps its own time.
  await page.clock.install();
  await signIn(page);
  const card = await toGermany(page);
  await card.getByLabel('Recipient', { exact: true }).selectOption({ index: 1 });
  await card.getByLabel('You send', { exact: true }).fill('40');
  await card.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect(card.getByTestId('global-lock')).toContainText('Rate locked for', { timeout: 30_000 });
  await page.clock.fastForward('05:01');
  await expect(card.getByTestId('global-lock-over')).toHaveText('The rate lock ran out. Get a new quote to send.');
  await card.getByRole('button', { name: 'Review and send', exact: true }).click();
  await expect(card.getByTestId('global-failure')).toContainText('This quote has expired');
  await expect(card.getByTestId('global-confirm')).toHaveCount(0);
  // A new quote is a new lock, and the send can go on from there.
  await card.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect(card.getByTestId('global-lock')).toContainText('Rate locked for', { timeout: 30_000 });
  await card.getByRole('button', { name: 'Review and send', exact: true }).click();
  await expect(card.getByTestId('global-confirm')).toBeVisible();
});
