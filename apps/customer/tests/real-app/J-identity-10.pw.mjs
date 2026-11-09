// World: none
import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { api, signUpInBrowser } from './stack.mjs';

// J-identity-10, in the running app (docs/roadmap/journeys.json): I set my language, display and notification choices.
// Starts signed in on device A, and signed in again on device B later. Ends with the same language, display currency and
// notification choices on both devices, and security notices that cannot be turned off. Moves no money.
// Independent tests (OWNER 212): written from the step's own words, not from the build. Each checks every clause of its
// step; a clause the product has no part for yet is written against what the person sees, with stable names to build to.
// Steps #1 and #4, which pass on main; #2 and #3 are written in J-identity-10-choices.pw.mjs (draft).
const J = 'J-identity-10';

// Words a person should never read on these pages: service, code and build words.
const INTERNAL =
  /\bfixture|lifecycle|\bledger\b|partition|identity service|\bnamespace\b|\buserId\b|\bprincipal\b|\btrpc\b|\bsvc-|\b(identity|notify|vendor|preferences|rank)\.[a-z_]+|\bI-[a-z]+-[a-z-]+-\d+/i;

function person(prefix = 'pf') {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

test(`${J} #1 opens Account and copies my UID: the UID in mono type with a Copy button, the rank card, no internal words`, async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const who = person('pfa');
  await signUpInBrowser(page, who);
  const { userId } = await api(who);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/uc/account');

  // The UID is the account's own id, shown whole, in a monospace face.
  const section = page.locator('section[aria-label="Account ID"]');
  const uid = section.getByTestId('subaccounts__ref');
  await expect(uid).toHaveText(userId);
  expect(await uid.evaluate((node) => getComputedStyle(node).fontFamily), 'the UID is set in mono type').toMatch(/mono/i);

  // Copy puts exactly that UID on the clipboard and says so.
  const copy = section.getByRole('button', { name: 'Copy account ID' });
  await expect(copy).toHaveText('Copy');
  await copy.click();
  await expect(copy).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(userId);

  // The rank card is on the page, loaded.
  const rank = page.getByTestId('rank-perks');
  await expect(rank).toBeVisible();
  await expect(rank).toContainText(/Rank \d+/);

  // No internal words anywhere on Account.
  await expect(page.getByTestId('acct')).toBeVisible();
  expect(await page.getByTestId('acct').innerText()).not.toMatch(INTERNAL);
});

test(`${J} #4 sees my rank and perks on Account: rank, XP and the perks the rank unlocks, read from the rank table`, async ({ page }) => {
  test.setTimeout(120_000);
  const who = person('pfr');
  await signUpInBrowser(page, who);
  const client = await api(who);
  // The account's own rank and the perks identity reads for it from the rank table.
  const rankRes = await client.get('/api/identity/trpc/rank.get');
  expect(rankRes.status, JSON.stringify(rankRes.body).slice(0, 300)).toBe(200);
  const rank = rankRes.body.result.data;
  const perksRes = await client.get('/api/identity/trpc/rank.perks');
  expect(perksRes.status, JSON.stringify(perksRes.body).slice(0, 300)).toBe(200);
  const perks = perksRes.body.result.data;

  await page.goto('/uc/account');
  const card = page.getByTestId('rank-perks');
  await expect(card).toBeVisible();
  // Rank and XP, as identity holds them.
  await expect(card).toContainText(`Rank ${rank.rank}`);
  await expect(card).toContainText('Lifetime XP');
  await expect(card).toContainText(new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(BigInt(rank.xp)));
  if (rank.nextRankAt !== null) {
    await expect(card).toContainText('XP to next rank');
    await expect(card).toContainText(new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(BigInt(rank.nextRankAt)));
  }
  // The perks this rank unlocks, as the rank table gives them.
  await expect(card).toContainText('Current perks');
  await expect(card).toContainText('Trading fee discount');
  await expect(card).toContainText(`${perks.feeDiscountBps / 100}%`);
  expect(await card.innerText()).not.toMatch(INTERNAL);
});
