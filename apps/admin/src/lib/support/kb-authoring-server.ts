import 'server-only';
import {
  SUPPORT_DESK_KB_APPROVE,
  SUPPORT_DESK_KB_DRAFT,
  SUPPORT_DESK_KB_HISTORY,
  SUPPORT_DESK_KB_PUBLISH_DRAFT,
  SUPPORT_DESK_KB_SAVE_DRAFT,
  SUPPORT_DESK_KB_SAVE_TEMPLATE,
  SUPPORT_DESK_KB_SEND_BACK,
  SUPPORT_DESK_KB_SUBMIT_FOR_REVIEW,
  SUPPORT_DESK_KB_TEMPLATES,
  SUPPORT_KB_LIBRARY,
} from '@intafaced/contracts/support-desk-settings-procedures';
import { founderRecordCall, type FounderCallContext, type FounderCallResult } from '@/lib/desk';
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
    founderRecordCall(ctx, SUPPORT_KB_LIBRARY, undefined),
    founderRecordCall(ctx, SUPPORT_DESK_KB_TEMPLATES, undefined),
  ]);
  const history = id ? await founderRecordCall(ctx, SUPPORT_DESK_KB_HISTORY, { id }) : null;
  let draft: KbAuthoringView['draft'] = null;
  if (history?.kind === 'ok' && id) {
    const newest = history.data.versions.at(-1);
    if (newest?.draft) {
      draft = part(await founderRecordCall(ctx, SUPPORT_DESK_KB_DRAFT, { id, revision: newest.revision }));
    }
  }
  return { asOf: now.toISOString(), library: part(library), templates: part(templates), history: history ? part(history) : null, draft };
}

export function runKbAuthoring(ctx: FounderCallContext, request: KbAuthoringRequest): Promise<FounderCallResult<unknown>> {
  switch (request.action) {
    case 'draft_save': {
      const { action: _a, ...input } = request;
      return founderRecordCall(ctx, SUPPORT_DESK_KB_SAVE_DRAFT, { ...input, tags: [...input.tags] });
    }
    case 'submit':
      return founderRecordCall(ctx, SUPPORT_DESK_KB_SUBMIT_FOR_REVIEW, { id: request.id, revision: request.revision });
    case 'approve':
      return founderRecordCall(ctx, SUPPORT_DESK_KB_APPROVE, { id: request.id, revision: request.revision });
    case 'send_back':
      return founderRecordCall(ctx, SUPPORT_DESK_KB_SEND_BACK, { id: request.id, revision: request.revision, reason: request.reason });
    case 'publish':
      return founderRecordCall(ctx, SUPPORT_DESK_KB_PUBLISH_DRAFT, { id: request.id, revision: request.revision });
    case 'template_save': {
      const { action: _a, ...input } = request;
      return founderRecordCall(ctx, SUPPORT_DESK_KB_SAVE_TEMPLATE, input);
    }
  }
}
