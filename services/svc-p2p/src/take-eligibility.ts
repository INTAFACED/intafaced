/**
 * WHAT A PERSON NEEDS BEFORE TAKING AN AD (P-trade-orders-02, P-disputes-security-08).
 *
 * One ordered list of checks, each met, not met or unknown, with the code that
 * says why and the app path that fixes it. `trades.take` refuses with the first
 * failing check's code, so the panel and the refusal can never disagree: both
 * come from `takeEligibility`.
 *
 * Two facts are not this service's to hold and are read, never copied:
 *   · contact: whether the person's email address is confirmed. svc-identity owns
 *     it and answers `me` for the person themself; svc-p2p asks under the
 *     edge-signed principal of this very request (`forwardedPrincipalHeaders`),
 *     so it can only ever learn the caller's own answer.
 *   · verification and region: the jurisdiction matrix (`checkAccess`), the same
 *     rule the module gate applies to every other P2P call.
 *
 * No risk notice gates a take (owner decision 2026-10-27, until launch prep):
 * the accept step and its check are gone. The `p2p.risk_acceptances` table
 * stays in the schema: no take reads it, and `data.export` / `data.erase`
 * (erasure.ts) list and delete the caller's own rows.
 */
import { checkAccess, type KycTier } from '@intafaced/config';
import { forwardedPrincipalHeaders, unwrapTrpcData, type Context } from '@intafaced/contracts';

export const ELIGIBILITY_CHECK_IDS = ['verification', 'contact', 'jurisdiction', 'deposit'] as const;
export type EligibilityCheckId = (typeof ELIGIBILITY_CHECK_IDS)[number];
export const ELIGIBILITY_STATES = ['met', 'not_met', 'unknown'] as const;
export type EligibilityState = (typeof ELIGIBILITY_STATES)[number];

export interface EligibilityCheck {
  readonly id: EligibilityCheckId;
  readonly state: EligibilityState;
  /** Why, as a code the app turns into words. Never prose from here. */
  readonly reason: string;
  /** The app path that fixes a check that is not met, or null when nothing in the app can. */
  readonly fix: string | null;
}

export type TakeGateCode = 'p2p.contact_required' | 'p2p.contact_unverifiable' | 'p2p.take_gate_unwired';

export class TakeGateError extends Error {
  constructor(
    message: string,
    readonly code: TakeGateCode,
  ) {
    super(message);
    this.name = 'TakeGateError';
  }
}

/** Is the person's own email address confirmed? Throws `p2p.contact_unverifiable` when it cannot be read. */
export interface ContactReader {
  emailConfirmed(ctx: Pick<Context, 'forwardedPrincipal'>): Promise<boolean>;
}

/** No IDENTITY_URL: nothing can say the address is confirmed, so the check is unknown and takes refuse. */
export function unwiredContactReader(): ContactReader {
  return {
    async emailConfirmed() {
      throw new TakeGateError('p2p.contact_unverifiable: IDENTITY_URL is unset', 'p2p.contact_unverifiable');
    },
  };
}

/**
 * svc-identity's `me`, asked as the person of this request. The edge-signed principal passes through byte for byte;
 * svc-p2p holds no key to sign one, so a request without it (a service call) cannot ask for anyone.
 */
export function createIdentityContactReader(options: { identityUrl: string; fetcher?: typeof fetch; timeoutMs?: number }): ContactReader {
  const base = options.identityUrl.replace(/\/$/, '');
  return {
    async emailConfirmed(ctx) {
      const headers = forwardedPrincipalHeaders(ctx);
      if (Object.keys(headers).length === 0) {
        throw new TakeGateError('p2p.contact_unverifiable: no edge-signed principal on this request', 'p2p.contact_unverifiable');
      }
      let body: unknown;
      try {
        const response = await (options.fetcher ?? fetch)(`${base}/trpc/me`, {
          method: 'GET',
          redirect: 'error',
          headers,
          signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
        });
        if (!response.ok) throw new Error(`identity me answered ${response.status}`);
        body = await response.json();
      } catch (error) {
        throw new TakeGateError(
          `p2p.contact_unverifiable: ${error instanceof Error ? error.message : 'identity unreachable'}`,
          'p2p.contact_unverifiable',
        );
      }
      const confirmed = (unwrapTrpcData(body) as { emailVerified?: unknown } | null)?.emailVerified;
      if (typeof confirmed !== 'boolean') {
        throw new TakeGateError('p2p.contact_unverifiable: identity me carried no emailVerified', 'p2p.contact_unverifiable');
      }
      return confirmed;
    },
  };
}

export interface Eligibility {
  /** Every check, in the order the panel shows them. */
  readonly checks: readonly EligibilityCheck[];
}

export interface TakeGate {
  eligibility(ctx: TakeGateContext): Promise<Eligibility>;
  /** The first failing check's refusal, or nothing. Called before a take locks anything. */
  assertCanTake(ctx: TakeGateContext): Promise<void>;
}

export type TakeGateContext = Pick<Context, 'forwardedPrincipal' | 'region'> & {
  readonly principal: { readonly userId: string; readonly tier: KycTier };
};

const KYC_FIX = '/verification';
const CONTACT_FIX = '/uc/account';

export function createTakeGate(deps: { contact: ContactReader }): TakeGate {
  async function contactCheck(ctx: TakeGateContext): Promise<EligibilityCheck> {
    try {
      return (await deps.contact.emailConfirmed(ctx))
        ? { id: 'contact', state: 'met', reason: 'contact.email_confirmed', fix: null }
        : { id: 'contact', state: 'not_met', reason: 'p2p.contact_required', fix: CONTACT_FIX };
    } catch (error) {
      if (error instanceof TakeGateError) return { id: 'contact', state: 'unknown', reason: error.code, fix: null };
      throw error;
    }
  }

  function matrixChecks(ctx: TakeGateContext): [EligibilityCheck, EligibilityCheck] {
    const decision = checkAccess({ module: 'p2p', plane: 'fiat', region: ctx.region, kycTier: ctx.principal.tier });
    if (decision.allowed) {
      return [
        { id: 'verification', state: 'met', reason: `tier.${ctx.principal.tier}`, fix: null },
        { id: 'jurisdiction', state: 'met', reason: 'region.allowed', fix: null },
      ];
    }
    if (decision.code === 'denied.kyc_required') {
      return [
        { id: 'verification', state: 'not_met', reason: 'denied.kyc_required', fix: KYC_FIX },
        { id: 'jurisdiction', state: 'met', reason: 'region.allowed', fix: null },
      ];
    }
    // The region refused first, so the matrix never reached the tier: say that, rather than guess.
    return [
      { id: 'verification', state: 'unknown', reason: decision.code, fix: null },
      { id: 'jurisdiction', state: 'not_met', reason: decision.code, fix: null },
    ];
  }

  async function eligibility(ctx: TakeGateContext): Promise<Eligibility> {
    const [verification, jurisdiction] = matrixChecks(ctx);
    const contact = await contactCheck(ctx);
    // A taker posts no security deposit: only a merchant's ads can need one (P-ads-merchant lane).
    const deposit: EligibilityCheck = { id: 'deposit', state: 'met', reason: 'deposit.none_for_takers', fix: null };
    return { checks: [verification, contact, jurisdiction, deposit] };
  }

  return {
    eligibility,
    async assertCanTake(ctx) {
      // Verification and region are refused by the module gate before a take reaches here. The contact check the
      // panel shows decides the refusal.
      const contact = await contactCheck(ctx);
      if (contact.state !== 'met') {
        if (contact.reason === 'p2p.contact_required') {
          throw new TakeGateError('p2p.contact_required: confirm your email address before taking an ad', 'p2p.contact_required');
        }
        throw new TakeGateError(
          `p2p.contact_unverifiable: identity could not say whether the email address is confirmed`,
          'p2p.contact_unverifiable',
        );
      }
    },
  };
}

/** No gate installed: every take refuses rather than skipping the checks. */
export function unwiredTakeGate(): TakeGate {
  const refuse = (): never => {
    throw new TakeGateError('p2p.take_gate_unwired: no eligibility gate is installed', 'p2p.take_gate_unwired');
  };
  return { eligibility: refuse, assertCanTake: refuse };
}
