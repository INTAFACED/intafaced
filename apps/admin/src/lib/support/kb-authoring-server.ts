import 'server-only';
import {
  supportKbArticleSchema,
  supportKbDraftSchema,
  supportKbHistorySchema,
  supportKbLibrarySchema,
  supportKbTemplateSchema,
} from '@intafaced/contracts';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { explainSupportFailure } from './refusal';
import type { KbAuthoringRequest, KbAuthoringView, KbPart } from './kb-authoring';

function part<T>(result: FounderCallResult<T>): KbPart<T> {
  if (result.kind === 'ok') return { kind: 'ok', data: result.data };
  const refusal = explainSupportFailure(result);
  return { kind: 'failed', why: `${refusal.title}. ${refusal.body}` };
}

/** The sections, the templates and, for one article, its history and its newest draft, each as svc-support answered. */
export async function loadKbAuthoring(ctx: FounderCallContext, id: string | null, now: Date = new Date()): Promise<KbAuthoringView> {
  const [library, templates] = await Promise.all([
    founderCall(ctx, 'support', 'kbLibrary', 'GET', undefined, parseWith(supportKbLibrarySchema)),
    founderCall(ctx, 'support', 'kbTemplates', 'GET', undefined, parseWith(supportKbTemplateSchema.array())),
  ]);
  const history = id ? await founderCall(ctx, 'support', 'kbHistory', 'GET', { id }, parseWith(supportKbHistorySchema)) : null;
  let draft: KbAuthoringView['draft'] = null;
  if (history?.kind === 'ok' && id) {
    const newest = history.data.versions.at(-1);
    if (newest?.draft) {
      draft = part(await founderCall(ctx, 'support', 'kbDraft', 'GET', { id, revision: newest.revision }, parseWith(supportKbDraftSchema)));
    }
  }
  return { asOf: now.toISOString(), library: part(library), templates: part(templates), history: history ? part(history) : null, draft };
}

export function runKbAuthoring(ctx: FounderCallContext, request: KbAuthoringRequest): Promise<FounderCallResult<unknown>> {
  switch (request.action) {
    case 'draft_save': {
      const { action: _a, ...input } = request;
      return founderCall(ctx, 'support', 'kbSaveDraft', 'POST', input, parseWith(supportKbDraftSchema));
    }
    case 'submit':
      return founderCall(
        ctx,
        'support',
        'kbSubmitForReview',
        'POST',
        { id: request.id, revision: request.revision },
        parseWith(supportKbDraftSchema),
      );
    case 'approve':
      return founderCall(
        ctx,
        'support',
        'kbApprove',
        'POST',
        { id: request.id, revision: request.revision },
        parseWith(supportKbDraftSchema),
      );
    case 'send_back':
      return founderCall(
        ctx,
        'support',
        'kbSendBack',
        'POST',
        { id: request.id, revision: request.revision, reason: request.reason },
        parseWith(supportKbDraftSchema),
      );
    case 'publish':
      return founderCall(
        ctx,
        'support',
        'kbPublishDraft',
        'POST',
        { id: request.id, revision: request.revision },
        parseWith(supportKbArticleSchema),
      );
    case 'template_save': {
      const { action: _a, ...input } = request;
      return founderCall(ctx, 'support', 'kbSaveTemplate', 'POST', input, parseWith(supportKbTemplateSchema));
    }
  }
}
