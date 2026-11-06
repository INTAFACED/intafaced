// World: none
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { ORIGIN, ROOT, signUpInBrowser } from './stack.mjs';

// J-identity-06, in the running app (docs/roadmap/journeys.json): I see where I am signed in and sign out the rest.
// Tests titled "J-identity-06 #<n>" prove a whole step.
const J = 'J-identity-06';

test.describe.configure({ mode: 'default' });

/** A second browser that reports itself as Firefox on Windows, so its row reads apart from this Chrome one. */
const OTHER_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';

function person(prefix) {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

/** svc-identity's own database role on the stack (loopback, the marker's postgres port, the stack's secret). */
async function identityDb() {
  const ctx = await makeContext({ log: () => undefined });
  const postgres = createRequire(path.join(ROOT, 'services', 'svc-identity', 'package.json'))('postgres');
  const port = ctx.marker.ports.postgres ?? 15460;
  return postgres(`postgres://svc_identity:${encodeURIComponent(ctx.secrets.pgService)}@127.0.0.1:${port}/intafaced_local_test`, {
    max: 1,
    onnotice: () => {},
  });
}

/** Every session row of the account, live or ended, with its sign-in family. */
async function sessionRows(sql, email) {
  return sql`
    SELECT s.id, s.family_id, s.revoked, s.user_agent FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE lower(u.email) = lower(${email}) ORDER BY s.created_at`;
}

async function signIn(page, who) {
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** The Devices card in Security, and its rows. */
function devicesCard(page) {
  const card = page.getByRole('region', { name: 'Your devices' });
  return { card, rows: card.getByTestId('security__row') };
}

/** Security's session list ("Where you're signed in"), and its rows. */
function sessionsList(page) {
  const list = page.getByRole('list', { name: 'Places you’re signed in' });
  return { list, rows: list.getByRole('listitem') };
}

/** One account signed up in this browser (Chrome on macOS) and signed in on a second browser (Firefox on Windows). */
async function twoDevices(browser, page, prefix) {
  const who = person(prefix);
  await signUpInBrowser(page, who);
  const other = await browser.newContext({ userAgent: OTHER_BROWSER });
  const otherPage = await other.newPage();
  await signIn(otherPage, who);
  return { who, other, otherPage };
}

test(`${J} #1 Security lists one row per device with its last use and no session ids; many refreshes on one device stay one row; a device idle for a day folds behind "Show more"`, async ({
  browser,
  page,
}) => {
  test.setTimeout(150_000);
  const sql = await identityDb();
  const { who, other, otherPage } = await twoDevices(browser, page, 'sa');
  try {
    // The second device refreshes its sign-in several times: each boot rotates the refresh token inside the same family.
    for (let i = 0; i < 4; i++) {
      await otherPage.goto('/uc/safe');
      await expect(devicesCard(otherPage).card).toBeVisible();
    }
    const rows = await sessionRows(sql, who.email);
    const families = new Set(rows.map((row) => row.family_id));
    expect(families.size, 'two devices, two sign-in families').toBe(2);
    const otherFamily = rows.find((row) => row.user_agent === OTHER_BROWSER).family_id;
    expect(
      rows.filter((row) => row.family_id === otherFamily).length,
      'the second device refreshed, so its family holds more than one session row',
    ).toBeGreaterThan(1);

    await page.goto('/uc/safe');
    const { card, rows: shown } = devicesCard(page);
    await expect(shown).toHaveCount(2);
    const mine = shown.filter({ hasText: 'This device' });
    const theirs = shown.filter({ hasText: 'Firefox on Windows' });
    await expect(mine).toHaveCount(1);
    await expect(mine).toContainText('Chrome on macOS');
    await expect(theirs).toHaveCount(1);
    for (const row of [mine, theirs]) await expect(row).toContainText(/Last active \d{1,2} [A-Z][a-z]{2}, \d\d:\d\d/);
    // No session id or family id anywhere on the card, in its text or its markup.
    const markup = await card.evaluate((node) => node.outerHTML);
    for (const row of rows) {
      expect(markup, 'a session id is never shown').not.toContain(row.id);
      expect(markup, 'a family id is never shown').not.toContain(row.family_id);
    }
    await expect(card.getByRole('button', { name: /^Show more/ })).toHaveCount(0);
    // Security's session list shows the same two devices, one row each.
    const sessions = sessionsList(page);
    await expect(sessions.rows).toHaveCount(2);
    // Nowhere on Security does a session or family id show.
    const seen = await page.getByRole('main').innerText();
    for (const row of rows) {
      expect(seen, 'a session id is never shown').not.toContain(row.id);
      expect(seen, 'a family id is never shown').not.toContain(row.family_id);
    }

    // The second device goes idle for over a day (TEST: its sessions' times moved back 25 hours on the stack's database).
    await sql`
      UPDATE sessions SET created_at = created_at - interval '25 hours', last_used_at = last_used_at - interval '25 hours'
      WHERE family_id = ${otherFamily}`;
    await page.reload();
    await expect(shown).toHaveCount(1);
    await expect(shown).toContainText('This device');
    await expect(card).not.toContainText('Firefox on Windows');
    const more = card.getByRole('button', { name: 'Show more (1 idle for over a day)' });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.click();
    await expect(shown).toHaveCount(2);
    await expect(theirs).toHaveCount(1);
    await expect(card.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
    await card.getByRole('button', { name: 'Show fewer' }).click();
    await expect(shown).toHaveCount(1);

    // The session list folds the idle device the same way.
    await expect(sessions.rows).toHaveCount(1);
    await expect(sessions.rows).toContainText('This device');
    const older = page.getByRole('button', { name: 'Show 1 more', exact: true });
    await older.click();
    await expect(sessions.rows).toHaveCount(2);
  } finally {
    await other.close();
    await sql.end();
  }
});

test(`${J} #2 signing out another device ends it at its next refresh while this one keeps working; the current row cannot be signed out here`, async ({
  browser,
  page,
}) => {
  test.setTimeout(150_000);
  const sql = await identityDb();
  const { who, other, otherPage } = await twoDevices(browser, page, 'sb');
  try {
    const listed = page.waitForRequest((r) => new URL(r.url()).pathname.endsWith('/listSessions'));
    await page.goto('/uc/safe');
    const authorization = (await listed).headers().authorization;
    expect(authorization).toMatch(/^Bearer \S+$/);
    const { card, rows } = devicesCard(page);
    await expect(rows).toHaveCount(2);
    const mine = rows.filter({ hasText: 'This device' });
    // The current row offers no sign-out, and the service refuses one for this device's own family, with this
    // browser's own session.
    await expect(mine.getByRole('button')).toHaveCount(0);
    const ownFamily = (await sessionRows(sql, who.email)).find((row) => row.user_agent !== OTHER_BROWSER).family_id;
    const refused = await page.request.post('/api/identity/trpc/revokeSessionFamily', {
      headers: { origin: ORIGIN, authorization, 'content-type': 'application/json' },
      data: { familyId: ownFamily },
    });
    expect(refused.status()).toBe(412);
    expect(await refused.text()).toContain('auth.session_current');
    expect((await sessionRows(sql, who.email)).filter((row) => row.family_id === ownFamily && !row.revoked).length).toBe(1);

    await card.getByRole('button', { name: 'Sign out Firefox on Windows' }).click();
    await expect(card.getByRole('status')).toHaveText('Device signed out.');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('This device');
    const ended = await sessionRows(sql, who.email);
    expect(ended.filter((row) => row.user_agent === OTHER_BROWSER).every((row) => row.revoked)).toBe(true);

    // The other device's next refresh fails: it is signed out.
    await otherPage.goto('/uc/safe');
    await expect(otherPage.getByText('Sign in to continue')).toBeVisible();
    await expect(devicesCard(otherPage).card).toHaveCount(0);

    // This one keeps working: a reload refreshes its sign-in and Security still answers.
    await page.reload();
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('This device');
    await expect(page.getByText('Sign in to continue')).toHaveCount(0);
  } finally {
    await other.close();
    await sql.end();
  }
});

test(`${J} #3 "Sign out everywhere" ends every session, this one included, and the sign-in page opens`, async ({ browser, page }) => {
  test.setTimeout(150_000);
  const sql = await identityDb();
  const { who, other, otherPage } = await twoDevices(browser, page, 'sc');
  try {
    await page.goto('/uc/safe');
    await expect(devicesCard(page).rows).toHaveCount(2);
    await page.getByRole('button', { name: 'Sign out everywhere', exact: true }).click();
    const review = page.getByRole('dialog');
    await expect(review).toContainText('Sign out everywhere?');
    await review.getByRole('button', { name: 'Sign out everywhere', exact: true }).click();

    await expect(page).toHaveURL(/\/login(\?|$)/);
    await expect(page.locator('input[name=identifier]')).toBeVisible();
    const rows = await sessionRows(sql, who.email);
    expect(rows.length).toBeGreaterThan(1);
    expect(
      rows.filter((row) => !row.revoked),
      'every session of the account is ended',
    ).toEqual([]);

    // Neither browser is signed in any more.
    await page.goto('/uc/safe');
    await expect(page.getByText('Sign in to continue')).toBeVisible();
    await otherPage.goto('/uc/safe');
    await expect(otherPage.getByText('Sign in to continue')).toBeVisible();
  } finally {
    await other.close();
    await sql.end();
  }
});
