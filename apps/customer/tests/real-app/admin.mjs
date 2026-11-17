import { readFileSync } from 'node:fs';
import path from 'node:path';
import { founderStepRefused, founderTotp, makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { FOUNDER_VAULT_NAME, localTestAdminDeviceCookie } from '../../../../tooling/scripts/local-test-facts.mjs';
import { EDGE, stackUrl } from './stack.mjs';

// The founder console (apps/admin) for operator journeys. It runs beside the stack against the same Edge, and the founders
// sign in with the stack's own LOCAL TEST founder pair (founders.json). Each TOTP code is taken through founderTotp, which
// records the step it used, so the console never replays a code the gates or the world just spent.
export const ADMIN = process.env.JOURNEY_ADMIN_URL ?? stackUrl('admin');

/** Fails with what to do when the console is not running, instead of a timeout on a blank page. */
export async function assertAdminUp() {
  const res = await fetch(`${ADMIN}/login`).catch((error) => ({ ok: false, status: String(error.cause?.code ?? error.message) }));
  if (!res.ok)
    throw new Error(
      `The founder console is not answering at ${ADMIN}/login (${res.status}). Start it against the stack's Edge: ` +
        `APP_ENV=dev EDGE_URL=${EDGE} ADMIN_ORIGIN=${stackUrl('admin')} ADMIN_SESSION_SECRET=<32 random bytes, base64url> ` +
        'pnpm --filter @intafaced/admin dev (or set JOURNEY_ADMIN_URL).',
    );
}

/** Signs founder `key` ('a' or 'b') in to the console in this page, and returns the founder's vault entry (no secrets used after). */
export async function founderSignIn(page, key = 'a') {
  await assertAdminUp();
  const { ctx, founder } = await founderEntry(key);
  // The console signs in as the stack's one TEST browser, so identity's new-device check does not stop a founder here.
  await page.context().addCookies([localTestAdminDeviceCookie(ADMIN)]);
  // One sign-in with a real, unused step. A refusal fails the test, naming identity's answer: it is recorded first, so
  // the next sign-in sends a step after any identity can hold, but it is never hidden by a second try.
  const { outcome, answers } = await consoleSignIn(page, founder, () => founderTotp(ctx, key, founder.totpSecret));
  if (outcome === 'refused') {
    const { refused, current } = founderStepRefused(ctx, key);
    throw new Error(
      `the founder console refused founder ${key}'s sign-in at TOTP step ${refused} (clock at step ${current}); ` +
        `its session answers: ${answers.join(', ') || 'none read'}`,
    );
  }
  return { userId: founder.userId, handle: founder.handle };
}

/**
 * One sign-in on the console's login page: `outcome` is 'in' once it leaves /login, 'refused' when it shows its refusal.
 * `answers` is each answer of the console's session door during it, as `<status> <identity's code>` (never the body,
 * which can hold a device approval's secret), so a refusal names why: the page's own words are the same for most codes.
 */
async function consoleSignIn(page, founder, code) {
  const answers = [];
  const read = (res) => {
    if (res.request().method() !== 'POST' || !new URL(res.url()).pathname.startsWith('/api/session')) return;
    answers.push(
      res
        .json()
        .then((body) => `${res.status()} ${body?.upstream ?? body?.code ?? (res.ok() ? 'signed in' : 'no code')}`)
        .catch(() => `${res.status()} unreadable`),
    );
  };
  page.on('response', read);
  try {
    await page.goto(`${ADMIN}/login`);
    await page.getByLabel('Email or handle').fill(founder.handle ?? founder.email);
    await page.getByLabel('Password').fill(founder.password);
    await page.getByLabel('Authenticator or recovery code').fill(await code());
    await page.locator('button[type=submit]').click();
    const signedIn = page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 }).then(() => 'in');
    const refused = page
      .getByRole('alert')
      .filter({ hasText: 'Sign-in was refused' })
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'refused');
    let outcome;
    try {
      outcome = await Promise.any([signedIn, refused]);
    } catch (error) {
      // Neither within 30 s: the sign-in's own timeout, as before.
      throw error.errors?.[0] ?? error;
    }
    return { outcome, answers: await Promise.all(answers) };
  } finally {
    page.off('response', read);
  }
}

/**
 * A fresh authenticator code for founder `key`, for a same-person step-up in the console (a governance role change).
 * founderTotp records the step, so it never hands out a code the sign-in or another step already spent.
 */
export async function founderCode(key = 'a') {
  const { ctx, founder } = await founderEntry(key);
  return founderTotp(ctx, key, founder.totpSecret);
}

/** Founder `key`'s entry in the stack's founder vault, with a confirmed second factor. */
async function founderEntry(key) {
  const ctx = await makeContext({ log: () => {} });
  const vault = JSON.parse(readFileSync(path.join(ctx.paths.stateDir, FOUNDER_VAULT_NAME), 'utf8'));
  const founder = vault.founders[key === 'a' ? 0 : 1];
  if (!founder?.totpSecret) throw new Error(`founder ${key} has no confirmed second factor yet: start the stack first (pnpm local:stack)`);
  return { ctx, founder };
}
