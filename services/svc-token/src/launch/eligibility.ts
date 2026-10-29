import {
  campaignParticipantSchema,
  serviceCallSigner,
  type CampaignParticipant,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';
import { LaunchError } from './errors.js';
import type { LaunchEvent } from './launch-service.js';

/**
 * Who may take part in a launch (J-more-catalogue-11 #4): a requirements list, each item met or not, read per check.
 *
 * The rule is two owner values. A blank tier refuses `launch.min_kyc_tier_unset`, blank regions `launch.restricted_regions_unset`; nothing is defaulted:
 * - `TOKEN_LAUNCH_MIN_KYC_TIER`: the least identity verification (`none`, `basic`, `full`, `institutional`).
 * - `TOKEN_LAUNCH_RESTRICTED_REGIONS`: two-letter regions that may not take part, comma separated, or `none`.
 *
 * Who the account is comes from svc-identity's `GET /internal/campaign-participant/:userId` (service credentials).
 * svc-token keeps no copy. An unread account refuses `launch.eligibility_unavailable`, never reads as eligible.
 */

const KYC_TIERS = ['none', 'basic', 'full', 'institutional'] as const;
type KycTier = (typeof KYC_TIERS)[number];

export interface EligibilityRule {
  minKycTier: KycTier;
  restrictedRegions: readonly string[];
}

export function parseEligibilityRule(env: {
  TOKEN_LAUNCH_MIN_KYC_TIER?: string;
  TOKEN_LAUNCH_RESTRICTED_REGIONS?: string;
}): EligibilityRule {
  const tier = env.TOKEN_LAUNCH_MIN_KYC_TIER?.trim() ?? '';
  const regions = env.TOKEN_LAUNCH_RESTRICTED_REGIONS?.trim() ?? '';
  // One typed code per owner value, so the refusal names which one is blank. A malformed value refuses as unset.
  if (tier === '') throw new LaunchError('TOKEN_LAUNCH_MIN_KYC_TIER is not set', 'launch.min_kyc_tier_unset');
  if (!(KYC_TIERS as readonly string[]).includes(tier))
    throw new LaunchError('TOKEN_LAUNCH_MIN_KYC_TIER is not a tier', 'launch.min_kyc_tier_unset');
  if (regions === '') throw new LaunchError('TOKEN_LAUNCH_RESTRICTED_REGIONS is not set', 'launch.restricted_regions_unset');
  let restrictedRegions: string[] = [];
  if (regions !== 'none') {
    restrictedRegions = regions.split(',').map((r) => r.trim());
    if (restrictedRegions.some((r) => !/^[A-Z]{2}$/.test(r))) {
      throw new LaunchError('TOKEN_LAUNCH_RESTRICTED_REGIONS is not a list of two-letter regions', 'launch.restricted_regions_unset');
    }
  }
  return { minKycTier: tier as KycTier, restrictedRegions };
}

export type RequirementId = 'identity_verification' | 'region' | 'account_active' | 'main_account' | 'issuer_onboarded' | 'event_open';

export interface Requirement {
  id: RequirementId;
  met: boolean;
  /** What the rule asks for, and what the account or event has, as stored values. */
  required: string;
  actual: string;
}

export interface Eligibility {
  eventId: string;
  eligible: boolean;
  requirements: Requirement[];
}

/** Every item is listed, met or not, so the page can say exactly what blocks the account. */
export function decideEligibility(
  rule: EligibilityRule,
  event: Pick<LaunchEvent, 'id' | 'status' | 'issuer'>,
  participant: CampaignParticipant,
  subAccount: boolean,
): Eligibility {
  const tierRank = (t: KycTier) => KYC_TIERS.indexOf(t);
  const restricted = rule.restrictedRegions.length > 0;
  const requirements: Requirement[] = [
    {
      id: 'identity_verification',
      met: tierRank(participant.kycTier) >= tierRank(rule.minKycTier),
      required: rule.minKycTier,
      actual: participant.kycTier,
    },
    {
      id: 'region',
      met: !restricted || (participant.region !== null && !rule.restrictedRegions.includes(participant.region)),
      required: restricted ? `not ${rule.restrictedRegions.join(', ')}` : 'any',
      actual: participant.region ?? 'unknown',
    },
    { id: 'account_active', met: participant.status === 'active', required: 'active', actual: participant.status },
    { id: 'main_account', met: !subAccount, required: 'main', actual: subAccount ? 'sub' : 'main' },
    { id: 'issuer_onboarded', met: event.issuer.state === 'onboarded', required: 'onboarded', actual: event.issuer.state },
    { id: 'event_open', met: event.status === 'open', required: 'open', actual: event.status },
  ];
  return { eventId: event.id, eligible: requirements.every((r) => r.met), requirements };
}

export interface ParticipantSource {
  read(userId: string): Promise<CampaignParticipant | null>;
}

/** No identity configured: every read is unread, so every check refuses `launch.eligibility_unavailable`. */
export function unwiredParticipants(): ParticipantSource {
  return { read: async () => null };
}

/**
 * The svc-campaigns client shape (participants.ts) for svc-token. Every failure (transport, 401, 404, a body that is
 * not the published contract, an answer about another user) is null.
 */
export function createParticipantClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): ParticipantSource {
  const url = baseUrl.replace(/\/$/, '');
  const sign = serviceCallSigner({ service: 'svc-token', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return {
    async read(userId: string): Promise<CampaignParticipant | null> {
      const target = `${url}/internal/campaign-participant/${encodeURIComponent(userId)}`;
      let response: Response;
      try {
        response = await fetch(target, {
          method: 'GET',
          headers: {
            'content-type': 'application/json',
            ...sign('', { method: 'GET', url: new URL(target), contentType: 'application/json' }),
          },
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        return null;
      }
      if (!response.ok) return null;
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return null;
      }
      const parsed = campaignParticipantSchema.safeParse(body);
      if (!parsed.success || parsed.data.userId.toLowerCase() !== userId.toLowerCase()) return null;
      return parsed.data;
    },
  };
}

/** Reads the rule and the account, then decides. The rule refuses first, so a blank rule never costs an identity call. */
export async function checkEligibility(
  env: { TOKEN_LAUNCH_MIN_KYC_TIER?: string; TOKEN_LAUNCH_RESTRICTED_REGIONS?: string },
  participants: ParticipantSource,
  event: Pick<LaunchEvent, 'id' | 'status' | 'issuer'>,
  principal: { userId: string; subAccount: boolean },
): Promise<Eligibility> {
  const rule = parseEligibilityRule(env);
  const participant = await participants.read(principal.userId);
  if (!participant) throw new LaunchError('The account could not be read from identity', 'launch.eligibility_unavailable');
  return decideEligibility(rule, event, participant, principal.subAccount);
}
