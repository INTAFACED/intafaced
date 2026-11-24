// World: restart, stack
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { ROOT } from './stack.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { TEST_VENUE, TEST_VENUE_B, testVenueAt, testVenueInfoAt, venueForThisFile } from './venue.mjs';

// J-ops-console-28, "Our builder fees keep coming in because our builder address stays in the venue's required mode", in
// the founder console against the stack's two TEST venue simulators (LOCAL_STACK_USER_VENUE=two). One test per step,
// titled "J-ops-console-28 #<n>", run in order. The person is the stack's TEST founder. Our builder address and the named
// alert contact are the stack's labelled TEST owner values (tooling/profiles/test-owner-values/trade.json). Every mode
// is the TEST venue's own figure; every switch is the TEST venue simulator's, never the console's. The view moves nothing.
const J = 'J-ops-console-28';
const VIEW = `${ADMIN}/trade-ops/builder-account`;
const OWNER_VALUES = JSON.parse(readFileSync(path.join(ROOT, 'tooling/profiles/test-owner-values/trade.json'), 'utf8')).values;
const BUILDER = OWNER_VALUES.TRADE_USER_VENUE_BUILDER_ADDRESS.value.toLowerCase();
const CONTACT = OWNER_VALUES.TRADE_BUILDER_MODE_ALERT_CONTACT.value;
const UTC_SECOND = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) UTC$/;

test.describe.configure({ mode: 'serial' });

async function at(base, p, body) {
  const { status, body: out } = await testVenueAt(base, p, body);
  expect(status, JSON.stringify(out).slice(0, 300)).toBe(200);
  return out;
}
const both = async () => [await testVenueInfoAt(TEST_VENUE), await testVenueInfoAt(TEST_VENUE_B)];
/** The TEST venue's own record of our builder address's mode and the mode it requires (what the console must equal). */
const venueMode = async (venue) => (await at(venue.base, '/builder-account-mode', { builder: BUILDER })).value;
/** The TEST venue simulator's switches: our builder address's mode, its account down, the requirement unpublished. */
// The mode is our builder address's own account mode, moved by the switch J-derivatives-29 moves any account's mode by.
const switchMode = (venue, mode) =>
  at(venue.base, '/test/account-mode', { account: { venueId: venue.id, owner: BUILDER, subAccount: null }, mode });
const switchDown = (venue, down) => at(venue.base, '/test/account-switches', { owner: BUILDER, down });
const switchRequirement = (venue, unpublished) => at(venue.base, '/test/switches', { builderModeRequirementUnpublished: unpublished });
const secondsOf = (text) => new Date(`${UTC_SECOND.exec(text.trim())[1].replace(' ', 'T')}Z`).getTime();

// Every switch this file moves is put back, whatever a step left (registered before the door's own afterAll, so the
// TEST venues still answer).
test.afterAll(async () => {
  for (const venue of await both()) {
    await switchMode(venue, 'standard');
    await switchDown(venue, false);
    await switchRequirement(venue, false);
  }
});
venueForThisFile(test, 'two');
// Starts: our builder address in standard mode at each TEST venue (a new account there starts in another mode).
test.beforeAll(async () => {
  for (const venue of await both()) await switchMode(venue, 'standard');
});

let founder;
async function openView(browser) {
  if (!founder) {
    founder = await (await browser.newContext()).newPage();
    await founderSignIn(founder);
  }
  await founder.goto(VIEW);
  await expect(founder.getByTestId('builder-account-venues')).toBeVisible({ timeout: 60_000 });
  return founder;
}
const row = (page, venue) => page.getByTestId('builder-account-venues').locator(`tr[data-venue="${venue.id}"]`);
const cell = (r, name) => r.locator(`[data-cell="${name}"]`);
/** This run's alerts at `venue`: opened at or after `since` (the builder address is the whole stack's). */
async function alertsSince(page, venue, since) {
  const rows = page.locator(`[data-testid="builder-account-alerts"] tr[data-venue="${venue.id}"]`);
  const out = [];
  for (const r of await rows.all()) {
    const openedAt = await r.getAttribute('data-opened-at');
    if (new Date(openedAt).getTime() >= since.getTime() - 1000) out.push(r);
  }
  return out;
}

/** The alert of #2, which #3 sees cleared. */
let episode;

test(`${J} #1 opens the builder account at each venue: our builder address's mode as the venue reports it, with its as-of time, beside the mode the venue requires for builder fees, or "not published"; a mode that can't be read reads "unknown"`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const venues = await both();
  const before = Date.now() - 2000;
  const page = await openView(browser);
  for (const venue of venues) {
    const own = await venueMode(venue);
    expect(own.mode, `${venue.displayName} reports our builder address's mode`).toMatchObject({ known: true });
    expect(own.required, `${venue.displayName} publishes the mode it requires`).toMatchObject({ known: true });
    const r = row(page, venue);
    await expect(r).toBeVisible();
    await expect(r).toHaveAttribute('data-verdict', 'required_mode');
    await expect(cell(r, 'builder')).toHaveText(BUILDER);
    await expect(cell(r, 'venue')).toContainText('TEST');
    // The mode as the venue reports it, marked TEST, with the venue's time for it.
    await expect(cell(r, 'mode')).toHaveText(`${own.mode.value}TEST`);
    const asOf = (await cell(r, 'as-of').innerText()).trim();
    expect(asOf).toMatch(UTC_SECOND);
    expect(secondsOf(asOf)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(secondsOf(asOf)).toBeLessThanOrEqual(Date.now() + 2000);
    // Beside it, the mode the venue requires for collecting builder fees.
    await expect(cell(r, 'required')).toHaveText(own.required.value);
    expect(own.required.value).toBe('standard');
    expect(own.mode.value).toBe('standard');
  }
  // The named alert contact the starting state names.
  await expect(page.getByTestId('builder-account-alerting')).toContainText(CONTACT);

  // A venue that publishes no required mode: "not published", and no verdict of ok.
  const [, b] = venues;
  await switchRequirement(b, true);
  try {
    expect((await venueMode(b)).required).toEqual({ known: false });
    await openView(browser);
    await expect(row(page, b)).toHaveAttribute('data-verdict', 'not_published');
    await expect(cell(row(page, b), 'required')).toHaveText('not published');
    await expect(cell(row(page, b), 'verdict')).not.toContainText('Collected');
  } finally {
    await switchRequirement(b, false);
  }

  // A venue whose mode can't be read: "unknown", never "ok".
  await switchDown(b, true);
  try {
    expect((await testVenueAt(b.base, '/builder-account-mode', { builder: BUILDER })).status).toBe(422);
    await openView(browser);
    const r = row(page, b);
    await expect(r).toHaveAttribute('data-verdict', 'unknown');
    await expect(cell(r, 'mode')).toContainText(/^unknown/);
    await expect(cell(r, 'as-of')).toHaveText('unknown');
    await expect(cell(r, 'verdict')).toHaveText('unknown');
    await expect(cell(r, 'verdict')).not.toContainText(/ok|Collected/i);
    // The other venue still reads.
    await expect(row(page, venues[0])).toHaveAttribute('data-verdict', 'required_mode');
  } finally {
    await switchDown(b, false);
  }
  await openView(browser);
  await expect(row(page, b)).toHaveAttribute('data-verdict', 'required_mode');
  await expect(cell(row(page, b), 'required')).toHaveText('standard');
});

test(`${J} #2 with the account switched out of standard mode (TEST venue simulator switch): sees "Builder fees not collected in this mode" and one alert to the named contact, not one per check`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const [a] = await both();
  const since = new Date();
  await switchMode(a, 'unified');
  expect((await venueMode(a)).mode).toEqual({ known: true, value: 'unified' });
  const page = await openView(browser);
  const r = row(page, a);
  await expect(r).toHaveAttribute('data-verdict', 'not_collected');
  await expect(cell(r, 'mode')).toHaveText('unifiedTEST');
  await expect(cell(r, 'required')).toHaveText('standard');
  await expect(cell(r, 'verdict')).toHaveText('Builder fees not collected in this mode');
  // Several checks: each read of the view is one, beside the job's own every 2 seconds on the stack.
  for (let i = 0; i < 4; i += 1) {
    await openView(browser);
    await expect(cell(row(page, a), 'verdict')).toHaveText('Builder fees not collected in this mode');
  }
  const alerts = await alertsSince(page, a, since);
  expect(alerts, 'one alert for this episode, however many checks saw it').toHaveLength(1);
  const [alert] = alerts;
  await expect(alert).toHaveAttribute('data-state', 'open');
  await expect(cell(alert, 'contact')).toHaveText(CONTACT);
  await expect(cell(alert, 'mode')).toHaveText('unified');
  await expect(cell(alert, 'required')).toHaveText('standard');
  episode = await alert.getAttribute('data-alert');
});

test(`${J} #3 with the account switched back to standard mode (TEST venue simulator switch): the view reads the required mode again and the alert is marked cleared with the time`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  if (!episode) throw new Error(`${J} #2 left no alert, so this step has nothing to see cleared`);
  const [a] = await both();
  const back = Date.now();
  await switchMode(a, 'standard');
  expect((await venueMode(a)).mode).toEqual({ known: true, value: 'standard' });
  const page = await openView(browser);
  const r = row(page, a);
  await expect(r).toHaveAttribute('data-verdict', 'required_mode');
  await expect(cell(r, 'mode')).toHaveText('standardTEST');
  await expect(cell(r, 'required')).toHaveText('standard');
  await expect(cell(r, 'verdict')).not.toContainText('not collected');
  const alert = page.locator(`[data-testid="builder-account-alerts"] tr[data-alert="${episode}"]`);
  await expect(alert).toHaveAttribute('data-state', 'cleared');
  const state = (await cell(alert, 'state').innerText()).trim();
  const m = /^Cleared (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC)/.exec(state);
  expect(m, `the alert reads cleared with its time: ${state}`).not.toBeNull();
  expect(secondsOf(m[1])).toBeGreaterThanOrEqual(Math.floor(back / 1000) * 1000 - 1000);
  expect(secondsOf(m[1])).toBeLessThanOrEqual(Date.now() + 2000);
  // Still one alert for the episode: clearing opened nothing new.
  const open = page.locator(`[data-testid="builder-account-alerts"] tr[data-venue="${a.id}"][data-state="open"]`);
  await expect(open).toHaveCount(0);
  await founder?.context().close();
  founder = undefined;
});
