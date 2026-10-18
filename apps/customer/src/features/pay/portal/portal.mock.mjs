// Browser mock of the pay service for the merchant portal's Playwright run and screenshots.
// EVERYTHING HERE IS TEST DATA. No real merchant, customer, amount or id. Refs are prefixed TEST so they cannot be mistaken for real ones.
//
// This file only routes. Each package owns the fixtures and answers for its own procedures:
//   mock/world.mjs (the ONE set of payments, settlements, refunds, customers and ledger that every number is worked out from),
//   mock/core.mjs (account, headline numbers, halts, notifications), mock/writes.mjs (refund, links, subscriptions, sessions),
//   money/mock.mjs, payments/mock.mjs, settings/mock.mjs,
//   settings/b-mock.mjs (developers, reports and analytics).
// A part returns NOT_MINE for a procedure it does not own. `mock-contract.test.ts` parses every answer with the same
// schemas the client uses, so a fixture that drifts from the real shape fails a test instead of a screenshot.
import { DAY, NOT_MINE, USER_ID, iso, mockContext, ok, refuse } from './mock/shared.mjs';
import { createCoreMock } from './mock/core.mjs';
import { createWritesMock } from './mock/writes.mjs';
import { createMoneyMock } from './money/mock.mjs';
import { createPaymentsMock } from './payments/mock.mjs';
import { createSettingsMock } from './settings/mock.mjs';
import { createSettingsBMock } from './settings/b-mock.mjs';
import { createStepUpMock, TEST_TOTP_CODE } from './mock/stepup.mjs';

export { USER_ID, TEST_TOTP_CODE };

/**
 * The scopes an owner session carries. Identity today grants an owner `pay:read`, `pay:write` and `pay:onboard` and never
 * `pay:refund` or `pay:payout` (svc-identity `scopesForNewAccessToken`): they come only from "Confirm it's you"
 * (`auth.stepUpPay`, answered by `mock/stepup.mjs` with the TEST code `TEST_TOTP_CODE`), and the token that carries them is
 * held apart from the session. `OWNER_SCOPES_WITH_MONEY` is kept for a test that wants a session already carrying them.
 */
export const OWNER_SCOPES = ['pay:read', 'pay:write', 'pay:onboard'];
export const OWNER_SCOPES_WITH_MONEY = [...OWNER_SCOPES, 'pay:refund', 'pay:payout'];
/** An access token shaped like identity's (header.payload.signature) whose payload carries `scopes`. The signature is not real: the portal only reads the claim to decide which controls to draw. */
export function accessTokenFor(scopes = OWNER_SCOPES) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: USER_ID, scopes, tier: 'full', mfa: true })}.stand-in-signature`;
}

/**
 * scenario: 'active' (verified merchant with activity), 'new' (no merchant), 'quiet' (merchant, no activity yet),
 * 'soon' (operations service not switched on), 'down' (service unreachable), 'halted' (as 'active' with payouts paused).
 */
export function createPortalMock(scenario = 'active', { now = Date.now(), myAccess = 'owner', role = 'owner', stepUp = 'ok' } = {}) {
  const calls = [];
  /** Procedures nothing answered, so the review board can list what a not-live card is waiting for. */
  const unmounted = [];
  const ctx = mockContext(scenario, now, { myAccess, role });
  const stepUpMock = createStepUpMock(ctx, { mode: stepUp });
  const parts = [
    stepUpMock,
    createCoreMock(ctx),
    createMoneyMock(ctx),
    createPaymentsMock(ctx),
    createWritesMock(ctx),
    createSettingsBMock(ctx),
    createSettingsMock(ctx),
  ];

  // A reload or a typed address starts the app again with nothing in memory, and the app asks the identity service to
  // restore the sign-in from the cookie. The stand-in plays the cookie: once a request has carried the signed-in token,
  // the person counts as signed in until the app signs out, and the restore answers with a session. Before that nothing
  // answers, so the sign-in form still shows first. A caller that cannot show request headers (the preview server) is
  // always treated as signed in, because it answers the sign-in itself.
  let signedIn = false;
  let token = 'TEST-only';
  const heldToken = (route) => {
    const headers = route.request().headers?.();
    if (!headers) return undefined; // no headers to read
    const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '');
    return bearer ? bearer[1] : null;
  };
  /** Notes the signed-in token on a request (pay and identity both carry it). Returns it, or null, or undefined when headers cannot be read. */
  const noteSignIn = (route) => {
    const held = heldToken(route);
    // A confirmation token is not the sign-in: it never becomes the session the restore answers with.
    if (held && !stepUpMock.isStepUpToken(held)) {
      signedIn = true;
      token = held;
    }
    return held;
  };
  async function handle(route) {
    noteSignIn(route);
    const url = new URL(route.request().url());
    const procedure = decodeURIComponent(url.pathname.split('/trpc/')[1] ?? '');
    const method = route.request().method();
    const input = method === 'GET' ? (JSON.parse(url.searchParams.get('input') ?? 'null') ?? {}) : (route.request().postDataJSON() ?? {});
    const bearer = heldToken(route);
    calls.push({ procedure, method, input, bearer: bearer ?? null });
    // The five money calls must carry a confirmation token that is still good. Where headers cannot be read (the contract test), they pass.
    if (bearer !== undefined) {
      const refusal = stepUpMock.refusalFor(procedure, bearer);
      if (refusal) return refuse(route, refusal.status, refusal.code, refusal.message);
    }
    if (scenario === 'down') return refuse(route, 503, '', 'Service unavailable');
    if (
      scenario === 'soon' &&
      (procedure.startsWith('merchantOps.') ||
        procedure.startsWith('merchantMetrics.') ||
        procedure.startsWith('merchantControl.') ||
        procedure.startsWith('payHalts.'))
    )
      return refuse(route, 501, 'pay.not_built', 'pay.not_built: not built yet');
    for (const part of parts) {
      const answered = await part.handle(procedure, input, route);
      if (answered !== NOT_MINE) return answered;
    }
    unmounted.push(procedure);
    return refuse(route, 404, '', `No procedure ${procedure}`);
  }
  /** Identity procedures (sessions, devices, restoring a sign-in) are answered only when something here owns them; anything else falls through to the test's own route. */
  async function handleIdentity(route) {
    const url = new URL(route.request().url());
    const procedure = decodeURIComponent(url.pathname.split('/trpc/')[1] ?? '');
    const method = route.request().method();
    const held = noteSignIn(route);
    if (procedure === 'auth.refresh' && (signedIn || held === undefined)) {
      return ok(route, { userId: USER_ID, accessToken: token, expiresAt: iso(Date.now() + 30 * DAY) });
    }
    if (procedure === 'auth.logout') {
      signedIn = false;
      return ok(route, { ok: true });
    }
    const input = method === 'GET' ? (JSON.parse(url.searchParams.get('input') ?? 'null') ?? {}) : (route.request().postDataJSON() ?? {});
    for (const part of parts) {
      const answered = await part.handle(procedure, input, route);
      if (answered !== NOT_MINE) {
        calls.push({ procedure, method, input, bearer: held ?? null });
        return answered;
      }
    }
    return route.fallback();
  }
  return {
    calls,
    unmounted,
    state: ctx.state,
    /** The confirmation tokens this stand-in has minted, and a way to run them all out at once. */
    stepUp: { minted: stepUpMock.minted, expireAll: stepUpMock.expireAll },
    /** The one fixture world, so a test can read the figures a page should show. */
    world: ctx.world,
    /** Answer one request directly. Used by the contract test, which has no browser. */
    handle,
    async install(page) {
      await page.route('**/api/pay/trpc/**', handle);
      await page.route('**/api/identity/trpc/**', handleIdentity);
    },
  };
}
