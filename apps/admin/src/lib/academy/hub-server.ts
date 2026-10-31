import 'server-only';
import {
  academyClearFeaturedInputSchema,
  academyCreateTopicInputSchema,
  academyFeaturedChoiceSchema,
  academyFeaturedSlotSchema,
  academySetFeaturedItemInputSchema,
  academyTopicListSchema,
  academyTopicSchema,
} from '@intafaced/contracts/academy-courses';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import type { HubDeskReply, HubView } from './hub-model';

/**
 * The Learn hub desk as the signed-in founder. svc-academy records the founder from their own token. No money moves and
 * no learner record is written.
 */

const ACADEMY: PartLabels = {
  service: 'svc-academy',
  forbiddenMessage:
    'svc-academy did not accept your founder session. The Learn hub desk needs the Academy operator permission (admin:read, admin:write).',
  refusedMessage: (code) => (code ? explainRefusal(code, 409).body : null),
};

const readSlot = parseWith(academyFeaturedSlotSchema);
const readChoice = parseWith(academyFeaturedChoiceSchema);
const readTopics = parseWith(academyTopicListSchema);
const readTopic = parseWith(academyTopicSchema);

export async function loadHub(ctx: FounderCallContext): Promise<HubView> {
  const [slot, topics] = await Promise.all([
    founderCall(ctx, 'academy', 'admin.featuredSlot', 'GET', undefined, readSlot),
    founderCall(ctx, 'academy', 'admin.topics', 'GET', undefined, readTopics),
  ]);
  return { slot: partFrom(slot, (d) => d, ACADEMY), topics: partFrom(topics, (d) => d, ACADEMY), asOf: new Date().toISOString() };
}

function reply(result: FounderCallResult<unknown>, what: string): { status: number; reply: HubDeskReply } {
  const refused = (code: string | null, status: number, uncertain = false) => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false as const, ...explainRefusal(code, status, uncertain) },
  });
  switch (result.kind) {
    case 'ok':
      return result.data ? { status: 200, reply: { ok: true, what } } : refused(null, 502, true);
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

export type HubOp = 'clear' | 'item' | 'topic';
export const isHubOp = (op: unknown): op is HubOp => op === 'clear' || op === 'item' || op === 'topic';

export async function changeHub(
  ctx: FounderCallContext,
  op: HubOp,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: HubDeskReply } | { why: string }> {
  const { op: _op, ...input } = body;
  if (op === 'clear') {
    const parsed = academyClearFeaturedInputSchema.safeParse(input);
    if (!parsed.success) return { why: 'Why clear the featured slot? Say why in up to 500 characters.' };
    return reply(await founderCall(ctx, 'academy', 'admin.clearFeatured', 'POST', parsed.data, readSlot), 'nothing is featured');
  }
  if (op === 'item') {
    const parsed = academySetFeaturedItemInputSchema.safeParse(input);
    if (!parsed.success)
      return { why: 'Feature which article, and why? Give its address (up to 120 characters) and a reason (up to 500).' };
    return reply(await founderCall(ctx, 'academy', 'admin.setFeatured', 'POST', parsed.data, readChoice), 'featured on the Learn hub');
  }
  const parsed = academyCreateTopicInputSchema.safeParse(input);
  if (!parsed.success)
    return { why: 'A topic needs a name of up to 60 characters and an address of 3 to 64 lower-case letters, digits and single hyphens.' };
  return reply(await founderCall(ctx, 'academy', 'admin.createTopic', 'POST', parsed.data, readTopic), 'topic added');
}
