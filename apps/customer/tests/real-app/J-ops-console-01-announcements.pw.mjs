import { expect, test } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-ops-console-01 #10: founder A sets an announcement banner with a window, and personal preferences. The banner shows on
// every console page only inside its window, and only one is active: a second one over the same window is refused
// `ops.banner_conflict`, a later one waits as scheduled. Preferences: the organisation sets a time zone and a week start, A
// sets their own time zone and home page; A's own win for A, the organisation's for B. Announcements and preferences are
// svc-ops' own records (OPS-admin-access-08), so the test withdraws what it published and clears what it set, even when a
// step fails.

const RUN = `TEST J-ops-console-01 #10 ${Date.now().toString(36)}`;
const HOUR = 3_600_000;

/** A `datetime-local` value for an instant in a time zone. */
function wallClock(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** One console change from this page, with its CSRF token: the BFF's answer as { status, body }. */
async function post(page, path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { path, body },
  );
}

async function announcements(page) {
  return page.evaluate(async () => (await (await fetch('/api/console-announcements', { cache: 'no-store' })).json()).view);
}

/** Withdraw every announcement that could still show, so this run starts and ends with none. */
async function withdrawAll(page) {
  const view = await announcements(page);
  if (view?.kind !== 'read') return;
  const now = Date.parse(view.data.asOf);
  for (const a of view.data.items)
    if (a.status !== 'withdrawn' && Date.parse(a.endsAt) > now)
      await post(page, '/api/console-announcements', { op: 'withdraw', id: a.id });
}

const BLANK = { theme: '', homePage: '', timeZone: '', weekStart: '' };

async function preferences(page) {
  return page.evaluate(async () => (await (await fetch('/api/console-preferences', { cache: 'no-store' })).json()).view);
}

/** Clear a level back to nothing set, from the revision stored now. */
async function clearLevel(page, level) {
  const view = await preferences(page);
  if (view?.kind !== 'read') return;
  await post(page, '/api/console-preferences', { level, expectedRevision: view.data.levels[level].revision, values: BLANK });
}

async function fillAnnouncement(page, { kind, title, start, end, link }) {
  const form = page.getByTestId('announcement-form');
  await form.getByLabel('Kind').selectOption(kind);
  await form.getByLabel('Title').fill(title);
  await form.getByLabel('Message').fill('Expect slower desks for ten minutes.');
  if (link) {
    await form.getByLabel('With it').selectOption('link');
    await form.getByLabel(/^Link \(/).fill(link.url);
    await form.getByLabel('Link label').fill(link.label);
  }
  await form.getByLabel(/^Shows from/).fill(start);
  await form.getByLabel(/^Until/).fill(end);
}

test('J-ops-console-01 #10 an announcement banner with a window, one at a time, and the most specific preference wins', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const founderA = await founderSignIn(a, 'a');
  await founderSignIn(b, 'b');

  try {
    await withdrawAll(a);

    // Preferences: the organisation's time zone and week start, then A's own time zone and home page.
    await a.goto(`${ADMIN}/crm`, { waitUntil: 'load' });
    await expect(a.getByRole('button', { name: /^Search/ })).toBeEnabled();
    await a.keyboard.press('Control+k');
    await a.keyboard.type('preferences');
    await a.keyboard.press('Enter');
    await a.waitForURL((url) => url.pathname === '/system/profile', { timeout: 60_000 });
    await expect(a.getByRole('heading', { level: 1, name: 'Profile and preferences' })).toBeVisible();
    await expect(a.getByTestId('preferences-team-blocker')).toContainText('ops.preferences_team_unassigned');

    const org = a.getByTestId('preferences-form-organisation');
    await org.getByLabel('Time zone').fill('Europe/Berlin');
    await org.getByLabel('Week starts on').selectOption('sunday');
    await org.getByRole('button', { name: /^Save the organisation/ }).click();
    await expect(a.getByTestId('preferences-outcome')).toContainText('preferences saved');

    const mine = a.getByTestId('preferences-form-person');
    // A value the console does not take is refused by name, and nothing changes.
    await mine.getByLabel('Time zone').fill('Mars/Olympus');
    await mine.getByRole('button', { name: 'Save yours' }).click();
    await expect(a.getByTestId('preferences-outcome')).toHaveAttribute('data-code', 'ops.preference_invalid');
    await mine.getByLabel('Time zone').fill('Asia/Dubai');
    await mine.getByLabel(/^Home page/).fill('/ledger');
    await mine.getByRole('button', { name: 'Save yours' }).click();
    await expect(a.getByTestId('preferences-outcome')).toContainText('preferences saved');

    // Key by key, the most specific level that sets it wins.
    await expect(a.getByTestId('preference-timeZone-effective')).toHaveAttribute('data-from', 'person');
    await expect(a.getByTestId('preference-timeZone-effective')).toContainText('Asia/Dubai');
    await expect(a.getByTestId('preference-weekStart-effective')).toHaveAttribute('data-from', 'organisation');
    await expect(a.getByTestId('preference-weekStart-effective')).toContainText('Sunday');
    await expect(a.getByTestId('preference-theme-effective')).toHaveAttribute('data-from', 'server');
    await expect(a.getByTestId('console-home-link')).toHaveAttribute('href', '/ledger');
    // B has set nothing: the organisation's time zone, and the server's home page.
    await b.goto(`${ADMIN}/system/profile`, { waitUntil: 'load' });
    await expect(b.getByTestId('preference-timeZone-effective')).toHaveAttribute('data-from', 'organisation');
    await expect(b.getByTestId('preference-timeZone-effective')).toContainText('Europe/Berlin');
    await expect(b.getByTestId('console-home-link')).toHaveAttribute('href', '/crm');
    // A save from an old read never overwrites another founder's change unseen.
    const stale = await post(b, '/api/console-preferences', { level: 'organisation', expectedRevision: 0, values: BLANK });
    expect(stale.body?.code).toBe('ops.preferences_stale');

    // An announcement for the next hour, typed in A's own time zone, published at once.
    await a.goto(`${ADMIN}/tools/announcements`, { waitUntil: 'load' });
    await expect(a.getByRole('heading', { level: 1, name: 'Announcements' })).toBeVisible();
    await expect(a.getByTestId('announcement-form').getByLabel(/^Shows from/)).toBeVisible();
    await expect(a.getByText('Shows from (Asia/Dubai)')).toBeVisible();
    const now = Date.now();
    const first = `${RUN} ledger upgrade`;
    await fillAnnouncement(a, {
      kind: 'warning',
      title: first,
      start: wallClock(now - 5 * 60_000, 'Asia/Dubai'),
      end: wallClock(now + HOUR, 'Asia/Dubai'),
      link: { url: '/ledger', label: 'Ledger desk' },
    });
    // A window that ends before it starts is refused before anything is sent.
    await a
      .getByTestId('announcement-form')
      .getByLabel(/^Until/)
      .fill(wallClock(now - HOUR, 'Asia/Dubai'));
    await expect(a.getByTestId('announcement-form')).toContainText('The window ends before it starts.');
    await expect(a.getByTestId('announcement-form').getByRole('button', { name: 'Publish' })).toBeDisabled();
    await a
      .getByTestId('announcement-form')
      .getByLabel(/^Until/)
      .fill(wallClock(now + HOUR, 'Asia/Dubai'));
    await a.getByTestId('announcement-form').getByRole('button', { name: 'Publish' }).click();
    await expect(a.getByTestId('announcements-outcome')).toContainText('announcement published');
    const firstRow = a.getByTestId('announcement-row').filter({ hasText: first });
    await expect(firstRow).toHaveAttribute('data-phase', 'active');
    const firstId = await firstRow.getAttribute('data-announcement-id');

    // The banner shows on every page, for both founders, with its end in each founder's own time zone.
    await a.goto(`${ADMIN}/ledger`, { waitUntil: 'load' });
    const bannerA = a.getByTestId('announcement-banner');
    await expect(bannerA).toHaveAttribute('data-announcement-id', firstId);
    await expect(bannerA).toHaveAttribute('data-tone', 'warn');
    await expect(bannerA).toContainText(first);
    await expect(bannerA).toContainText('(Asia/Dubai)');
    await expect(bannerA.getByTestId('announcement-link')).toHaveAttribute('href', '/ledger');
    await b.goto(`${ADMIN}/crm`, { waitUntil: 'load' });
    await expect(b.getByTestId('announcement-banner')).toContainText(first);
    await expect(b.getByTestId('announcement-banner')).toContainText('(Europe/Berlin)');

    // Only one at a time: a second over the same window is refused, and the first still shows.
    await a.goto(`${ADMIN}/tools/announcements`, { waitUntil: 'load' });
    await fillAnnouncement(a, {
      kind: 'information',
      title: `${RUN} overlapping`,
      start: wallClock(now, 'Asia/Dubai'),
      end: wallClock(now + 2 * HOUR, 'Asia/Dubai'),
    });
    await a.getByTestId('announcement-form').getByRole('button', { name: 'Publish' }).click();
    await expect(a.getByTestId('announcements-outcome')).toHaveAttribute('data-code', 'ops.banner_conflict');
    await expect(a.getByTestId('announcement-banner')).toHaveAttribute('data-announcement-id', firstId);

    // A later window is published as scheduled, and does not show yet.
    const later = `${RUN} later`;
    await fillAnnouncement(a, {
      kind: 'information',
      title: later,
      start: wallClock(now + 2 * HOUR, 'Asia/Dubai'),
      end: wallClock(now + 3 * HOUR, 'Asia/Dubai'),
    });
    await a.getByTestId('announcement-form').getByRole('button', { name: 'Publish' }).click();
    await expect(a.getByTestId('announcements-outcome')).toContainText('announcement published');
    await expect(a.getByTestId('announcement-row').filter({ hasText: later })).toHaveAttribute('data-phase', 'scheduled');
    await expect(a.getByTestId('announcement-banner')).toHaveAttribute('data-announcement-id', firstId);
    const view = await announcements(a);
    expect(view.data.active.id, 'svc-ops names one active announcement').toBe(firstId);

    // Withdrawn, it is gone from every page.
    await a.getByTestId('announcement-row').filter({ hasText: first }).getByRole('button', { name: 'Withdraw' }).click();
    await expect(a.getByTestId('announcements-outcome')).toContainText('announcement withdrawn');
    await b.goto(`${ADMIN}/crm`, { waitUntil: 'load' });
    await expect(b.getByTestId('announcement-banner')).toHaveCount(0);
  } finally {
    await withdrawAll(a);
    await clearLevel(a, 'person');
    await clearLevel(a, 'organisation');
  }
  const prefs = await preferences(a);
  expect(prefs.data.personId).toBe(founderA.userId);
  expect(prefs.data.effective.timeZone).toEqual({ value: 'UTC', from: 'server' });
  expect((await announcements(a)).data.active).toBeNull();
});
