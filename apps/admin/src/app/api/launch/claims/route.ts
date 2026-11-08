import { CLAIM_EVIDENCE_MAX, CLAIM_TEXT_MAX, CLAIM_TOPIC_MAX } from '@intafaced/contracts/ops-marketing-claims';
import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { loadClaims, publishClaim, recordClaim } from '@/lib/marketing-claims/server';

/**
 * The marketing claims evidence register on the launch lens (RC-more-catalogue-24, J-more-catalogue-14 #7).
 *
 *   GET                                         every claim with its evidence or its block
 *   POST { op: 'record', topic, text, evidence }   record a claim (evidence may be blank: it then shows blocked)
 *   POST { op: 'publish', id }                  publish a claim as a second founder
 *
 * Founder-only, under the launch module. svc-ops records the founder from their own token and refuses a publish by the
 * claim's author (`ops.claim_self_approval`) or one with no evidence (`ops.claim_evidence_missing`). No money moves.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

const incomplete = (body: string) =>
  Response.json(
    {
      ok: false,
      title: 'That request is not complete',
      body,
      next: 'Nothing was changed. Correct it and try again.',
      code: null,
      changed: 'no',
    },
    { status: 400, headers: NO_STORE },
  );

export async function GET(request: Request) {
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json({ view: await loadClaims(session), me: session.session.userId }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    const send = ({ status, reply }: { status: number; reply: unknown }) => Response.json(reply, { status, headers: NO_STORE });
    switch (body.op) {
      case 'record': {
        const topic = str(body.topic).trim();
        if (topic === '' || topic.length > CLAIM_TOPIC_MAX)
          return incomplete(`Name what the claim is about, in 1 to ${CLAIM_TOPIC_MAX} characters.`);
        const text = str(body.text).trim();
        if (text === '' || text.length > CLAIM_TEXT_MAX) return incomplete(`Write the claim in 1 to ${CLAIM_TEXT_MAX} characters.`);
        const evidence = str(body.evidence).trim();
        if (evidence.length > CLAIM_EVIDENCE_MAX) return incomplete(`Keep the evidence reference to ${CLAIM_EVIDENCE_MAX} characters.`);
        return send(await recordClaim(session, { topic, text, evidence: evidence === '' ? null : evidence }));
      }
      case 'publish':
        if (!UUID.test(str(body.id))) return incomplete('Which claim?');
        return send(await publishClaim(session, str(body.id)));
      default:
        return incomplete('Unknown action.');
    }
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
