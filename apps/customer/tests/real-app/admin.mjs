import { readFileSync } from 'node:fs';
import { test } from '@playwright/test';
import path from 'node:path';
import { founderStepRefused, founderTotp, makeContext, signInOnceMore } from '../../../../tooling/scripts/local-test-gates.mjs';
import { FOUNDER_VAULT_NAME } from '../../../../tooling/scripts/local-test-founders.mjs';
import { localTestAdminDeviceCookie } from '../../../../tooling/scripts/local-test-device.mjs';

// The founder console (apps/admin) for operator journeys. It runs beside the stack against the same Edge, and the founders
// sign in with the stack's own LOCAL TEST founder pair (founders.json). Each TOTP code is taken through founderTotp, which
// records the step it used, so the console never replays a code the gates or the world just spent.
export const ADMIN = process.env.JOURNEY_ADMIN_URL ?? 'http://127.0.0.1:3100';

/** Fails with what to do when the console is not running, instead of a timeout on a blank page. */
export async function assertAdminUp() {
  const res = await fetch(`${ADMIN}/login`).catch((error) => ({ ok: false, status: String(error.cause?.code ?? error.message) }));
  if (!res.ok)
    throw new Error(
      `The founder console is not answering at ${ADMIN}/login (${res.status}). Start it against the stack's Edge: ` +
        'APP_ENV=dev EDGE_URL=http://127.0.0.1:14500 ADMIN_ORIGIN=http://127.0.0.1:3100 ADMIN_SESSION_SECRET=<32 random bytes, base64url> ' +
        'pnpm --filter @intafaced/admin dev (or set JOURNEY_ADMIN_URL).',
    );
}

/** Signs founder `key` ('a' or 'b') in to the console in this page, and returns the founder's vault entry (no secrets used after). */
export async function founderSignIn(page, key = 'a') {
  await assertAdminUp();
  const { ctx, founder } = await founderEntry(key);
  // The console signs in as the stack's one TEST browser, so identity's new-device check does not stop a founder here.
  await page.context().addCookies([localTestAdminDeviceCookie(ADMIN)]);
  // A code the console refuses is tried once more at a step after any identity can hold, as the gates' own sign-in does.
  await signInOnceMore({
    attempt: () => consoleSignIn(page, founder, () => founderTotp(ctx, key, founder.totpSecret)),
    onRefused: () => founderStepRefused(ctx, key),
    log: (line) => retryNoted(key, line),
  });
  return { userId: founder.userId, handle: founder.handle };
}

/**
 * A retry that fired, made visible with both steps: a `founder-totp-retry` annotation on the running test (in the
 * report, so how often it fires is counted) and a log line. If it fires on most runs, the cause is elsewhere.
 */
function retryNoted(key, line) {
  const description = `founder ${key}: ${line}`;
  console.log(`founder sign-in retry: ${description}`);
  try {
    test.info().annotations.push({ type: 'founder-totp-retry', description });
  } catch {
    // Outside a running test (a script), the log line is the record.
  }
}

/**
 * One sign-in on the console's login page: 'in' once it leaves /login, 'refused' when it shows its refusal. The page is
 * loaded fresh each time, so a refusal still shown from an earlier try is never read as this one's.
 */
async function consoleSignIn(page, founder, code) {
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
  try {
    return await Promise.any([signedIn, refused]);
  } catch (error) {
    // Neither within 30 s: the sign-in's own timeout, as before.
    throw error.errors?.[0] ?? error;
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
