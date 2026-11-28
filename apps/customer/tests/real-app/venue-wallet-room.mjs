// The venue account room's connection (apps/customer src/features/protocol/venue-wallet/VenueWalletRoom.tsx), as a
// journey drives it: connect the browser wallet to the account by signing, and keep that connection live for the next
// signed action. The stack's TEST connection lasts 60 s (local-stack-services/protocol.mjs).
import { expect } from './journey.mjs';

const sheet = (page) => page.locator('[data-sheet="sign"]');

/** Presses `button`, continues the plain-words sheet, and the TEST wallet signs: the room shows Connected. */
async function connectAndSign(page, button) {
  await page.getByRole('button', { name: button, exact: true }).click();
  await sheet(page).getByRole('button', { name: 'Continue in wallet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connected', exact: true })).toBeVisible();
}

/** Connected for the next signed action: one about to end is let end first, then the wallet signs again. */
export async function connectedNow(page, marginMs = 45_000) {
  const connected = page.getByRole('heading', { name: 'Connected', exact: true });
  const expired = page.getByRole('heading', { name: 'Connection expired', exact: true });
  const connect = page.getByRole('button', { name: 'Connect to my account', exact: true });
  await expect(connected.or(expired).or(connect)).toBeVisible({ timeout: 30_000 });
  if (await connected.isVisible()) {
    const expiresAt = Date.parse(await page.getByTestId('venue-connection-expires').getAttribute('datetime'));
    if (expiresAt - Date.now() > marginMs) return;
    await expect(expired).toBeVisible({ timeout: marginMs + 15_000 });
  }
  if (await page.getByRole('button', { name: 'Sign again', exact: true }).isVisible()) await connectAndSign(page, 'Sign again');
  if (await connect.isVisible()) await connectAndSign(page, 'Connect to my account');
}
