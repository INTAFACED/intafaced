import { expect } from './journey.mjs';
import { api, tool } from './stack.mjs';

// The person's venue connection as the journeys drive it: svc-trade's user-venue door switched on or off, the Venue
// account room's connect and sign, and one action signed by a journey's own TEST trader key.

/** Restarts trade with the user-venue door on (which starts the TEST venue) or off, and puts this process's env back. */
export function userVenue(on) {
  const before = process.env.LOCAL_STACK_USER_VENUE;
  if (on) process.env.LOCAL_STACK_USER_VENUE = 'on';
  else delete process.env.LOCAL_STACK_USER_VENUE;
  try {
    tool('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_USER_VENUE;
    else process.env.LOCAL_STACK_USER_VENUE = before;
  }
}

/** svc-trade's user-venue door as the person reads it. */
export async function venueDoor(who) {
  const { status, body } = await (await api(who)).get('/api/v1/venue/status');
  if (status !== 200) throw new Error(`venue status refused: ${status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

/** The person's wallets as svc-protocol records them, through Edge. */
export async function connections(who) {
  const { status, body } = await (await api(who)).get('/api/protocol/trpc/venueWallet.status');
  if (status !== 200) throw new Error(`venueWallet.status refused: ${status} ${JSON.stringify(body).slice(0, 300)}`);
  return body.result.data.connections;
}

/** The wallet's sign sheet. */
export const sheet = (page) => page.locator('[data-sheet="sign"]');

/** The room has read the connection back: Connected, Connection expired, or Connect. */
export async function roomSettled(page) {
  await expect(
    page
      .getByRole('heading', { name: 'Connected' })
      .or(page.getByRole('heading', { name: 'Connection expired' }))
      .or(page.getByRole('button', { name: 'Connect to my account' })),
  ).toBeVisible();
}

/** Connects (or signs again) through the room's own button and the wallet's sign sheet. */
export async function connectAndSign(page, button = 'Connect to my account') {
  await page.getByRole('button', { name: button }).click();
  await sheet(page).getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Connected' })).toBeVisible();
}

/** The stack's TEST connection lasts 60 s: a signed action needs this much of it left. */
const CONNECTION_MARGIN_MS = 45_000;

/** The room is Connected with enough of the connection left for a signed action, signing again when it is not. */
export async function connectedNow(page) {
  await roomSettled(page);
  if (await page.getByRole('heading', { name: 'Connected' }).isVisible()) {
    const expiresAt = Date.parse(await page.getByTestId('venue-connection-expires').getAttribute('datetime'));
    if (expiresAt - Date.now() > CONNECTION_MARGIN_MS) return;
    await expect(page.getByRole('heading', { name: 'Connection expired' })).toBeVisible({ timeout: CONNECTION_MARGIN_MS + 15_000 });
  }
  if (await page.getByRole('button', { name: 'Sign again' }).isVisible()) await connectAndSign(page, 'Sign again');
  if (await page.getByRole('button', { name: 'Connect to my account' }).isVisible()) await connectAndSign(page);
}

/** One action through svc-trade's user-venue door as `who`, signed by the journey's own TEST trader key (a viem account). */
export function ownerDoor(traderKey) {
  const traderOwner = traderKey.address.toLowerCase();
  return async function door(who, intent, actionKey) {
    const session = await api(who);
    const signer = { role: 'owner', address: traderOwner };
    const prepared = await session.post('/api/v1/venue/prepare', {
      owner: traderOwner,
      signer,
      intent,
      ...(actionKey ? { actionKey } : {}),
    });
    expect(prepared.status, JSON.stringify(prepared.body).slice(0, 400)).toBe(200);
    const p = prepared.body.prepared;
    const t = p.typedData;
    const signature = await traderKey.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    const sent = await session.post('/api/v1/venue/submit', {
      actionKey: prepared.body.actionKey,
      signature: { digest: p.digest, signature, signedBy: traderOwner },
    });
    expect(sent.status, JSON.stringify(sent.body).slice(0, 400)).toBe(200);
    expect(sent.body.outcome, JSON.stringify(sent.body.outcome).slice(0, 400)).toMatchObject({ definite: true, accepted: true });
    return sent.body;
  };
}
