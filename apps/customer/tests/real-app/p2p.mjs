import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EDGE, ORIGIN, ROOT, mailedConfirmLinks } from './stack.mjs';
import { PASSKEY_ORIGIN, virtualAuthenticator } from './identity-factors.mjs';

// What every P2P journey needs: svc-p2p's own doors through Edge, and a taker who meets the take requirements.

/** The stack's TEST bank transfer method (`local-test-gates.mjs p2p` registers it): DE, account holder and IBAN. */
export const METHOD = 'test-bank-transfer';
export const TEST_IBAN = 'DE89370400440532013000';

// Edge allows 1200 requests a minute per address on the stack: keep the setup well under it.
const pace = () => new Promise((resolve) => setTimeout(resolve, 75));

/** The scope and purpose a take is confirmed under (svc-p2p take-step-up.ts, contracts CUSTOMER_STEP_UP_DOORS). */
export const TAKE_STEP_UP = { scope: 'p2p.step_up.trades.take', purpose: 'trades.take' };

/**
 * svc-p2p through Edge as `who` (an api() session): queries as GET, mutations as POST; the answer or a thrown refusal.
 *
 * With `passkey` (a `testPasskey` saved on the account), a take is confirmed the way the person does it: identity's
 * step-up for exactly that take, sent with it, which then covers this session's takes for ten minutes (svc-p2p
 * `trades.stepUpWindow`). `bare` never confirms anything, so a journey can see a take refused for want of it.
 */
export function p2p(who, passkey = null) {
  const unwrap = (what, res) => {
    if (res.status !== 200) throw new Error(`${what} refused: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    return res.body.result.data;
  };
  const bare = {
    query: (proc, input) =>
      who.get(`/api/p2p/trpc/${proc}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`),
    mutate: (proc, input) => who.post(`/api/p2p/trpc/${proc}`, input),
  };
  let confirmedUntil = 0;
  const take = async (input) => {
    if (!passkey || input.stepUpApprovalId) return bare.mutate('trades.take', input);
    // Inside this session's confirmed window (with a margin for the request itself), the take needs nothing more,
    // unless svc-p2p's clock says the window has ended or this is another session: then it is confirmed after all.
    if (Date.now() < confirmedUntil - 30_000) {
      const res = await bare.mutate('trades.take', input);
      if (res.status !== 403 || !['auth.step_up_required', 'auth.step_up_expired'].includes(refusalCode(res))) return res;
    }
    const stepUpApprovalId = await confirmTake(who, passkey, input);
    const res = await bare.mutate('trades.take', { ...input, stepUpApprovalId });
    const window = await bare.query('trades.stepUpWindow');
    confirmedUntil = Date.parse(window.body?.result?.data?.confirmedUntil ?? '') || 0;
    return res;
  };
  return {
    bare,
    raw: {
      query: bare.query,
      mutate: (proc, input) => (proc === 'trades.take' ? take(input) : bare.mutate(proc, input)),
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

/** What a take's confirmation names: the reviewed ad, coin amount and method, and the held quote when there is one. */
export const takeStepUpRequest = (input) => ({
  ...TAKE_STEP_UP,
  target: input.offerId,
  amount: input.amount,
  fields: {
    offerId: input.offerId,
    amount: input.amount,
    method: input.method,
    ...(input.quoteId ? { quoteId: input.quoteId } : {}),
  },
});

/** Identity's step-up for one take, answered with `passkey`: returns the single-use stepUpApprovalId. */
export async function confirmTake(session, passkey, input) {
  const begun = await session.post('/api/identity/trpc/stepUp.begin', takeStepUpRequest(input));
  const challenge = begun.body?.result?.data?.webauthn?.challenge;
  if (begun.status !== 200 || !challenge)
    throw new Error(`step-up begin refused: ${begun.status} ${JSON.stringify(begun.body).slice(0, 300)}`);
  const done = await session.post('/api/identity/trpc/stepUp.complete', {
    challengeId: begun.body.result.data.challengeId,
    webauthn: await passkey.assertion(challenge),
  });
  const approval = done.body?.result?.data?.stepUpApprovalId;
  if (done.status !== 200 || !approval)
    throw new Error(`step-up complete refused: ${done.status} ${JSON.stringify(done.body).slice(0, 300)}`);
  return approval;
}

let webauthnHelpers;
async function webauthn() {
  const load = (rel) => import(pathToFileURL(path.join(ROOT, 'services/svc-identity/dist/auth', rel)).href);
  webauthnHelpers ??= Promise.all([load('webauthn.js'), load('cbor.js')]).then(([w, c]) => ({ ...w, encodeCbor: c.encodeCbor }));
  return webauthnHelpers;
}

/**
 * A TEST passkey saved on `session`'s account through identity's own doors, standing in for a device: a P-256 key
 * held here, attestation "none", for the stack's relying party (localhost) and the customer app's localhost origin. A
 * passkey, unlike an authenticator app, leaves password sign-in as it was, so api() sessions keep working.
 */
export async function testPasskey(session) {
  const w = await webauthn();
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credId = randomBytes(16);
  const rpID = new URL(PASSKEY_ORIGIN).hostname;
  const options = await session.post('/api/identity/trpc/webauthn.registerOptions', {});
  const challenge = options.body?.result?.data?.challenge;
  if (options.status !== 200 || !challenge)
    throw new Error(`passkey options refused: ${options.status} ${JSON.stringify(options.body).slice(0, 300)}`);
  const clientDataJSON = w.buildClientDataJSON({ type: 'webauthn.create', challenge, origin: PASSKEY_ORIGIN });
  const authData = w.buildAuthenticatorData({
    rpID,
    counter: 0,
    credential: { id: credId, publicKeyCose: w.coseKeyFromJwk(publicKey.export({ format: 'jwk' })) },
  });
  const attestationObject = Buffer.from(
    w.encodeCbor(
      new Map([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', new Uint8Array(authData)],
      ]),
    ),
  );
  const saved = await session.post('/api/identity/trpc/webauthn.registerVerify', {
    id: w.b64urlEncode(credId),
    rawId: w.b64urlEncode(credId),
    type: 'public-key',
    response: {
      clientDataJSON: w.b64urlEncode(clientDataJSON),
      attestationObject: w.b64urlEncode(attestationObject),
      transports: ['internal'],
    },
  });
  if (saved.status !== 200) throw new Error(`passkey save refused: ${saved.status} ${JSON.stringify(saved.body).slice(0, 300)}`);
  return heldPasskey(w, {
    credentialId: w.b64urlEncode(credId),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    signCount: 0,
  });
}

/**
 * The same TEST passkey from what `testPasskey(…).saved()` returned, so a later step (or the browser's virtual
 * authenticator, `browserHoldsPasskey`) answers with the key the account already has.
 */
export async function restorePasskey(saved) {
  return heldPasskey(await webauthn(), saved);
}

function heldPasskey(w, saved) {
  const privateKey = createPrivateKey({ key: Buffer.from(saved.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  const rpID = new URL(PASSKEY_ORIGIN).hostname;
  const credId = Buffer.from(saved.credentialId, 'base64url');
  let counter = saved.signCount;
  return {
    /** What a later step needs to answer with this passkey: the TEST key and how far its counter has gone. */
    saved: () => ({ credentialId: saved.credentialId, privateKey: saved.privateKey, signCount: counter }),
    async assertion(challengeText) {
      counter += 1;
      const data = w.buildClientDataJSON({ type: 'webauthn.get', challenge: challengeText, origin: PASSKEY_ORIGIN });
      const auth = w.buildAuthenticatorData({ rpID, counter });
      const signature = sign('SHA256', Buffer.concat([auth, createHash('sha256').update(data).digest()]), {
        key: privateKey,
        dsaEncoding: 'der',
      });
      return {
        id: w.b64urlEncode(credId),
        rawId: w.b64urlEncode(credId),
        type: 'public-key',
        response: {
          clientDataJSON: w.b64urlEncode(data),
          authenticatorData: w.b64urlEncode(auth),
          signature: w.b64urlEncode(signature),
        },
      };
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

/**
 * A taker who meets every take requirement: email confirmed, the current risk notice accepted, and a TEST passkey to
 * confirm takes with. Pass the account's passkey when it already has one.
 */
export async function readyTaker(session, who, passkey = null) {
  await confirmEmail(session, who);
  const client = p2p(session, passkey ?? (await testPasskey(session)));
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

// The stack's founder pair, as P2P operators: A proposes and makes the change, B approves (svc-p2p's two-person rule).
let gates;
let operatorCtx;
let operatorPair;
async function operators() {
  gates ??= await import('../../../../tooling/scripts/local-test-gates.mjs');
  operatorCtx ??= await gates.makeContext({ log: () => {} });
  operatorPair ??= await gates.approverSessions(operatorCtx);
  return { ctx: operatorCtx, pair: operatorPair };
}

/** svc-p2p's approval payload hash (p2pActionPayloadHash): the action and its fields, in the router's order. */
const p2pActionHash = (actionType, fields) =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify({ actionType, ...fields }))
    .digest('hex')}`;

/** A's change to the method registry, approved by B first. Returns the stored method schema. */
async function operatorMethodChange(proc, actionType, fields, input) {
  const { ctx, pair } = await operators();
  const payloadHash = p2pActionHash(actionType, fields);
  const proposal = {
    actionType,
    targetService: 'svc-p2p',
    targetId: actionType,
    expectedVersion: '1',
    payloadHash,
    policyVersion: gates.MARKERS.policyVersion,
  };
  const proposed = await ctx.edge.mutate('identity', 'actionApproval.propose', proposal, await pair.a.approvalToken());
  const ids = proposed.json?.result?.data;
  if (!ids?.approvalId) throw new Error(`actionApproval.propose refused (${proposed.status}): ${proposed.text.slice(0, 300)}`);
  const approved = await ctx.edge.mutate(
    'identity',
    'actionApproval.approve',
    { approvalId: ids.approvalId, expectedPayloadHash: payloadHash },
    await pair.b.approvalToken(),
  );
  if (approved.json?.result?.data?.status !== 'APPROVED')
    throw new Error(`actionApproval.approve refused (${approved.status}): ${approved.text.slice(0, 300)}`);
  const res = await ctx.edge.mutate(
    'p2p',
    proc,
    { ...input, approvalId: ids.approvalId, operationId: ids.operationId },
    await pair.a.complianceToken(),
  );
  const row = res.json?.result?.data;
  if (!row?.methodId) throw new Error(`p2p ${proc} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
}

/**
 * A second LOCAL TEST method, the same TEST bank transfer under another id, which a journey retires. The shared
 * test-bank-transfer is never retired: every other P2P journey pays with it.
 */
export const RETIRING_METHOD = 'test-retiring-transfer';

/** Registers the retiring TEST method switched on, which also brings it back from an earlier run's retirement. */
export async function registerRetiringMethod() {
  const [base] = (await import('../../../../tooling/scripts/local-test-gates.mjs')).TEST_P2P_METHODS;
  const method = { methodId: RETIRING_METHOD, country: base.country, label: 'TEST retiring transfer', fields: base.fields };
  return operatorMethodChange(
    'instruments.methods.register',
    'p2p.method_register',
    { ...method, fields: JSON.stringify(method.fields), enabled: 'true' },
    { ...method, enabled: true },
  );
}

/** Retires the retiring TEST method in its market with the operator's `reason`. */
export async function retireRetiringMethod(reason) {
  const input = { methodId: RETIRING_METHOD, country: 'DE', enabled: false, reason };
  return operatorMethodChange(
    'instruments.methods.setEnabled',
    'p2p.method_set_enabled',
    { methodId: RETIRING_METHOD, country: 'DE', enabled: 'false', reason },
    input,
  );
}

/**
 * The browser's virtual authenticator holding the account's TEST passkey, so the person confirms in the app with the
 * passkey their account already has (an account with one cannot add another without confirming first). The page must
 * be on the passkey origin (`PASSKEY_ORIGIN`).
 */
export async function browserHoldsPasskey(page, saved) {
  const { cdp, authenticatorId } = await virtualAuthenticator(page);
  await cdp.send('WebAuthn.addCredential', {
    authenticatorId,
    credential: {
      credentialId: Buffer.from(saved.credentialId, 'base64url').toString('base64'),
      isResidentCredential: false,
      rpId: new URL(PASSKEY_ORIGIN).hostname,
      privateKey: saved.privateKey,
      // Past every count the account's earlier answers used, so identity sees the counter move on.
      signCount: saved.signCount + 1,
    },
  });
}
