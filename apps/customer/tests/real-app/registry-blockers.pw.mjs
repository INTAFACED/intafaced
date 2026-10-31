import { test, expect } from '@playwright/test';
import { signIn, signUp, verify } from './desk.mjs';
import { matchPath } from '../../src/app/path-match.ts';
import { features } from '../../src/app/feature-registry.ts';
import { journeyState } from './stack.mjs';

// The blocked-room sweep: every feature-registry row that is not live is opened in the running app, signed in as a
// verified TEST account. Blocked means reachable and not yet proven live (AGENTS.md), so each of its rooms must render
// as itself, and a row whose reason is a real blocker must name it on screen, in the words below. A blocked row with no
// entry here fails, so a new blocked room cannot go silent. One test per row, titled "registry blocker: <row id>".
//
// Each entry is one of:
// - { at, shows }: the room at `at`, one of the row's own routes, shows `shows`, the sentence that names its blocker.
// - { proof }: the reason is proof state only (no journey proves the room yet); the room renders and needs no blocker line.
// - { silent }: the room names no blocker where the person sees it. The test fails by name until the room says it.
// - { noRoute }: the row has no route of its own (a switch or a section).
const SWEEP = {
  deposit: { at: '/uc/recharge', shows: 'Needs a payment partner, which is not connected.' },
  withdraw: { at: '/uc/withdraw', shows: 'no custody signer is set up' },
  'supported-assets': { proof: 'its reason is that the asset registry is unproven on main' },
  'repeat-buy': { silent: 'the room does not say that scheduled transfers are switched off' },
  'bank-recovery-claim': { proof: 'its reason is that its journey does not yet prove the claim' },
  'bank-direct-debits': { at: '/bank/direct-debits', shows: 'not a scheme, not a creditor anyone knows' },
  'bank-rules': { at: '/bank/rules', shows: 'Not connected in this build, so nothing is sent here.' },
  'bank-loan-apply': { silent: 'the room says no loan is offered but not that the fee table and rate tiers are unset' },
  'bank-loan-detail': {
    proof: 'a loan detail names its unset payoff fee only for an open loan, and none can be opened (bank-loan-apply, bank-loans)',
  },
  'bank-statements': { silent: 'the past-balance refusal shows only after Download is pressed' },
  'bank-calendar': { at: '/bank/calendar', shows: 'no bill payment partner is connected' },
  'bank-earn': { at: '/bank/earn', shows: 'No earn rates are configured' },
  'bank-loans': { at: '/bank/loans', shows: 'Borrowing requires a configured open product' },
  'bank-cards': { at: '/bank/cards', shows: 'no live card issuer is connected' },
  'bank-ramps': { at: '/bank/ramps', shows: 'No payment provider is connected.' },
  'bank-analytics': { proof: 'its reason is that no journey proves the room' },
  'bank-business': { at: '/bank/business', shows: 'Registered company accounts need business verification' },
  'margin-futures-options': { at: '/trade/options', shows: 'The rule for which asset settles an option is not published.' },
  copy: { silent: 'the room does not say that the leader fee share and the allowed countries are not approved' },
  'execution-quote': { proof: 'its reason is that it is not a first-release customer path' },
  'simulated-markets': { noRoute: true },
  'request-bills-global': { at: '/pay/bills', shows: 'No biller network or bill-payment service is connected' },
  'pay-request-detail': { at: '/pay/request/TEST-not-a-record', shows: 'The request service is not connected' },
  'pay-scheduled-preferences': { at: '/pay/scheduled', shows: 'No service stores a payment for a later date' },
  'pay-contacts': { at: '/pay/contacts', shows: 'Saved contacts, groups and pools are not stored by any service.' },
  'pay-payment-detail': { at: '/pay/history/TEST-not-a-record', shows: 'Reporting a payment and getting it back are not connected.' },
  'pay-claim': { at: '/pay/claim/TEST-not-a-record', shows: 'Sending to someone without an account is not connected' },
  'pay-cases': { at: '/pay/cases', shows: 'The case desk is not connected' },
  'pay-terms': { at: '/pay/send/limits', shows: 'No limits are published, so none is shown.' },
  'pay-scan': { at: '/pay/scan', shows: 'A payment code or link from this app opens Send' },
  'pay-bill-detail': { at: '/pay/bills/invoices/TEST-not-a-record', shows: 'there is no biller network behind INTAFACED' },
  'oauth-apps': { silent: 'the room does not say that the code and token lifetimes are unset' },
  'developer-portal': { at: '/developers', shows: 'No access tiers are published in this build' },
  'trade-news-calendar': { at: '/trade/news', shows: 'News needs a news data feed.' },
  p2p: { at: '/p2p', shows: 'need the owner’s instrument encryption provider' },
  'more-rooms': { proof: 'its reason is that it is not a first-release customer path' },
  'promotions-dividends': { proof: 'its reason is that the room is not redesigned' },
  'strategy-subaccounts': { noRoute: true },
  'public-extras': { at: '/notice', shows: 'No public notices are published' },
};

const run = journeyState(`registry-blockers-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const blocked = features.filter((feature) => feature.status === 'blocked');
/** A route the row owns, with a TEST stand-in for each parameter; a trailing `*` names a family, not a page. */
const routes = (feature) =>
  feature.paths
    .filter((path) => !path.endsWith('*'))
    .map((path) => path.replace(/:asset\b/g, 'BTC').replace(/:[A-Za-z]+/g, 'TEST-not-a-record'));

test.describe.configure({ mode: 'default' });

test('registry blocker sweep starts: a verified TEST account', async ({ page }) => {
  test.setTimeout(180_000);
  // Nothing from an earlier run is read as this run's, even when this start fails.
  run.reset({});
  const who = await signUp(page, 'rbs');
  await verify(page, who);
  run.reset({ who });
});

test('every blocked registry row has a sweep entry, and every entry is a blocked row', () => {
  expect(blocked.map((feature) => feature.id).sort()).toEqual(Object.keys(SWEEP).sort());
  for (const feature of blocked) {
    const at = SWEEP[feature.id]?.at;
    if (at) expect(routes(feature), `${feature.id} checks its blocker at its own route`).toContain(at);
  }
});

for (const feature of blocked) {
  test(`registry blocker: ${feature.id}`, async ({ page }) => {
    test.setTimeout(30_000 + 8_000 * routes(feature).length);
    const entry = SWEEP[feature.id];
    if (!entry) throw new Error(`${feature.id} is blocked and has no sweep entry: add what its room shows to registry-blockers.pw.mjs`);
    if (entry.noRoute) {
      expect(routes(feature), `${feature.id} is marked as having no route`).toEqual([]);
      return;
    }
    const { who } = run.read();
    if (!who) throw new Error('the sweep start left no account, so no room can be opened');
    // Each row signs in on its own: identity rotates the refresh token, so one saved session cannot serve every room.
    await signIn(page, who);
    // Blocked is reachable: every route of the row opens a room of the row (an old address may land on its new one).
    const ownsPath = (pathname) => feature.paths.some((pattern) => pattern === pathname || matchPath(pattern, pathname) !== undefined);
    for (const path of routes(feature)) {
      await page.goto(path);
      await expect(page.locator('main h1, h1').first(), path).toBeVisible();
      expect(ownsPath(new URL(page.url()).pathname), `${path} landed on ${page.url()}`).toBe(true);
      await expect(page.locator('main h1, h1').first(), path).not.toHaveText(/page not found/i);
      await expect(page.getByText('This destination has no customer route'), path).toHaveCount(0);
    }
    if (entry.silent)
      throw new Error(`${feature.id}: its room names no blocker where the person sees it: ${entry.silent} (reason: ${feature.reason})`);
    if (entry.proof) return;
    if (new URL(page.url()).pathname !== entry.at) await page.goto(entry.at);
    await expect(page.getByText(entry.shows, { exact: false }).first(), `${feature.id} at ${entry.at}`).toBeVisible();
  });
}
