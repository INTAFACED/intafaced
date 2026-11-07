// World: restart
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { ROOT, signUpInBrowser, tool } from './stack.mjs';

// J-identity-06 #4, in the running app (docs/roadmap/journeys.json): I set a shorter idle sign-out; a shorter value than
// the owner's applies, a longer value is refused, and the fourth sign-in beyond the owner's cap ends the oldest device.
// The owner has published neither setting, so identity is restarted with the stack's labelled TEST values (one hour idle,
// three devices: tooling/profiles/test-owner-values/identity.json) and restarted without them when the step is done.
const J = 'J-identity-06';

test.describe.configure({ mode: 'default' });

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

async function sessionRows(sql, email) {
  return sql`
    SELECT s.id, s.family_id, s.revoked, s.created_at FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE lower(u.email) = lower(${email}) ORDER BY s.created_at`;
}

/** The account's sign-in families that still hold a live session, oldest sign-in first. */
async function liveFamilies(sql, email) {
  const rows = await sessionRows(sql, email);
  const first = new Map();
  for (const row of rows) if (!first.has(row.family_id)) first.set(row.family_id, row.created_at);
  const live = new Set(rows.filter((row) => !row.revoked).map((row) => row.family_id));
  return [...first.keys()].filter((family) => live.has(family));
}

/** Moves every session of one sign-in back by `minutes`, as if the device had been left unused that long (TEST). */
async function leaveIdle(sql, family, minutes) {
  await sql`
    UPDATE sessions SET created_at = created_at - make_interval(mins => ${minutes}),
      last_used_at = last_used_at - make_interval(mins => ${minutes})
    WHERE family_id = ${family}`;
}

async function signIn(page, who) {
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Identity restarted with the TEST idle sign-out and device limit on (`on`) or off again. */
async function sessionLimits(on) {
  const before = process.env.LOCAL_STACK_IDENTITY_SESSION_LIMITS;
  if (on) process.env.LOCAL_STACK_IDENTITY_SESSION_LIMITS = 'on';
  else delete process.env.LOCAL_STACK_IDENTITY_SESSION_LIMITS;
  try {
    await tool('local-test-stack.mjs', 'restart', 'identity');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_IDENTITY_SESSION_LIMITS;
    else process.env.LOCAL_STACK_IDENTITY_SESSION_LIMITS = before;
  }
}

test(`${J} #4 a shorter idle sign-out than the owner's applies; a longer one is refused; the fourth sign-in beyond the owner's cap of three ends the oldest device`, async ({
  browser,
  page,
}) => {
  test.setTimeout(420_000);
  const sql = await identityDb();
  const others = [];
  await sessionLimits(true);
  try {
    // --- A shorter idle sign-out than the owner's applies. ---
    const who = person('il');
    await signUpInBrowser(page, who);
    await page.goto('/uc/safe');
    const card = page.getByRole('region', { name: 'Idle sign-out' });
    await expect(card.getByTestId('session-limits__owner')).toHaveText('The platform signs a device out after 1 hour unused.');
    await expect(card.getByTestId('session-limits__applied')).toContainText('Your devices are signed out after 1 hour unused.');
    await expect(card.getByTestId('session-limits__applied')).toContainText('You have not chosen a shorter time.');
    const field = card.getByLabel('Sign out after this many minutes unused');
    const hint = await card.getByText(/^From \d+ to 60 minutes\.$/).innerText();
    const floor = Number(/^From (\d+) to/.exec(hint)[1]);
    const own = floor + 5;
    expect(own + 1, 'the chosen time and one minute past it both sit under the owner’s hour').toBeLessThan(60);
    const [family] = await liveFamilies(sql, who.email);

    // Unused for one minute longer than the time about to be chosen: the owner's hour still applies, so this device stays in.
    await leaveIdle(sql, family, own + 1);
    await page.reload();
    await expect(card.getByTestId('session-limits__owner')).toBeVisible();
    await expect(page.getByText('Sign in to continue')).toHaveCount(0);

    await field.fill(String(own));
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByRole('status')).toHaveText('Idle sign-out saved.');
    await expect(card.getByTestId('session-limits__applied')).toContainText(`Your devices are signed out after ${own} minutes unused.`);
    await expect(card.getByTestId('session-limits__applied')).toContainText(`You chose ${own} minutes.`);
    const [saved] = await sql`SELECT idle_signout_seconds FROM users WHERE lower(email) = lower(${who.email})`;
    expect(saved.idle_signout_seconds).toBe(own * 60);

    // --- A longer value than the owner's is refused, and nothing changes. ---
    await field.fill('90');
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card).toContainText(`That is outside what you may choose: from ${floor} to 60 minutes. Nothing was changed.`);
    await expect(card.getByTestId('session-limits__applied')).toContainText(`You chose ${own} minutes.`);
    const [kept] = await sql`SELECT idle_signout_seconds FROM users WHERE lower(email) = lower(${who.email})`;
    expect(kept.idle_signout_seconds, 'the refused value changed nothing').toBe(own * 60);

    // The same idle time as before, one minute past the chosen time and still under the owner's: now this device is signed out.
    await leaveIdle(sql, family, own + 1);
    await page.reload();
    await expect(page.getByText('Sign in to continue')).toBeVisible();
    expect(await liveFamilies(sql, who.email), 'the idle sign-in ended').toEqual([]);

    // --- The fourth sign-in beyond the owner's cap of three ends the oldest device. ---
    const many = person('im');
    const first = await browser.newContext();
    others.push(first);
    const firstPage = await first.newPage();
    await signUpInBrowser(firstPage, many);
    await firstPage.goto('/uc/safe');
    await expect(firstPage.getByRole('region', { name: 'Idle sign-out' }).getByTestId('session-limits__devices')).toHaveText(
      'You can be signed in on up to 3 devices. Signing in on one more signs out the device you signed in on longest ago.',
    );
    const pages = [firstPage];
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext();
      others.push(context);
      const next = await context.newPage();
      await signIn(next, many);
      pages.push(next);
    }
    const three = await liveFamilies(sql, many.email);
    expect(three, 'three devices, three sign-ins').toHaveLength(3);
    const oldest = three[0];

    const fourth = await browser.newContext();
    others.push(fourth);
    const fourthPage = await fourth.newPage();
    await signIn(fourthPage, many);
    const after = await liveFamilies(sql, many.email);
    expect(after, 'still three devices after the fourth sign-in').toHaveLength(3);
    expect(after, 'the oldest device is the one that ended').not.toContain(oldest);
    expect(after).toEqual([...three.slice(1), after[2]]);

    // The oldest device is signed out at its next refresh; the newest sees three devices in Security.
    await firstPage.goto('/uc/safe');
    await expect(firstPage.getByText('Sign in to continue')).toBeVisible();
    await fourthPage.goto('/uc/safe');
    await expect(fourthPage.getByRole('region', { name: 'Your devices' }).getByTestId('security__row')).toHaveCount(3);
    // The second device signed in is still in.
    await pages[1].goto('/uc/safe');
    await expect(pages[1].getByRole('region', { name: 'Your devices' })).toBeVisible();
    await expect(pages[1].getByText('Sign in to continue')).toHaveCount(0);
  } finally {
    for (const context of others) await context.close().catch(() => undefined);
    await sql.end();
    await sessionLimits(false);
  }
});

test(`${J}, part of #4: with the owner's settings blank, Security says no idle sign-out and no device limit are set`, async ({ page }) => {
  test.setTimeout(150_000);
  const who = person('iu');
  await signUpInBrowser(page, who);
  await page.goto('/uc/safe');
  const card = page.getByRole('region', { name: 'Idle sign-out' });
  await expect(card.getByTestId('session-limits__owner')).toHaveText(
    /^The platform has set no idle sign-out\. A sign-in still ends .+ after you sign in\.$/,
  );
  await expect(card.getByTestId('session-limits__applied')).toContainText('Your devices are not signed out for being unused.');
  await expect(card.getByTestId('session-limits__devices')).toHaveText('No limit on signed-in devices is set.');
});
