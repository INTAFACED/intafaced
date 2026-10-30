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
  const ctx = await makeContext({ log: () => {} });
  const vault = JSON.parse(readFileSync(path.join(ctx.paths.stateDir, FOUNDER_VAULT_NAME), 'utf8'));
  const founder = vault.founders[key === 'a' ? 0 : 1];
  if (!founder?.totpSecret) throw new Error(`founder ${key} has no confirmed second factor yet: start the stack first (pnpm local:stack)`);
  // The console signs in as the stack's one TEST browser, so identity's new-device check does not stop a founder here.
  await page.context().addCookies([localTestAdminDeviceCookie(ADMIN)]);
  await page.goto(`${ADMIN}/login`);
  await page.getByLabel('Email or handle').fill(founder.handle ?? founder.email);
  await page.getByLabel('Password').fill(founder.password);
  await page.getByLabel('Authenticator or recovery code').fill(await founderTotp(ctx, key, founder.totpSecret));
  await page.locator('button[type=submit]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  return { userId: founder.userId, handle: founder.handle };
}

/**
 * A fresh authenticator code for founder `key`, for a same-person step-up in the console (a governance role change).
 * founderTotp records the step, so it never hands out a code the sign-in or another step already spent.
 */
export async function founderCode(key = 'a') {
  const ctx = await makeContext({ log: () => {} });
  const vault = JSON.parse(readFileSync(path.join(ctx.paths.stateDir, FOUNDER_VAULT_NAME), 'utf8'));
  const founder = vault.founders[key === 'a' ? 0 : 1];
  if (!founder?.totpSecret) throw new Error(`founder ${key} has no confirmed second factor yet: start the stack first (pnpm local:stack)`);
  return founderTotp(ctx, key, founder.totpSecret);
}
