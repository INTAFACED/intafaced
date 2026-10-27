import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, mailedConfirmLinks } from './stack.mjs';
import { PASSKEY_ORIGIN, virtualAuthenticator } from './identity-factors.mjs';

// What every P2P journey needs: svc-p2p's own doors through Edge, and a taker who meets the take requirements.

/** The stack's TEST bank transfer method (`local-test-gates.mjs p2p` registers it): DE, account holder and IBAN. */
export const METHOD = 'test-bank-transfer';
export const TEST_IBAN = 'DE89370400440532013000';

// Edge allows 6000 requests a minute per address on the stack (local-stack-services/edge.mjs): keep the setup well under it.
const pace = () => new Promise((resolve) => setTimeout(resolve, 75));

/** The scope and purpose a take is confirmed under (svc-p2p take-step-up.ts, contracts CUSTOMER_STEP_UP_DOORS). */
export const TAKE_STEP_UP = { scope: 'p2p.step_up.trades.take', purpose: 'trades.take' };
/** The scope and purpose a release is confirmed under (svc-p2p release-step-up.ts): one confirmation covers the
 * session's releases for ten minutes. */
export const RELEASE_STEP_UP = { scope: 'p2p.step_up.trades.confirmReceived', purpose: 'trades.confirmReceived' };
/**
 * Adding, changing or removing a payment method (P-ads-merchant-18): one confirmation per change, naming the digest of
 * the details it saves (contracts' `p2pInstrumentDetailsDigest`, the same function svc-p2p checks it with).
 */
export const INSTRUMENT_STEP_UP = { scope: 'p2p.step_up.instruments.change', purpose: 'instruments.change' };
const INSTRUMENT_CHANGES = { 'instruments.create': 'create', 'instruments.update': 'update', 'instruments.remove': 'remove' };
let ruleClass;
export async function instrumentStepUpRequest(instrumentId, change, details) {
  ruleClass ??= import(pathToFileURL(path.join(ROOT, 'packages/contracts/dist/p2p-rule-class.js')).href);
  const detailsDigest = await (await ruleClass).p2pInstrumentDetailsDigest(details);
  return { ...INSTRUMENT_STEP_UP, target: instrumentId, fields: { instrumentId, change, detailsDigest } };
}

/**
 * svc-p2p through Edge as `who` (an api() session): queries as GET, mutations as POST; the answer or a thrown refusal.
 *
 * With `passkey` (a `testPasskey` saved on the account), a take is confirmed the way the person does it: identity's
 * step-up for exactly that take, sent with it, which then covers this session's takes for ten minutes (svc-p2p
 * `trades.stepUpWindow`). A release is confirmed the same way, with its own ten-minute window. `bare` never confirms
 * anything, so a journey can see a take or a release refused for want of it.
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
  // Inside this session's release window, or for an order this seller already released, no confirmation is asked: ask
  // for one only when svc-p2p refuses for want of it. One confirmation then covers the next ten minutes of releases.
  const release = async (input) => {
    const res = await bare.mutate('trades.confirmReceived', input);
    if (res.status !== 403 || !['auth.step_up_required', 'auth.step_up_expired'].includes(refusalCode(res))) return res;
    const stepUpApprovalId = await confirmStepUp(who, passkey, releaseStepUpRequest(input.tradeId));
    return bare.mutate('trades.confirmReceived', { ...input, stepUpApprovalId });
  };
  // Every payment-method change is confirmed, for exactly that change and those details. A person who never saved a
  // passkey gets a TEST one here, held by this client, at their first change; one who has one passes it to p2p(),
  // since identity lets an account with a factor add another only after confirming.
  let held = passkey;
  const change = async (proc, input) => {
    held ??= await testPasskey(who);
    const request = await instrumentStepUpRequest(input.instrumentId, INSTRUMENT_CHANGES[proc], input.details);
    const stepUpApprovalId = await confirmStepUp(who, held, request);
    return bare.mutate(proc, { ...input, stepUpApprovalId });
  };
  // Posting an ad needs the published advertiser terms accepted (P-ads-merchant-01). The person accepts them in the
  // post-an-ad form (J-p2p-03); a journey that only needs an ad to exist accepts them here when svc-p2p asks.
  const post = async (input) => {
    const res = await bare.mutate('offers.create', input);
    if (res.status !== 403 || refusalCode(res) !== 'p2p.terms_not_accepted') return res;
    await acceptAdvertiserTerms(bare);
    return bare.mutate('offers.create', input);
  };
  return {
    bare,
    /** The api() session this client speaks for (identity reads, the person's own name). */
    session: who,
    /** The TEST passkey this client confirms with: the one it was given, or the one a payment-method change made. */
    passkey: () => held,
    raw: {
      query: bare.query,
      mutate: (proc, input) =>
        proc === 'trades.take'
          ? take(input)
          : proc === 'offers.create'
            ? post(input)
            : proc === 'trades.confirmReceived' && passkey && !input.stepUpApprovalId
              ? release(input)
              : proc in INSTRUMENT_CHANGES && !input.stepUpApprovalId
                ? change(proc, input)
                : bare.mutate(proc, input),
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

/** Accepts the advertiser terms version svc-p2p publishes, as `bare` (a p2p() client's `bare`). */
export async function acceptAdvertiserTerms(bare) {
  const terms = await bare.query('merchants.advertiserTerms');
  const version = terms.body?.result?.data?.version;
  if (terms.status !== 200 || !version)
    throw new Error(`advertiser terms unreadable: ${terms.status} ${JSON.stringify(terms.body).slice(0, 300)}`);
  const accepted = await bare.mutate('merchants.acceptAdvertiserTerms', { version });
  if (accepted.status !== 200)
    throw new Error(`advertiser terms acceptance refused: ${accepted.status} ${JSON.stringify(accepted.body).slice(0, 300)}`);
  return accepted.body.result.data;
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

/** What a release's confirmation names: the order whose escrow goes to the buyer. */
export const releaseStepUpRequest = (tradeId) => ({ ...RELEASE_STEP_UP, target: tradeId, fields: { tradeId } });

/** Identity's step-up for one take, answered with `passkey`: returns the single-use stepUpApprovalId. */
export async function confirmTake(session, passkey, input) {
  return confirmStepUp(session, passkey, takeStepUpRequest(input));
}

/** Identity's step-up for `request` (scope, purpose, target, fields), answered with `passkey`: the single-use approval id. */
export async function confirmStepUp(session, passkey, request) {
  const begun = await session.post('/api/identity/trpc/stepUp.begin', request);
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
    body: JSON.stringify({ deviceKey: DEVICE_KEY, handle: who.handle, email: who.email, password: who.password, region: 'DE' }),
  });
  if (res.status !== 200) throw new Error(`register ${who.email} refused: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return who;
}

/**
 * A taker who meets every take requirement: email confirmed and a TEST passkey to confirm takes with. Pass the
 * account's passkey when it already has one.
 */
export async function readyTaker(session, who, passkey = null) {
  await confirmEmail(session, who);
  return p2p(session, passkey ?? (await testPasskey(session)));
}

/** The TEST legal name a journey person's payment accounts are held in (P-ads-merchant-18's own-name rule). */
export const holderOf = (who) => `TEST ${who.handle}`;

const recordedNames = new Map();
/**
 * Records `name` (default `holderOf(who)`) as `session`'s verified legal name, the way staff do it: founder A edits the
 * protected detail, which opens a compliance review, and founder B passes it (identity accountControls.detailsEdit /
 * detailsDecide). svc-p2p's own-name rule then accepts a payment account held in that name. Returns the name.
 */
export async function verifiedName(session, who, name = holderOf(who)) {
  const me = await session.get('/api/identity/trpc/me');
  const userId = me.body?.result?.data?.userId;
  if (me.status !== 200 || !userId) throw new Error(`identity me refused: ${me.status} ${JSON.stringify(me.body).slice(0, 300)}`);
  if (recordedNames.get(userId) === name) return name;
  const { ctx, pair } = await operators();
  const answer = (what, res) => {
    const out = res.json?.result?.data;
    if (res.status !== 200 || out === undefined) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
    return out;
  };
  const state = answer(
    'accountControls.details',
    await ctx.edge.query('identity', 'accountControls.details', { userId }, await pair.a.approvalToken()),
  );
  if (state?.details?.legalName !== name) {
    const edited = answer(
      'accountControls.detailsEdit',
      await ctx.edge.mutate(
        'identity',
        'accountControls.detailsEdit',
        {
          requestId: randomUUID(),
          userId,
          expectedVersion: state?.version ?? '0',
          reason: 'LOCAL TEST legal name for the P2P own-name rule',
          changes: { legalName: name },
        },
        await pair.a.approvalToken(),
      ),
    );
    if (edited.outcome !== 'review_opened') throw new Error(`legal name edit answered ${edited.outcome} ${edited.code ?? ''}`);
    const passed = answer(
      'accountControls.detailsDecide',
      await ctx.edge.mutate(
        'identity',
        'accountControls.detailsDecide',
        { requestId: randomUUID(), userId, reviewId: edited.reviewId, decision: 'pass', note: 'LOCAL TEST review passed' },
        await pair.b.approvalToken(),
      ),
    );
    if (passed.outcome !== 'applied') throw new Error(`legal name review answered ${passed.outcome} ${passed.code ?? ''}`);
  }
  recordedNames.set(userId, name);
  return name;
}

/** A TEST bank transfer destination for `who`, held in their verified TEST legal name, so their sell ads can be taken. */
export async function testInstrument(client, who) {
  const holder = await verifiedName(client.session, who);
  return client.mutate('instruments.create', {
    instrumentId: randomUUID(),
    methodId: METHOD,
    country: 'DE',
    fiatCurrency: 'EUR',
    label: 'TEST account',
    details: { account_holder: holder, iban: TEST_IBAN },
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

/**
 * Registers a LOCAL TEST method switched on under `methodId`, the same TEST bank transfer as the shared one (DE, account
 * holder in the person's own name, IBAN), with an optional settlement profile. Registering again brings it back from an
 * earlier run's retirement. A journey that retires a method registers its own, so no other journey loses it.
 */
export async function registerTestMethod(methodId, label, settlement = null) {
  const [base] = (await import('../../../../tooling/scripts/local-test-gates.mjs')).TEST_P2P_METHODS;
  const method = { methodId, country: base.country, label, fields: base.fields };
  return operatorMethodChange(
    'instruments.methods.register',
    'p2p.method_register',
    {
      ...method,
      fields: JSON.stringify(method.fields),
      enabled: 'true',
      ...(settlement ? { settlement: JSON.stringify(settlement) } : {}),
    },
    { ...method, enabled: true, ...(settlement ? { settlement } : {}) },
  );
}

/** Retires a LOCAL TEST method in its market (DE) with the operator's `reason`, as the founder pair does. */
export async function retireTestMethod(methodId, reason) {
  return operatorMethodChange(
    'instruments.methods.setEnabled',
    'p2p.method_set_enabled',
    { methodId, country: 'DE', enabled: 'false', reason },
    { methodId, country: 'DE', enabled: false, reason },
  );
}

/** Registers the retiring TEST method switched on, which also brings it back from an earlier run's retirement. */
export const registerRetiringMethod = () => registerTestMethod(RETIRING_METHOD, 'TEST retiring transfer');

/**
 * P-disputes-security-09: a third LOCAL TEST method, the same TEST bank transfer under another id, whose money takes up
 * to two days to arrive (not instant). Registered switched on with that settlement profile, as the founder pair does.
 */
export const SLOW_METHOD = 'test-slow-transfer';
export const SLOW_WINDOW_SECONDS = 172_800;
export const registerSlowMethod = () =>
  registerTestMethod(SLOW_METHOD, 'TEST slow transfer', { instant: false, windowSeconds: SLOW_WINDOW_SECONDS });

/** Retires the retiring TEST method in its market with the operator's `reason`. */
export const retireRetiringMethod = (reason) => retireTestMethod(RETIRING_METHOD, reason);

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
