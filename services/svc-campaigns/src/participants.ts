import { campaignParticipantSchema, serviceCallSigner, type CampaignParticipant } from '@intafaced/contracts';

/**
 * Who an account is, read per check from svc-identity's `GET /internal/campaign-participant/:userId` (service
 * credentials), for a campaign's participation rules (CM-eligibility-rules-01). svc-campaigns keeps no copy.
 *
 * Every failure (transport, 401, 404, a body that is not the published contract, an answer about another user) is
 * null, which the caller treats as unread: a join refuses `campaigns.participant_unread`, never reads it as eligible.
 */
export interface ParticipantSource {
  read(userId: string): Promise<CampaignParticipant | null>;
}

export function createParticipantClient(baseUrl: string, internalSecret: string): ParticipantSource {
  const url = baseUrl.replace(/\/$/, '');
  const sign = serviceCallSigner({ service: 'svc-campaigns', audience: 'svc-identity', legacySecret: internalSecret });
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
      if (!parsed.success || parsed.data.userId !== userId) return null;
      return parsed.data;
    },
  };
}
