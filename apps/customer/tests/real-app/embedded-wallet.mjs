import { expect } from './journey.mjs';
import { signIn } from './desk.mjs';
import { api } from './stack.mjs';
import { virtualAuthenticator } from './identity-factors.mjs';

// The person's own embedded wallet (J-wallet-22) as the journeys that use it reach it: the device holding its passkey,
// the wallet room, and svc-protocol's record of the wallet. Passkeys belong to the stack's relying party `localhost`, so a
// file using these runs on PASSKEY_ORIGIN (identity-factors.mjs).

const STATUS = '/api/protocol/trpc/embeddedWallet.status';

/** svc-protocol's record of the person's wallet, through Edge, as the person. */
export async function recorded(who) {
  const client = await api(who);
  const { status, body } = await client.get(STATUS);
  if (status !== 200) throw new Error(`embeddedWallet.status refused: ${status} ${JSON.stringify(body).slice(0, 300)}`);
  return body.result.data;
}

/** This page's device, with the given passkeys on it (none: a device that has never held one). */
export async function device(page, credentials = []) {
  const auth = await virtualAuthenticator(page);
  for (const credential of credentials)
    await auth.cdp.send('WebAuthn.addCredential', { authenticatorId: auth.authenticatorId, credential });
  const held = async () => (await auth.cdp.send('WebAuthn.getCredentials', { authenticatorId: auth.authenticatorId })).credentials;
  return { ...auth, held };
}

export async function openRoom(page, who) {
  await signIn(page, who);
  await page.goto('/wallet');
  await page.getByRole('button', { name: 'My wallet', exact: true }).click();
  await expect(page).toHaveURL(/\/wallet\/embedded$/);
}
