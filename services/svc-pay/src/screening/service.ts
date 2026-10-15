import type { Sql } from 'postgres';
import { checkAccess, activeScreeningList, screeningFailClosedFromEnv } from '@intafaced/config/jurisdiction';
import {
  createScreeningSocket,
  createFixtureScreeningProvider,
  type ScreeningProvider,
  type ScreeningDecision,
  type ScreeningFixtureCase,
} from '@intafaced/screening';
import { PayGuardRefusal, type PayoutExecuteContext } from '../seams/guards.js';

export interface KybScreeningInput {
  readonly merchantId: string;
  readonly kybRef: string;
}
export interface DestinationScreeningInput {
  readonly merchantId: string;
  readonly railId: string;
  readonly kind: string;
  readonly ref: string;
}
export interface ScreeningReview {
  settlementId: string;
  attempt: number;
  merchantId: string;
  provider: string;
  fixture: boolean;
  createdAt: string;
}

/** No operator override: a parked payout only resumes after a subsequent provider pass. */
export class PayScreeningService {
  private readonly socket;
  private readonly env: Record<string, string | undefined>;
  private readonly sql: Sql;
  constructor(options: { sql: Sql; provider?: ScreeningProvider; env?: Record<string, string | undefined> }) {
    this.sql = options.sql;
    this.env = options.env ?? process.env;
    let provider = options.provider;
    if (!provider && this.env.PAY_SCREENING_PROVIDER === 'fixture' && (this.env.APP_ENV === 'dev' || this.env.APP_ENV === 'test')) {
      try {
        const cases: unknown = JSON.parse(this.env.PAY_SCREENING_FIXTURE_CASES ?? 'null');
        if (Array.isArray(cases))
          provider = createFixtureScreeningProvider({ appEnv: this.env.APP_ENV, cases: cases as ScreeningFixtureCase[] });
      } catch {
        /* Malformed fixture config stays unavailable, without logging its PII. */
      }
    }
    this.socket = createScreeningSocket({ appEnv: this.env.APP_ENV, provider });
  }

  /** Convert DB/provider errors at every direct-call boundary without retaining sensitive causes. */
  private async closed<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof PayGuardRefusal) throw error;
      const code = (error as { code?: unknown } | null)?.code;
      if (code === '40001' || code === '40P01') throw error;
      throw new PayGuardRefusal('pay.guard_screening_unavailable', 'unavailable');
    }
  }

  private requirePass(decision: ScreeningDecision): void {
    if (decision.outcome === 'pass') return;
    throw new PayGuardRefusal(`pay.guard_screening_${decision.outcome}`, decision.outcome === 'unavailable' ? 'unavailable' : 'refused');
  }

  private async partyDecision(merchantId: string, connection: Sql, kybRef?: string): Promise<ScreeningDecision> {
    let ref = kybRef;
    if (!ref) {
      // No row locks. In particular never reacquire an earlier merchant/link lock.
      const [merchant] = await connection<Array<{ kyb_ref: string | null }>>`SELECT kyb_ref FROM pay.merchants WHERE id=${merchantId}`;
      ref = merchant?.kyb_ref ?? undefined;
    }
    if (!ref) throw new PayGuardRefusal('pay.guard_screening_unavailable', 'unavailable');
    const context = await this.socket.resolveParty({ merchantId, kybRef: ref });
    if (!context) throw new PayGuardRefusal('pay.guard_screening_unavailable', 'unavailable');
    // Account identity KYC comes from the trusted resolver; it is independent of
    // merchant KYB, so submitting a first dossier does not require approved KYB.
    const explicitLocal = this.env.APP_ENV === 'dev' || this.env.APP_ENV === 'test';
    const access = checkAccess({
      module: 'pay',
      region: context.country,
      plane: 'fiat',
      kycTier: context.identityKycTier,
      screening: activeScreeningList(this.env),
      regionFailClosed: true,
      screeningFailClosed: explicitLocal ? screeningFailClosedFromEnv(this.env) : true,
    });
    if (!access.allowed) throw new PayGuardRefusal('pay.guard_screening_region', 'refused');
    return this.socket.screenParty({ name: context.name, country: context.country, registration: context.registration });
  }

  async beforeKybSubmit(input: KybScreeningInput, connection: Sql = this.sql): Promise<void> {
    return this.closed(async () => this.requirePass(await this.partyDecision(input.merchantId, connection, input.kybRef)));
  }

  private async destinationDecision(input: DestinationScreeningInput, connection: Sql): Promise<ScreeningDecision> {
    const party = await this.partyDecision(input.merchantId, connection);
    if (party.outcome !== 'pass' || input.kind !== 'crypto') return party;
    // Only the actual configured chain id identifies crypto-native's chain.
    // Neither EVM-shaped addresses nor asset names determine a network.
    const chain = this.env.PAY_CRYPTO_CHAIN_ID?.trim();
    if (input.railId !== 'crypto-native' || !chain || !/^[1-9][0-9]*$/.test(chain)) {
      return { outcome: 'unavailable', provider: this.socket.provider, fixture: this.socket.fixture };
    }
    return this.socket.screenWallet({ address: input.ref, chain: `eip155:${chain}` });
  }

  async beforeDestinationPersist(input: DestinationScreeningInput, connection: Sql = this.sql): Promise<void> {
    return this.closed(async () => this.requirePass(await this.destinationDecision(input, connection)));
  }

  async beforePayoutExecute(ctx: PayoutExecuteContext): Promise<void> {
    if (ctx.replay.kind === 'recovery') return;
    return this.closed(async () => {
      const decision = await this.destinationDecision({ merchantId: ctx.merchantId, railId: ctx.railId, ...ctx.destination }, ctx.sql);
      if (decision.outcome === 'review') {
        // Execute runs outside admission's transaction, before hold/rail. A
        // durable review therefore survives the refusal with no second connection.
        await this.recordPayoutReview(ctx, ctx.sql);
      }
      this.requirePass(decision);
      await ctx.sql`UPDATE pay.screening_reviews SET resolved_at=now() WHERE settlement_id=${ctx.settlementId} AND attempt=${ctx.attempt} AND resolved_at IS NULL`;
    });
  }

  /** Call only outside admission's transaction, including after its refusal rollback. */
  async recordPayoutReview(
    input: { settlementId: string; attempt: number; merchantId: string },
    connection: Sql = this.sql,
  ): Promise<void> {
    return this.closed(async () => {
      await connection`
        INSERT INTO pay.screening_reviews(settlement_id,attempt,merchant_id,provider,fixture)
        VALUES(${input.settlementId},${input.attempt},${input.merchantId},${this.socket.provider},${this.socket.fixture})
        ON CONFLICT(settlement_id,attempt) DO UPDATE
        SET resolved_at=NULL,provider=excluded.provider,fixture=excluded.fixture
      `;
    });
  }

  async listReviews(input: { limit: number }): Promise<ScreeningReview[]> {
    return this.closed(async () => {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200)
        throw new PayGuardRefusal('pay.guard_screening_limit_invalid', 'refused');
      const rows = await this.sql<
        Array<{ settlement_id: string; attempt: number; merchant_id: string; provider: string; fixture: boolean; created_at: Date }>
      >`
        SELECT settlement_id,attempt,merchant_id,provider,fixture,created_at FROM pay.screening_reviews
        WHERE resolved_at IS NULL ORDER BY created_at,settlement_id,attempt LIMIT ${input.limit}
      `;
      return rows.map((r) => ({
        settlementId: r.settlement_id,
        attempt: r.attempt,
        merchantId: r.merchant_id,
        provider: r.provider,
        fixture: r.fixture,
        createdAt: r.created_at.toISOString(),
      }));
    });
  }
}
