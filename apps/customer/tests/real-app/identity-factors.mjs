import { expect } from '@playwright/test';
import { nextTotpStep } from '../../../../tooling/scripts/local-test-gates.mjs';
import { signOutBrowser } from './stack.mjs';

// Passkeys belong to the stack's relying party, `localhost` (an IP address cannot be one), so these steps use the
// customer app at http://localhost:3210 and Chromium's virtual authenticator in place of a device.
export const PASSKEY_ORIGIN = 'http://localhost:3210';

/** Chromium allows one built-in authenticator; `transport: 'usb'` adds a security key beside it. */
export async function virtualAuthenticator(page, transport = 'internal') {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport,
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

/** Adds a passkey from Security, as the signed-in person would. */
export async function addPasskey(page) {
  await page.goto('/uc/safe');
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add passkey' }).click();
  await expect(page.getByTestId('security__passkeys')).toContainText('Added');
}

/** Sets up an authenticator app from Security; returns its key and the 30-second step its confirming code used. */
export async function addAuthenticator(page, totp) {
  await page.goto('/uc/safe');
  await page.getByRole('button', { name: 'Start authenticator setup' }).click();
  await page.getByRole('button', { name: 'Start authenticator setup' }).last().click();
  await page.getByRole('button', { name: 'Show setup key' }).click();
  const secret = await page.getByLabel('Authenticator setup key').inputValue();
  // The code and its step from one 30-second window, so a later code is never this one again.
  let step, code;
  do {
    step = Math.floor(Date.now() / 30_000);
    code = totp(secret);
  } while (Math.floor(Date.now() / 30_000) !== step);
  await page.getByLabel('Six-digit authenticator code').fill(code);
  await page.getByRole('button', { name: 'Confirm authenticator' }).click();
  await expect(page.getByTestId('security__authenticator')).toContainText('accepted');
  return { secret, step };
}

/**
 * A code from a 30-second step after `step`: identity refuses a step it has already seen. The step is the gates tool's
 * `nextTotpStep` (the next unused one, never before the clock, at most one step ahead, which identity accepts), signed
 * at once as an authenticator a few seconds ahead would show it; the wait is only while both are spent.
 */
export async function nextCode(totp, secret, step) {
  let next;
  while ((next = nextTotpStep(step, Math.floor(Date.now() / 30_000))) === null) await new Promise((resolve) => setTimeout(resolve, 1000));
  return { code: totp(secret, { at: new Date(next * 30_000) }), step: next };
}

/** Ends this browser's sign-in without touching the passkey on its authenticator. */
export async function forgetSession(page) {
  await signOutBrowser(page.context());
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}
