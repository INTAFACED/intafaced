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
 * The risk notice is the one fact held here: a versioned acceptance row per
 * person. The version is owner-published (`P2P_RISK_NOTICE_VERSION`). Blank
 * refuses every take with `p2p.risk_notice_unset`: a gate that admits a take
 * treats an unpublished setting as closed.
 */
import { checkAccess, type KycTier } from '@intafaced/config';
import { forwardedPrincipalHeaders, unwrapTrpcData, type Context } from '@intafaced/contracts';
import type { Sql } from 'postgres';

export const ELIGIBILITY_CHECK_IDS = ['verification', 'contact', 'jurisdiction', 'deposit', 'risk'] as const;
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

export type TakeGateCode =
  | 'p2p.contact_required'
  | 'p2p.contact_unverifiable'
  | 'p2p.risk_not_accepted'
  | 'p2p.risk_notice_unset'
  | 'p2p.risk_version_stale'
  | 'p2p.take_gate_unwired';

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

/** The owner-published risk notice version: trimmed, or null when blank. */
export function riskNoticeVersion(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value ? value : null;
}

export interface RiskAcceptance {
  readonly version: string;
  readonly acceptedAt: Date;
}

/** Versioned acceptance rows: one per person and version, written once. */
export class RiskAcceptances {
  constructor(private readonly sql: Sql) {}

  async current(userId: string, version: string): Promise<RiskAcceptance | null> {
    const rows = await this.sql<{ version: string; accepted_at: Date }[]>`
      SELECT version, accepted_at FROM p2p.risk_acceptances WHERE user_id = ${userId} AND version = ${version}`;
    const row = rows[0];
    return row ? { version: row.version, acceptedAt: row.accepted_at } : null;
  }

  /** Idempotent: accepting a version again returns the first acceptance, unchanged. */
  async accept(userId: string, version: string): Promise<RiskAcceptance> {
    await this.sql`
      INSERT INTO p2p.risk_acceptances (user_id, version) VALUES (${userId}, ${version})
      ON CONFLICT (user_id, version) DO NOTHING`;
    const accepted = await this.current(userId, version);
    if (!accepted) throw new Error('risk acceptance row missing after insert');
    return accepted;
  }
}

export interface RiskNoticeState {
  readonly version: string;
  readonly acceptedAt: Date | null;
}

export interface Eligibility {
  /** Every check, in the order the panel shows them. */
  readonly checks: readonly EligibilityCheck[];
  /** The published risk notice and the caller's acceptance of it, or null when no version is published. */
  readonly notice: RiskNoticeState | null;
}

export interface TakeGate {
  eligibility(ctx: TakeGateContext): Promise<Eligibility>;
  /** The first failing check's refusal, or nothing. Called before a take locks anything. */
  assertCanTake(ctx: TakeGateContext): Promise<void>;
  /** The notice version to accept, or `p2p.risk_notice_unset`. */
  riskNotice(userId: string): Promise<RiskNoticeState>;
  /** Accept exactly the published version; any other refuses `p2p.risk_version_stale`. */
  acceptRisk(userId: string, version: string): Promise<RiskAcceptance>;
}

export type TakeGateContext = Pick<Context, 'forwardedPrincipal' | 'region'> & {
  readonly principal: { readonly userId: string; readonly tier: KycTier };
};

const KYC_FIX = '/verification';
const CONTACT_FIX = '/uc/account';

export function createTakeGate(deps: { contact: ContactReader; acceptances: RiskAcceptances; riskVersion: string | null }): TakeGate {
  const requireVersion = (): string => {
    if (!deps.riskVersion) throw new TakeGateError('p2p.risk_notice_unset: P2P_RISK_NOTICE_VERSION is unset', 'p2p.risk_notice_unset');
    return deps.riskVersion;
  };

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

  async function riskCheck(userId: string): Promise<{ check: EligibilityCheck; notice: RiskNoticeState | null }> {
    if (!deps.riskVersion) return { check: { id: 'risk', state: 'unknown', reason: 'p2p.risk_notice_unset', fix: null }, notice: null };
    const accepted = await deps.acceptances.current(userId, deps.riskVersion);
    return {
      check: accepted
        ? { id: 'risk', state: 'met', reason: 'risk.accepted', fix: null }
        : { id: 'risk', state: 'not_met', reason: 'p2p.risk_not_accepted', fix: null },
      notice: { version: deps.riskVersion, acceptedAt: accepted?.acceptedAt ?? null },
    };
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
    const [contact, risk] = await Promise.all([contactCheck(ctx), riskCheck(ctx.principal.userId)]);
    // A taker posts no security deposit: only a merchant's ads can need one (P-ads-merchant lane).
    const deposit: EligibilityCheck = { id: 'deposit', state: 'met', reason: 'deposit.none_for_takers', fix: null };
    return { checks: [verification, contact, jurisdiction, deposit, risk.check], notice: risk.notice };
  }

  return {
    eligibility,
    async assertCanTake(ctx) {
      // Verification and region are refused by the module gate before a take reaches here. The same two checks the
      // panel shows decide the refusal, in the panel's order.
      const [contact, risk] = await Promise.all([contactCheck(ctx), riskCheck(ctx.principal.userId)]);
      if (contact.state !== 'met') {
        if (contact.reason === 'p2p.contact_required') {
          throw new TakeGateError('p2p.contact_required: confirm your email address before taking an ad', 'p2p.contact_required');
        }
        throw new TakeGateError(
          `p2p.contact_unverifiable: identity could not say whether the email address is confirmed`,
          'p2p.contact_unverifiable',
        );
      }
      if (risk.check.reason === 'p2p.risk_notice_unset') {
        throw new TakeGateError('p2p.risk_notice_unset: P2P_RISK_NOTICE_VERSION is unset', 'p2p.risk_notice_unset');
      }
      if (risk.check.state !== 'met') {
        throw new TakeGateError(
          `p2p.risk_not_accepted: accept the P2P risk notice ${risk.notice?.version ?? ''} before taking an ad`,
          'p2p.risk_not_accepted',
        );
      }
    },
    async riskNotice(userId) {
      const version = requireVersion();
      const accepted = await deps.acceptances.current(userId, version);
      return { version, acceptedAt: accepted?.acceptedAt ?? null };
    },
    async acceptRisk(userId, version) {
      const current = requireVersion();
      if (version !== current) {
        throw new TakeGateError(`p2p.risk_version_stale: the published notice is ${current}`, 'p2p.risk_version_stale');
      }
      return deps.acceptances.accept(userId, current);
    },
  };
}

/** No gate installed: every take refuses rather than skipping the checks. */
export function unwiredTakeGate(): TakeGate {
  const refuse = (): never => {
    throw new TakeGateError('p2p.take_gate_unwired: no eligibility gate is installed', 'p2p.take_gate_unwired');
  };
  return { eligibility: refuse, assertCanTake: refuse, riskNotice: refuse, acceptRisk: refuse };
}
