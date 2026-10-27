/**
 * Who a notice is for (P-trade-orders-23 merchant notices). `everyone` is the public board: the signed-out reads, the
 * announcement slot and the status subscribers. Any other audience is an announcement only its members read, signed in,
 * and it never reaches a public read or a subscriber mail.
 *
 * Membership is asked of the service that owns it, at read time: `p2p-merchants` is an account svc-p2p vouches for as an
 * active merchant (`merchant: true` on its internal reputation door). A frozen, withdrawn or rejected merchant reads
 * `false` there, so the notice is gone for them the moment the programme changes their standing.
 */
import { z } from 'zod';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

export const NOTICE_AUDIENCES = ['everyone', 'p2p-merchants'] as const;
export type NoticeAudience = (typeof NOTICE_AUDIENCES)[number];
/** The audiences a member reads signed in: every one but the public board. */
export type MemberAudience = Exclude<NoticeAudience, 'everyone'>;

export function isNoticeAudience(value: string): value is NoticeAudience {
  return (NOTICE_AUDIENCES as readonly string[]).includes(value);
}

/** Which member audiences one account is in. Throws when the owning service cannot say: never a guessed "no". */
export interface AudienceMembership {
  audiencesOf(userId: string): Promise<ReadonlySet<MemberAudience>>;
}

export class AudienceUnavailableError extends Error {
  readonly code = 'notify.notice_audience_unavailable';
  constructor(why: string) {
    super(`Notice audience membership could not be read: ${why}`);
    this.name = 'AudienceUnavailableError';
  }
}

const reputationBody = z.object({ merchant: z.boolean().nullable() });

/** P2P merchants, read from svc-p2p's internal reputation door. `merchant: null` (no programme wired) is not a member. */
export function createP2pMerchantMembership(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): AudienceMembership {
  const base = baseUrl.replace(/\/+$/, '');
  const sign = serviceCallSigner({ service: 'svc-notify', audience: 'svc-p2p', legacySecret: internalSecret, s2s });
  return {
    async audiencesOf(userId) {
      const target = `${base}/internal/reputation/${encodeURIComponent(userId)}`;
      let response: Response;
      try {
        response = await fetchFn(target, {
          method: 'GET',
          // A redirect would carry the signed request somewhere else.
          redirect: 'error',
          headers: sign('', { method: 'GET', url: new URL(target), contentType: '' }),
          signal: AbortSignal.timeout(3_000),
        });
      } catch {
        throw new AudienceUnavailableError('p2p did not answer');
      }
      if (!response.ok) throw new AudienceUnavailableError(`p2p refused (${response.status})`);
      const body = reputationBody.safeParse(await response.json().catch(() => null));
      if (!body.success) throw new AudienceUnavailableError('p2p answered out of shape');
      return new Set<MemberAudience>(body.data.merchant === true ? ['p2p-merchants'] : []);
    },
  };
}

/** Wired when P2P_URL and the shared service secret are set; otherwise null, and member reads refuse. */
export function audienceMembershipFromEnv(
  env: { P2P_URL?: string | undefined },
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): AudienceMembership | null {
  const url = env.P2P_URL?.trim() ?? '';
  const secret = process.env.INTERNAL_SERVICE_SECRET?.trim() ?? '';
  if (!url || secret.length < 32) return null;
  return createP2pMerchantMembership(url, secret, s2s);
}
