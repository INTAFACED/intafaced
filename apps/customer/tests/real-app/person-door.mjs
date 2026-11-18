import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { expect } from './journey.mjs';
import { ROOT, api } from './stack.mjs';
import { signIn } from './desk.mjs';
import { nextCode } from './identity-factors.mjs';
import { venueInfo } from './venue.mjs';

const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/**
 * One TEST person a journey file acts as, step after step: their account and wallet key are in the file's `run` state
 * (`who`, `walletKey`), and once they add an authenticator (`secret`, `step`) every sign-in and every API session takes a
 * fresh code. `test` resets the API session before each step, so a step never reuses the last step's sign-in.
 */
export function personDoor(J, run, test) {
  function state() {
    const s = run.read();
    if (!s.who || !s.walletKey) throw new Error(`${J} #1 made no account and wallet, so this step has no one to act as`);
    return { ...s, owner: privateKeyToAccount(s.walletKey).address.toLowerCase() };
  }

  async function codeFor() {
    const s = run.read();
    if (!s.secret) return undefined;
    const { code, step } = await nextCode(totp, s.secret, s.step);
    run.write({ step });
    return code;
  }

  async function signInNow(page, who) {
    if (!run.read().secret) return signIn(page, who);
    const totpCode = await codeFor();
    await page.goto('/login');
    await page.fill('input[name=totp]', totpCode);
    await page.fill('input[name=identifier]', who.email);
    await page.fill('input[name=password]', who.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
  }

  let session;
  test.beforeEach(() => {
    session = undefined;
  });
  const door = () =>
    (session ??= (async () => {
      const totpCode = await codeFor();
      return api(state().who, totpCode ? { totpCode } : {});
    })());

  async function bankGet(procedure, input) {
    const q = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const res = await (await door()).get(`/api/bank/trpc/${procedure}${q}`);
    expect(res.status, `${procedure}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    return res.body.result.data;
  }
  async function bankPost(procedure, input) {
    const res = await (await door()).post(`/api/bank/trpc/${procedure}`, input);
    expect(res.status, `${procedure}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    return res.body.result.data;
  }

  /** A venue action signed by the person's own key through our venue door; the venue's answer must be a definite yes. */
  async function signAndSend(intent, actionKey) {
    const { owner, walletKey } = state();
    const d = await door();
    const prep = await d.post('/api/v1/venue/prepare', {
      venueId: (await venueInfo()).id,
      owner,
      signer: { role: 'owner', address: owner },
      intent,
      actionKey,
    });
    expect(prep.status, JSON.stringify(prep.body).slice(0, 300)).toBe(200);
    const t = prep.body.prepared.typedData;
    const signature = await privateKeyToAccount(walletKey).signTypedData({
      domain: t.domain,
      types: t.types,
      primaryType: t.primaryType,
      message: t.message,
    });
    const sent = await d.post('/api/v1/venue/submit', {
      actionKey: prep.body.actionKey,
      signature: { digest: prep.body.prepared.digest, signature, signedBy: owner },
    });
    expect(sent.body.outcome, JSON.stringify(sent.body).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
    return sent.body;
  }

  return { state, codeFor, signInNow, door, bankGet, bankPost, signAndSend };
}
