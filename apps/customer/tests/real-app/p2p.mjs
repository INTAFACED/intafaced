import { randomBytes, randomUUID } from 'node:crypto';
import { EDGE, ORIGIN, mailedConfirmLinks } from './stack.mjs';

// What every P2P journey needs: svc-p2p's own doors through Edge, and a taker who meets the take requirements.

/** The stack's TEST bank transfer method (`local-test-gates.mjs p2p` registers it): DE, account holder and IBAN. */
export const METHOD = 'test-bank-transfer';
export const TEST_IBAN = 'DE89370400440532013000';

// Edge allows 1200 requests a minute per address on the stack: keep the setup well under it.
const pace = () => new Promise((resolve) => setTimeout(resolve, 75));

/** svc-p2p through Edge as `who` (an api() session): queries as GET, mutations as POST; the answer or a thrown refusal. */
export function p2p(who) {
  const unwrap = (what, res) => {
    if (res.status !== 200) throw new Error(`${what} refused: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    return res.body.result.data;
  };
  return {
    raw: {
      query: (proc, input) =>
        who.get(`/api/p2p/trpc/${proc}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`),
      mutate: (proc, input) => who.post(`/api/p2p/trpc/${proc}`, input),
    },
    async query(proc, input) {
      await pace();
      return unwrap(proc, await this.raw.query(proc, input));
    },
    async mutate(proc, input) {
      await pace();
      return unwrap(proc, await this.raw.mutate(proc, input));
    },
  };
}

/** The refusal code a raw svc-p2p reply carries, or null. */
export const refusalCode = (res) => res.body?.error?.data?.cause?.code ?? res.body?.error?.data?.intafacedCode ?? null;

/**
 * Confirms `who`'s email address the way the person does: ask identity for the link, open what the LOCAL-TEST outbox
 * received, confirm. `session` is an api() session for `who`.
 */
export async function confirmEmail(session, who) {
  // An account made through the sign-up code is confirmed by that code; nothing is mailed again.
  const me = await session.get('/api/identity/trpc/me');
  if (me.body?.result?.data?.emailVerified === true) return;
  const seen = mailedConfirmLinks(who.email).length;
  const asked = await session.post('/api/identity/trpc/auth.requestEmailConfirmation', {});
  if (asked.status !== 200) throw new Error(`confirmation email refused: ${asked.status} ${JSON.stringify(asked.body).slice(0, 300)}`);
  const until = Date.now() + 20_000;
  let link;
  while (!(link = mailedConfirmLinks(who.email)[seen])) {
    if (Date.now() > until) throw new Error(`no confirmation email reached the LOCAL-TEST outbox for ${who.email}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const token = new URL(link, 'http://x').searchParams.get('token');
  const confirmed = await session.post('/api/identity/trpc/auth.confirmEmail', { token });
  if (confirmed.status !== 200)
    throw new Error(`email confirmation refused: ${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 300)}`);
}

/**
 * A TEST account registered without the sign-up code, so its email address is not confirmed (the browser sign-up
 * confirms it with the code). Sign it in and verify it like any other.
 */
export async function unconfirmedAccount(prefix) {
  const handle = `${prefix}${Date.now().toString(36)}`;
  const who = { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
  const res = await fetch(`${EDGE}/api/identity/trpc/auth.register`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ handle: who.handle, email: who.email, password: who.password, region: 'DE' }),
  });
  if (res.status !== 200) throw new Error(`register ${who.email} refused: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return who;
}

/** A taker who meets every take requirement: email confirmed and the current risk notice accepted. */
export async function readyTaker(session, who) {
  await confirmEmail(session, who);
  const client = p2p(session);
  const notice = await client.query('risk.notice');
  await client.mutate('risk.accept', { version: notice.version });
  return client;
}

/** A TEST bank transfer destination for `who`, so their sell ads can be taken. */
export async function testInstrument(client, who) {
  return client.mutate('instruments.create', {
    instrumentId: randomUUID(),
    methodId: METHOD,
    country: 'DE',
    fiatCurrency: 'EUR',
    label: 'TEST account',
    details: { account_holder: who.handle, iban: TEST_IBAN },
  });
}
