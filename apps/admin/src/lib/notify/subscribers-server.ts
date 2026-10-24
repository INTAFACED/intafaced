import 'server-only';
import { founderCall, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { readDefinition } from './status-model';
import {
  readChannels,
  readEventDeliveries,
  readImportResult,
  readPublishedNotices,
  readSubscribers,
  type SubscriberDeskReply,
  type SubscriberDeskView,
  type SubscriberState,
} from './subscribers-model';

/**
 * The subscriber desk as the signed-in founder, all on svc-notify (`statusPage.subscriptions.*`, admin:write): the
 * channels, the subscribers, the delivery rows of one published notice, the notices to pick from (`notify.notices`) and
 * the two safeguards on the status page definition. Changes: a resend, an import, and the safeguards.
 */

const LABELS: PartLabels = {
  service: 'svc-notify',
  forbiddenMessage:
    'svc-notify did not accept your founder session. The subscriber desk needs the operator write permission (admin:write) on a signed-in session with a second factor.',
};
const LIST_LIMIT = 200;
const NOTICES_LIMIT = 50;

export async function loadSubscriberDesk(
  ctx: FounderCallContext,
  { state, noticeId }: { state: SubscriberState | null; noticeId: string | null },
): Promise<SubscriberDeskView> {
  const [channels, subscribers, notices, definition, deliveries] = await Promise.all([
    founderCall(ctx, 'notify', 'statusPage.subscriptions.channels', 'GET', undefined, readChannels),
    founderCall(ctx, 'notify', 'statusPage.subscriptions.list', 'GET', { state, limit: LIST_LIMIT }, readSubscribers),
    founderCall(ctx, 'notify', 'notify.notices', 'GET', { limit: NOTICES_LIMIT }, readPublishedNotices),
    founderCall(ctx, 'notify', 'statusPage.definition', 'GET', undefined, readDefinition),
    noticeId ? founderCall(ctx, 'notify', 'statusPage.subscriptions.deliveries', 'GET', { noticeId }, readEventDeliveries) : null,
  ]);
  return {
    channels: partFrom(channels, (d) => d, LABELS),
    subscribers: partFrom(subscribers, (d) => d, LABELS),
    state,
    notices: partFrom(notices, (d) => d.filter((n) => n.kind !== 'changelog'), LABELS),
    noticeId,
    deliveries: deliveries ? partFrom(deliveries, (d) => d, LABELS) : null,
    safeguards: partFrom(
      definition,
      (d) => ({ challengeBits: d.challengeBits, subscribeRatePerHour: d.subscribeRatePerHour, revision: d.revision }),
      LABELS,
    ),
    asOf: new Date().toISOString(),
  };
}

function reply<T>(result: FounderCallResult<T>, what: string, extra: (data: T) => object = () => ({})) {
  const refused = (code: string | null, status: number, uncertain = false) => {
    const view = explainRefusal(code, status, uncertain);
    return { status: status >= 400 && status < 600 ? status : 502, reply: { ok: false as const, ...view } satisfies SubscriberDeskReply };
  };
  switch (result.kind) {
    case 'ok':
      return { status: 200, reply: { ok: true as const, what, ...extra(result.data) } satisfies SubscriberDeskReply };
    case 'refused':
      return refused(result.refusal.code, result.refusal.status);
    case 'forbidden':
      return refused(result.refusal.code ?? 'operator.denied', 403);
    case 'not_built':
      return refused('not_built', 501);
    case 'unavailable':
      return refused(null, 503, result.uncertain);
    case 'invalid':
      return refused(null, 502, true);
  }
}

/** Tries the notice's pending and failed rows once more. Rows are keyed (notice, subscriber, channel), so none is doubled. */
export async function resendNotice(ctx: FounderCallContext, noticeId: string) {
  return reply(
    await founderCall(ctx, 'notify', 'statusPage.subscriptions.resend', 'POST', { noticeId }, readEventDeliveries),
    'sent again',
  );
}

export async function importSubscribers(ctx: FounderCallContext, source: string, emails: readonly string[]) {
  return reply(
    await founderCall(ctx, 'notify', 'statusPage.subscriptions.import', 'POST', { source, emails }, readImportResult),
    'imported',
    (imported) => ({ imported }),
  );
}

/** The two subscribe safeguards, from the revision the founder read, with a reason. Blank stays blank and refuses subscribing. */
export async function setSafeguards(
  ctx: FounderCallContext,
  input: { challengeBits: number | null; subscribeRatePerHour: number | null; expectedRevision: number; reason: string },
) {
  return reply(await founderCall(ctx, 'notify', 'statusPage.configure', 'POST', input, readDefinition), 'safeguards saved');
}
