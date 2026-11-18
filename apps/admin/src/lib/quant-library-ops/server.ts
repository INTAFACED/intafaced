import 'server-only';
import {
  quantDisputeOpenInputSchema,
  quantDisputeResolveInputSchema,
  quantModerationEntrySchema,
  quantModerationInputSchema,
  quantModerationQueueSchema,
} from '@intafaced/contracts';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import type { LibraryDeskOp, LibraryDeskReply, LibraryDeskView } from './model';

/**
 * The strategy library desk as the signed-in founder. svc-quant holds the queue and records every action (`ops.library.*`:
 * `admin:read` to read, `admin:write` to act, module quant), naming the founder from their own token. Nothing here moves
 * money and nothing here reads a listing's source.
 */

const QUANT: PartLabels = {
  service: 'svc-quant',
  forbiddenMessage:
    'svc-quant did not accept your founder session for the library queue (it needs admin:read with module quant to read and admin:write to act).',
  refusedMessage: (code) =>
    code === 'quant.library_queue_limit_unset'
      ? 'The owner has not set the review queue page size (library.queuePageSize), so svc-quant lists nothing rather than guess one.'
      : null,
};

const readQueue = parseWith(quantModerationQueueSchema);
const readEntry = parseWith(quantModerationEntrySchema);

export async function loadLibraryDesk(ctx: FounderCallContext, cursor: string | null = null): Promise<LibraryDeskView> {
  const queue = await founderCall(ctx, 'quant', 'ops.library.queue', 'GET', cursor ? { cursor } : undefined, readQueue);
  return { asOf: new Date().toISOString(), queue: partFrom(queue, (d) => d, QUANT) };
}

const CODE_SUFFIX = /\s*\[[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+\]\s*$/;

function reply(result: FounderCallResult<unknown>, what: string): { status: number; reply: LibraryDeskReply } {
  const refused = (code: string | null, status: number, message: string | null, uncertain = false) => {
    const view = explainRefusal(code, status, uncertain);
    // svc-quant's own sentence names what was missing; a console paraphrase would lose it.
    const body = message?.replace(CODE_SUFFIX, '').trim();
    return { status: status >= 400 && status < 600 ? status : 502, reply: { ok: false as const, ...view, body: body || view.body } };
  };
  switch (result.kind) {
    case 'ok': {
      const entry = readEntry(result.data);
      return entry ? { status: 200, reply: { ok: true, what, entry } } : refused(null, 502, null, true);
    }
    case 'refused':
      return refused(result.refusal.code, result.refusal.status, result.refusal.message);
    case 'forbidden':
      return refused(result.refusal.code ?? 'operator.denied', 403, result.refusal.code ? result.refusal.message : null);
    case 'not_built':
      return refused('not_built', 501, null);
    case 'unavailable':
      return refused(null, 503, null, result.uncertain);
    case 'invalid':
      return refused(null, 502, null, true);
  }
}

const OPS = {
  hide: { procedure: 'ops.library.hide', schema: quantModerationInputSchema, what: 'the listing is hidden from the library' },
  unhide: { procedure: 'ops.library.unhide', schema: quantModerationInputSchema, what: 'the listing is back in the library' },
  remove: { procedure: 'ops.library.remove', schema: quantModerationInputSchema, what: 'the listing is removed from the library' },
  'dispute-open': { procedure: 'ops.library.dispute.open', schema: quantDisputeOpenInputSchema, what: 'the dispute is opened' },
  'dispute-resolve': { procedure: 'ops.library.dispute.resolve', schema: quantDisputeResolveInputSchema, what: 'the dispute is resolved' },
} as const;

/** One listed action. The input is checked against the contract here; svc-quant checks it again and decides. */
export async function actOnLibrary(
  ctx: FounderCallContext,
  op: LibraryDeskOp,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: LibraryDeskReply } | { why: string }> {
  const { op: _op, ...input } = body;
  const spec = OPS[op];
  const parsed = spec.schema.safeParse(input);
  if (!parsed.success) return { why: 'Which listing or dispute, with a reason of at most 500 characters?' };
  return reply(await founderCall(ctx, 'quant', spec.procedure, 'POST', parsed.data, (raw) => raw), spec.what);
}
