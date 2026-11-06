import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { ROOT, signUpInBrowser, tool } from './stack.mjs';

// J-identity-06 #4, in the running app (docs/roadmap/journeys.json): I set a shorter idle sign-out. A shorter value than
// the owner's applies, a longer one is refused, and the fourth sign-in beyond the owner's limit ends the oldest device.
// Tests titled "J-identity-06 #<n>" prove a whole step. The owner has published neither number, so the stack keeps both
// blank; this step restarts identity with the profile's labelled TEST values (an idle limit of 60 minutes, three
// devices; LOCAL_STACK_IDENTITY_SESSION_LIMITS=on) and puts it back afterwards, passed or failed.
const J = 'J-identity-06';

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

/** Identity restarted with its TEST session limits on, or back to both blank. */
function sessionLimits(on) {
  const before = process.env.LOCAL_STACK_IDENTITY_SESSION_LIMITS;
  if (on) process.env.LOCAL_STACK_IDENTITY_SESSION_LIMITS = 'on';
  else delete process.env.LOCAL_STACK_IDENTITY_SESSION_LIMITS;
  try {
    tool('local-test-stack.mjs', 'restart', 'identity');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_IDENTITY_SESSION_LIMITS;
    else process.env.LOCAL_STACK_IDENTITY_SESSION_LIMITS = before;
  }
}

async function signIn(page, who) {
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** The account's live sign-in families, in the order they signed in (a family's first row is its sign-in). */
async function liveFamilies(sql, email) {
  const rows = await sql`
    SELECT s.family_id FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE lower(u.email) = lower(${email})
    GROUP BY s.family_id HAVING bool_or(s.revoked = false AND s.expires_at > now())
    ORDER BY min(s.created_at)`;
  return rows.map((row) => row.family_id);
}

const card = (page) => page.getByRole('region', { name: 'Idle sign-out' });
const signedOut = (page) => page.getByRole('heading', { name: 'Sign in to continue' });

test(`${J} #4 sets a shorter idle sign-out: a shorter value than the owner's applies, a longer one is refused, and the fourth sign-in beyond the owner's limit ends the oldest device`, async ({
  browser,
  page,
}) => {
  test.setTimeout(300_000);
  const sql = await identityDb();
  const contexts = [];
  sessionLimits(true);
  try {
    const who = person('il');
    await signUpInBrowser(page, who);
    await page.goto('/uc/safe');
    const limits = card(page);
    await expect(limits.getByRole('heading', { name: 'Idle sign-out' })).toBeVisible({ timeout: 15_000 });
    await expect(limits.getByTestId('session-limits__owner')).toHaveText(
      'A sign-in not used for 60 minutes ends by itself. That is the longest allowed.',
    );
    await expect(limits.getByTestId('session-limits__devices')).toHaveText(
      'Up to 3 devices can be signed in at once. Signing in on one more ends the one signed in longest ago.',
    );

    // A longer time than the owner's is refused by identity, and nothing changes.
    await limits.getByLabel('Sign me out after this many minutes unused').fill('90');
    await limits.getByRole('button', { name: 'Save' }).click();
    await expect(limits.getByRole('alert')).toHaveText(
      'Choose from 1 minute up to 60 minutes. A longer time than the limit is not allowed. Nothing was changed.',
    );
    await expect(limits.getByTestId('session-limits__chosen')).toHaveText(
      'You have not chosen a shorter time, so the limit above applies.',
    );

    // A shorter one is kept.
    await limits.getByLabel('Sign me out after this many minutes unused').fill('5');
    await limits.getByRole('button', { name: 'Save' }).click();
    await expect(limits.getByRole('status').filter({ hasText: 'Saved.' })).toHaveText(
      'Saved. Your sign-ins now end after 5 minutes unused.',
    );
    await expect(limits.getByTestId('session-limits__chosen')).toHaveText('You chose 5 minutes: your sign-ins end after that long unused.');

    // And it applies: the person leaves the page unused for six minutes (well inside the owner's 60). The page records
    // when it was last used (idle-clock.ts) and its next refresh says so; that refresh ends the sign-in.
    await page.evaluate(() => localStorage.setItem('ifc-last-activity', String(Date.now() - 6 * 60_000)));
    await page.reload();
    await expect(signedOut(page)).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText('You were signed out because this sign-in was not used for longer than your idle sign-out time.'),
    ).toBeVisible();
    expect(await liveFamilies(sql, who.email), 'the idle sign-in has ended').toEqual([]);

    // The owner's limit of three devices: three sign-ins stay, the fourth ends the oldest.
    // Back in use: the first browser signs in again and is used now.
    await signIn(page, who);
    await page.evaluate(() => localStorage.setItem('ifc-last-activity', String(Date.now())));
    const browsers = [page];
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext();
      contexts.push(context);
      const other = await context.newPage();
      await signIn(other, who);
      browsers.push(other);
    }
    const three = await liveFamilies(sql, who.email);
    expect(three).toHaveLength(3);
    const fourthContext = await browser.newContext();
    contexts.push(fourthContext);
    const fourth = await fourthContext.newPage();
    await signIn(fourth, who);
    const after = await liveFamilies(sql, who.email);
    expect(after, 'still three devices signed in').toHaveLength(3);
    expect(after, 'the oldest sign-in ended').not.toContain(three[0]);
    expect(after.slice(0, 2), 'the two newer ones stay').toEqual(three.slice(1));

    // The oldest device (the first browser) is signed out at its next refresh; the newest one keeps working.
    await page.reload();
    await expect(signedOut(page)).toBeVisible({ timeout: 15_000 });
    await fourth.goto('/uc/safe');
    await expect(card(fourth).getByRole('heading', { name: 'Idle sign-out' })).toBeVisible({ timeout: 15_000 });
    await expect(signedOut(fourth)).toHaveCount(0);
  } finally {
    for (const context of contexts) await context.close();
    await sql.end();
    sessionLimits(false);
  }
});
