import 'server-only';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import {
  RECIPIENTS_PAGE,
  readRecipients,
  readReleased,
  releaseKey,
  type RecipientChannel,
  type RecipientState,
  type RecipientsView,
  type ReleaseReply,
} from './recipients-model';

/**
 * svc-notify's recipient health read (`notify.operatorRecipients`, admin:read) and the release of a quarantined address
 * (`notify.operatorReleaseRecipient`, admin:write), both as the signed-in founder. The service records who released an
 * address from the founder's own token; this console never names an actor.
 */

const LABELS: PartLabels = {
  service: 'svc-notify',
  forbiddenMessage:
    'svc-notify did not accept your founder session. Recipient health needs the operator read permission (admin:read), and founder sign-in does not carry it.',
};

export async function loadRecipients(ctx: FounderCallContext, state: RecipientState): Promise<RecipientsView> {
  const result = await founderCall(ctx, 'notify', 'notify.operatorRecipients', 'GET', { state, limit: RECIPIENTS_PAGE }, (raw) =>
    readRecipients(raw, state, RECIPIENTS_PAGE),
  );
  return partFrom(result, (d) => d, LABELS);
}

export interface ReleaseInput {
  readonly userId: string;
  readonly channel: RecipientChannel;
  readonly quarantinedAt: string;
  readonly reason: string;
}

export async function releaseRecipient(ctx: FounderCallContext, input: ReleaseInput): Promise<{ status: number; reply: ReleaseReply }> {
  const result = await founderCall(
    ctx,
    'notify',
    'notify.operatorReleaseRecipient',
    'POST',
    {
      userId: input.userId,
      channel: input.channel,
      reason: input.reason,
      reasonId: releaseKey({ userId: input.userId, channel: input.channel, quarantinedAt: input.quarantinedAt }),
    },
    readReleased,
  );
  const refused = (code: string | null, status: number, uncertain = false) => {
    const view = explainRefusal(code, status, uncertain);
    return { status: status >= 400 && status < 600 ? status : 502, reply: { ok: false as const, ...view } };
  };
  switch (result.kind) {
    case 'ok':
      return { status: 200, reply: { ok: true, replayed: result.data.replayed } };
    case 'refused':
      return refused(result.refusal.code, result.refusal.status);
    case 'forbidden':
      return refused('operator.denied', 403);
    case 'not_built':
      return {
        status: 501,
        reply: {
          ok: false,
          title: 'Release is not switched on',
          body: 'svc-notify has not switched recipient release on for this deployment.',
          next: 'Nothing was changed.',
          changed: 'no',
        },
      };
    case 'unavailable':
      return refused(null, 503, result.uncertain);
    case 'invalid':
      // The service answered 200 in a shape this console cannot read: the release may have happened.
      return refused(null, 502, true);
  }
}
