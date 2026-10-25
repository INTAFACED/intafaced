/**
 * The own-name rule's door (P-ads-merchant-18, J-p2p-04 #2): `POST /internal/holder-name-check`.
 *
 * svc-p2p sends the holder name a person typed for a payout destination and the account it is for; identity answers
 * only `holderNameCheckSchema` (match, mismatch, unverified, unconfigured or inactive). The verified legal name never leaves
 * identity, and the typed name is neither stored nor logged here. Service credentials, body-bound; any other service is
 * refused, since no other service stores a destination under this rule. Unknown account: 404.
 */
import type { FastifyInstance } from 'fastify';
import {
  IDENTITY_HOLDER_NAME_CHECK_PATH,
  holderNameCheckInputSchema,
  type HolderNameCheck,
  type HolderNameCheckInput,
} from '@intafaced/contracts';
import { FounderControlError } from './controls/founder-controls.js';
import { serviceOfRequest, type IdentityS2s } from './s2s-door.js';

export interface HolderNameChecker {
  holderNameCheck(input: HolderNameCheckInput): Promise<HolderNameCheck | null>;
}

export function registerHolderNameCheck(
  app: FastifyInstance,
  deps: { readonly internalSecret: string; readonly s2s?: IdentityS2s; readonly details: HolderNameChecker },
): void {
  app.post(IDENTITY_HOLDER_NAME_CHECK_PATH, async (req, reply) => {
    const { service } = serviceOfRequest(req, deps.internalSecret, 'require', deps.s2s);
    if (service === null) {
      return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
    }
    if (service !== 'svc-p2p') {
      return reply.code(403).send({ error: 'the holder-name check is for svc-p2p', code: 'identity.forbidden' });
    }
    const parsed = holderNameCheckInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'send a userId and a name', code: 'identity.holder_name_query' });
    }
    let answer: HolderNameCheck | null;
    try {
      answer = await deps.details.holderNameCheck(parsed.data);
    } catch (error) {
      // A record the key cannot open, or the database not answering: typed, and never read as an answer about the name.
      const code = error instanceof FounderControlError ? error.code : 'identity.holder_name_unavailable';
      return reply.code(503).send({ error: 'the verified name could not be read', code });
    }
    if (!answer) return reply.code(404).send({ error: 'account not found', code: 'identity.account_not_found' });
    return answer;
  });
}
