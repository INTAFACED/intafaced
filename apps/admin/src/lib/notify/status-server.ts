import 'server-only';
import { statusPageSchema, type StatusPageConfigureInput, type StatusReadingInput } from '@intafaced/contracts';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { readDefinition, type StatusDeskReply, type StatusDeskView } from './status-model';

/**
 * svc-notify's status page as the signed-in founder: the definition (`statusPage.definition`, admin:write), the page a
 * visitor reads (`statusPage.read`), a definition change (`statusPage.configure`) and a reading entered by hand
 * (`statusPage.record`). The service records the founder from their own token and keys a change by the revision it read,
 * so a lost reply replays instead of applying twice.
 */

const LABELS: PartLabels = {
  service: 'svc-notify',
  forbiddenMessage:
    'svc-notify did not accept your founder session. The status page desk needs the operator write permission (admin:write) on a signed-in session with a second factor.',
};

export async function loadStatusDesk(ctx: FounderCallContext): Promise<StatusDeskView> {
  const [definition, page] = await Promise.all([
    founderCall(ctx, 'notify', 'statusPage.definition', 'GET', undefined, readDefinition),
    founderCall(ctx, 'notify', 'statusPage.read', 'GET', undefined, parseWith(statusPageSchema)),
  ]);
  return { definition: partFrom(definition, (d) => d, LABELS), page: partFrom(page, (d) => d, LABELS), asOf: new Date().toISOString() };
}

function reply<T>(result: FounderCallResult<T>, what: 'configured' | 'recorded'): { status: number; reply: StatusDeskReply } {
  const refused = (code: string | null, status: number, uncertain = false) => {
    const view = explainRefusal(code, status, uncertain);
    return { status: status >= 400 && status < 600 ? status : 502, reply: { ok: false as const, ...view } };
  };
  switch (result.kind) {
    case 'ok':
      return { status: 200, reply: { ok: true, what } };
    case 'refused':
      return refused(result.refusal.code, result.refusal.status);
    case 'forbidden':
      return refused('operator.denied', 403);
    case 'not_built':
      return {
        status: 501,
        reply: {
          ok: false,
          title: 'The status page is not switched on',
          body: 'svc-notify has no status page on this deployment.',
          next: 'Nothing was changed.',
          changed: 'no',
        },
      };
    case 'unavailable':
      return refused(null, 503, result.uncertain);
    case 'invalid':
      // A 200 in a shape this console cannot read: the change may have happened.
      return refused(null, 502, true);
  }
}

export async function configureStatusPage(ctx: FounderCallContext, input: StatusPageConfigureInput) {
  return reply(await founderCall(ctx, 'notify', 'statusPage.configure', 'POST', input, readDefinition), 'configured');
}

export async function recordStatusReading(ctx: FounderCallContext, input: StatusReadingInput) {
  const parse = (raw: unknown) => (raw && typeof raw === 'object' && 'componentId' in raw ? raw : null);
  return reply(await founderCall(ctx, 'notify', 'statusPage.record', 'POST', input, parse), 'recorded');
}
