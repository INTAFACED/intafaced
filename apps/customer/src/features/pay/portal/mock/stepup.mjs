// TEST DATA ONLY. Nothing here is a real person, code, passkey or token.
//
// A stand-in for the identity service's "Confirm it's you" door (`auth.stepUpPay`, with `auth.stepUpOptions` for a passkey)
// and for the check the pay service makes on the five money calls that carry its token. It lets the preview and the
// Playwright runs walk the whole flow: confirm, review, send, and confirm again when the confirmation runs out.
//
// The authenticator code this stand-in accepts is TEST_TOTP_CODE. It is a TEST value that no real authenticator produces.
// Every token it mints starts with STEP_UP_TOKEN_PREFIX and lasts ten minutes, like the real one; a test can run it out at
// once with `expireAll()` instead of waiting.
import { NOT_MINE, ok, refuse } from './shared.mjs';

export const TEST_TOTP_CODE = '000000';
export const STEP_UP_TOKEN_PREFIX = 'TEST-stepup.';
const TEN_MINUTES = 600_000;

/** The money calls that must carry the confirmation token, and the scope each one needs. */
export const MONEY_CALL_SCOPE = {
  'payment.refund': 'pay:refund',
  'settlement.payout': 'pay:payout',
  'merchantControl.approvals.request': 'pay:payout',
  'merchantControl.approvals.cancel': 'pay:payout',
  'conversion.execute': 'pay:payout',
};

/**
 * mode: 'ok' mints for a right code or a passkey; 'role' refuses every mint the way the service does when the person's
 * role on the business cannot refund or pay out; 'keys' refuses it as an API key or sub-account would be refused.
 */
export function createStepUpMock(ctx, { mode = 'ok' } = {}) {
  const minted = [];
  const spent = new Set();
  let challenge = null;
  let issued = 0;
  const begun = new Map();
  const approvals = new Map();
  const encode = (value) => Buffer.from(value).toString('base64url');
  return {
    minted,
    isStepUpToken: (bearer) => typeof bearer === 'string' && bearer.startsWith(STEP_UP_TOKEN_PREFIX),
    /** Run every token out now, as ten minutes would. */
    expireAll() {
      for (const m of minted) m.expiresAt = 0;
    },
    /**
     * What the pay service answers a money call that arrives with `bearer`: null when it passes, otherwise the refusal.
     * A call on the ordinary session carries no money scope (403); a token that ran out is a 401 at the gateway.
     */
    refusalFor(procedure, bearer) {
      const scope = MONEY_CALL_SCOPE[procedure];
      if (!scope) return null;
      const token = minted.find((m) => m.token === bearer);
      if (!token || !token.scopes.includes(scope)) return { status: 403, code: 'pay.scope_missing', message: `Missing scope ${scope}` };
      if (token.expiresAt <= Date.now()) return { status: 401, code: '', message: 'Token expired' };
      return null;
    },
    /** True once for an approval `stepUp.complete` issued for this payout destination (svc-pay consumes it). */
    spendDestinationApproval(id, destination) {
      const held = approvals.get(id);
      approvals.delete(id);
      return Boolean(
        held &&
        ['merchantId', 'railId', 'kind', 'ref'].every((k) => held.fields[k] === destination[k]) &&
        held.scope === 'pay.step_up.payoutDestination.set',
      );
    },
    async handle(procedure, input, route) {
      if (procedure === 'stepUp.begin') {
        if (mode === 'keys') return refuse(route, 403, '', 'API keys and sub-accounts cannot confirm a payment');
        const challengeId = `00000000-0000-4000-8000-${String(++issued).padStart(12, '0')}`;
        begun.set(challengeId, { scope: input.scope, fields: input.fields ?? {} });
        return ok(route, { challengeId, totp: true, webauthn: null });
      }
      if (procedure === 'stepUp.complete') {
        const started = begun.get(input.challengeId);
        // One answer per challenge, right or wrong, as identity does: a retry begins again.
        begun.delete(input.challengeId);
        if (!started) return refuse(route, 401, 'auth.step_up_expired', 'That confirmation expired');
        if (input.totpCode !== TEST_TOTP_CODE) return refuse(route, 401, 'auth.mfa_invalid', 'Invalid two-factor code');
        const stepUpApprovalId = `TEST-approval-${issued}`;
        approvals.set(stepUpApprovalId, started);
        return ok(route, { stepUpApprovalId });
      }
      if (procedure === 'auth.stepUpOptions') {
        challenge = encode(`TEST-challenge-${++issued}`);
        return ok(route, { challenge, timeout: 60000, userVerification: 'preferred', allowCredentials: [] });
      }
      if (procedure !== 'auth.stepUpPay') return NOT_MINE;
      if (mode === 'keys') return refuse(route, 403, '', 'API keys and sub-accounts cannot confirm a payment');
      const scopes = Array.isArray(input.scopes) ? input.scopes : [];
      if (mode === 'role')
        return refuse(
          route,
          403,
          'pay.role_not_allowed',
          `Your role on this merchant does not allow ${scopes.includes('pay:payout') ? 'payout.send' : 'refunds.create'} [pay.role_not_allowed]`,
        );
      const proof = input.factorProof ?? {};
      if ('totpCode' in proof) {
        if (proof.totpCode !== TEST_TOTP_CODE) return refuse(route, 401, 'auth.mfa_invalid', 'Invalid two-factor code');
      } else if ('webauthn' in proof) {
        // The assertion must be signed over the challenge this stand-in issued, once.
        let asked = null;
        try {
          asked = JSON.parse(Buffer.from(proof.webauthn.response.clientDataJSON, 'base64url').toString('utf8')).challenge;
        } catch {
          asked = null;
        }
        if (!asked || asked !== challenge || spent.has(asked))
          return refuse(route, 401, 'auth.webauthn_invalid', 'Invalid two-factor assertion');
        spent.add(asked);
      } else {
        return refuse(
          route,
          412,
          'auth.step_up_required',
          "Confirm it's you with a passkey or authenticator code. [auth.step_up_required]",
        );
      }
      const expiresAt = Date.now() + TEN_MINUTES;
      const token = `${STEP_UP_TOKEN_PREFIX}${minted.length + 1}`;
      minted.push({ token, scopes, expiresAt, merchantId: input.merchantId });
      return ok(route, {
        accessToken: token,
        expiresAt: new Date(expiresAt).toISOString(),
        scopes: ['pay:read', 'pay:write', ...scopes],
        refreshable: false,
      });
    },
  };
}
