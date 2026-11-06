import { readFileSync } from 'node:fs';
import path from 'node:path';
import { founderTotp, makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
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
  await page.goto(`${ADMIN}/login`);
  await page.getByLabel('Email or handle').fill(founder.handle ?? founder.email);
  await page.getByLabel('Password').fill(founder.password);
  await page.getByLabel('Authenticator or recovery code').fill(await founderTotp(ctx, key, founder.totpSecret));
  const replies = [];
  page.on('response', async (r) => {
    if (r.request().method() === 'POST' && /session|login/.test(r.url()))
      replies.push(`${new Date().toISOString()} ${r.status()} ${r.url()} ${(await r.text().catch(() => '')).slice(0, 300)}`);
  });
  const sentAt = new Date().toISOString();
  await page.locator('button[type=submit]').click();
  try {
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  } catch (err) {
    // DIAG #7209 (never merged): what identity and the steps file said when a founder's console sign-in was refused.
    const { readFileSync } = await import('node:fs');
    console.log(`DIAG7209 founder ${key} sent ${sentAt}; console replies:\n${replies.join('\n')}`);
    try {
      console.log('DIAG7209 steps', readFileSync(path.join(ctx.paths.stateDir, 'founder-totp-steps.json'), 'utf8'));
    } catch (e) {
      console.log('DIAG7209 no steps file', e.message);
    }
    try {
      const lines = readFileSync(path.join(ctx.paths.stateDir, 'logs/identity.log'), 'utf8').split('\n');
      console.log(
        'DIAG7209 identity log (login, mfa, totp, refused):\n' +
          lines
            .filter((l) => /login|mfa|totp|refus|throttl|attempt/i.test(l))
            .slice(-60)
            .join('\n'),
      );
    } catch (e) {
      console.log('DIAG7209 no identity log', e.message);
    }
    throw err;
  }
  return { userId: founder.userId, handle: founder.handle };
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
