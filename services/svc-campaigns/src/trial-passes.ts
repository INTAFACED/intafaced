/**
 * VIP trial passes granted as a campaign reward (CM-vip-tiers-01, J-campaigns-14 #2 #3).
 *
 * A `trial_pass` campaign names a tier of the owner's tier programme on spend and a span in seconds. An operator grants
 * its pass to one account while the campaign is active; svc-trade holds the pass (`POST /internal/tier-pass`), keyed
 * `trial-pass:<campaign>:<account>`, and charges the account's orders at the pass's tier while it is in force. A grant
 * repeated answers the pass already granted. A later pass replaces the one in force, and a pass ends once: both in
 * svc-trade. Nothing is owed or paid here, so there is no reward intent and no balance.
 */
import type postgres from 'postgres';
import {
  serviceCallSigner,
  trialPassGrantSchema,
  type CampaignState,
  type CampaignTrialPass,
  type ServiceAuthMode,
  type ServiceSigner,
  type TrialPassGrant,
} from '@intafaced/contracts';
import { CampaignsError } from './codes.js';
import { effectiveState } from './campaigns.js';

/** svc-trade's door that grants the pass. Each failure is a typed refusal, never a pass assumed. */
export interface TierPassDoor {
  grant(input: {
    userId: string;
    campaignId: string;
    tierId: string;
    seconds: number;
    grantedBy: string;
  }): Promise<{ ok: true; grant: TrialPassGrant } | { ok: false; code: string; unreachable: boolean }>;
}

export function createTierPassDoor(options: {
  tradeUrl: string;
  internalSecret: string;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
  fetchFn?: typeof globalThis.fetch;
}): TierPassDoor {
  const target = new URL('/internal/tier-pass', options.tradeUrl.replace(/\/$/, '') + '/');
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const sign = serviceCallSigner({
    service: 'svc-campaigns',
    audience: 'svc-trade',
    legacySecret: options.internalSecret,
    s2s: options.s2s,
  });
  return {
    async grant(input) {
      const body = JSON.stringify(input);
      let response: Response;
      try {
        response = await fetchFn(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...sign(body, { method: 'POST', url: target, contentType: 'application/json' }) },
          body,
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        return { ok: false, code: 'trade.unreachable', unreachable: true };
      }
      let answer: unknown = null;
      try {
        answer = await response.json();
      } catch {
        answer = null;
      }
      if (!response.ok) {
        const code = (answer as { code?: unknown } | null)?.code;
        return {
          ok: false,
          code: typeof code === 'string' && /^[a-z_.]+$/.test(code) ? code : `trade.http_${response.status}`,
          unreachable: response.status >= 500,
        };
      }
      const parsed = trialPassGrantSchema.safeParse(answer);
      return parsed.success ? { ok: true, grant: parsed.data } : { ok: false, code: 'trade.tier_pass_answer', unreachable: true };
    },
  };
}

type TrialPassRow = {
  id: string;
  type: string;
  state: CampaignState;
  starts_at: Date | null;
  ends_at: Date | null;
  trial_pass: CampaignTrialPass | null;
};

export class TrialPassService {
  private readonly sql: postgres.Sql;
  private readonly door: TierPassDoor | null;
  private readonly now: () => Date;

  constructor(deps: { sql: postgres.Sql; door: TierPassDoor | null; now?: () => Date }) {
    this.sql = deps.sql;
    this.door = deps.door;
    this.now = deps.now ?? (() => new Date());
  }

  /** Grants `campaignId`'s pass to `accountId`, once. The campaign must be an active `trial_pass` with its terms set. */
  async grant(campaignId: string, accountId: string, by: { actor: string; reason: string }): Promise<TrialPassGrant> {
    const [row] = await this.sql<TrialPassRow[]>`
      SELECT id, type, state, starts_at, ends_at, trial_pass FROM campaigns.campaigns WHERE id = ${campaignId}`;
    if (!row || ['draft', 'pending_approval', 'approved'].includes(row.state))
      throw new CampaignsError('campaign.unknown', 'No such campaign');
    if (row.type !== 'trial_pass') throw new CampaignsError('campaigns.not_trial_pass', 'This campaign is not a trial pass');
    if (effectiveState(row, this.now()) !== 'active') throw new CampaignsError('campaign.not_active', 'This campaign is not active');
    const terms = row.trial_pass;
    if (!terms?.tierId || terms.seconds === null)
      throw new CampaignsError('campaigns.trial_pass_unset', 'The trial pass terms are not set');
    if (!this.door) throw new CampaignsError('campaigns.trial_pass_unreachable', 'svc-trade is not wired: no pass can be granted');
    await this.sql`
      INSERT INTO campaigns.audit_log (actor, action, target, detail)
      VALUES (${by.actor}, 'campaign.trial_pass.grant_requested', ${row.id},
              ${this.sql.json({ accountId, reason: by.reason, tierId: terms.tierId, seconds: terms.seconds })})`;
    const answer = await this.door.grant({
      userId: accountId,
      campaignId: row.id,
      tierId: terms.tierId,
      seconds: terms.seconds,
      grantedBy: by.actor,
    });
    if (!answer.ok) {
      throw new CampaignsError(
        answer.unreachable ? 'campaigns.trial_pass_unreachable' : 'campaigns.trial_pass_refused',
        `svc-trade did not grant the pass (${answer.code})`,
      );
    }
    return answer.grant;
  }
}
