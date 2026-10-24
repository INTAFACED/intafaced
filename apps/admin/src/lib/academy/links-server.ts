import 'server-only';
import {
  academyCourseLearnerViewSchema,
  academyCreatedPrivateLinkSchema,
  academyCreatePrivateLinkInputSchema,
  academyPrivateLinkListSchema,
  academyPrivateLinkSchema,
  academyRevokePrivateLinkInputSchema,
} from '@intafaced/contracts/academy-courses';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import type { LinksDeskReply, LinksView, PreviewView } from './links-model';

/**
 * Preview as new learner and private links as the signed-in founder. The preview is svc-academy's own learner view of
 * the stored course and writes nothing; a link's key is shown once, when it is made. No money moves.
 */

const ACADEMY: PartLabels = {
  service: 'svc-academy',
  forbiddenMessage:
    'svc-academy did not accept your founder session. Previews and private links need the Academy operator permission (admin:read, admin:write).',
  refusedMessage: (code) => (code ? explainRefusal(code, 409).body : null),
};

const readView = parseWith(academyCourseLearnerViewSchema);
const readLinks = parseWith(academyPrivateLinkListSchema);
const readCreated = parseWith(academyCreatedPrivateLinkSchema);
const readLink = parseWith(academyPrivateLinkSchema);

export async function loadPreview(ctx: FounderCallContext, courseId: string): Promise<PreviewView> {
  const view = await founderCall(ctx, 'academy', 'admin.previewCourse', 'GET', { courseId }, readView);
  return { view: partFrom(view, (d) => d, ACADEMY), asOf: new Date().toISOString() };
}

export async function loadLinks(ctx: FounderCallContext, courseId: string): Promise<LinksView> {
  const links = await founderCall(ctx, 'academy', 'admin.privateLinks', 'GET', { courseId }, readLinks);
  return { links: partFrom(links, (d) => d, ACADEMY), asOf: new Date().toISOString() };
}

function reply<T>(
  result: FounderCallResult<T | null>,
  what: string,
  path: (data: T) => string | null,
): { status: number; reply: LinksDeskReply } {
  const refused = (code: string | null, status: number, uncertain = false) => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false as const, ...explainRefusal(code, status, uncertain) },
  });
  switch (result.kind) {
    case 'ok':
      return result.data ? { status: 200, reply: { ok: true, what, path: path(result.data) } } : refused(null, 502, true);
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

export type LinksOp = 'create' | 'revoke';
export const isLinksOp = (op: unknown): op is LinksOp => op === 'create' || op === 'revoke';

export async function changeLinks(
  ctx: FounderCallContext,
  op: LinksOp,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: LinksDeskReply } | { why: string }> {
  const { op: _op, ...input } = body;
  if (op === 'create') {
    const parsed = academyCreatePrivateLinkInputSchema.safeParse(input);
    if (!parsed.success) return { why: 'Which course, and why make a link? Say why in up to 500 characters.' };
    return reply(
      await founderCall(ctx, 'academy', 'admin.createPrivateLink', 'POST', parsed.data, readCreated),
      'private link made',
      (d) => d.path,
    );
  }
  const parsed = academyRevokePrivateLinkInputSchema.safeParse(input);
  if (!parsed.success) return { why: 'Which link, and why revoke it? Say why in up to 500 characters.' };
  return reply(await founderCall(ctx, 'academy', 'admin.revokePrivateLink', 'POST', parsed.data, readLink), 'link revoked', () => null);
}
