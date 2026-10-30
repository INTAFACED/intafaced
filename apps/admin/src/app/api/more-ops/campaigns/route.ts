import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import {
  checkCreate,
  checkMove,
  checkRuleSave,
  checkRuleTest,
  checkUpdate,
  checkVoucherIssue,
  checkVoucherList,
  createCampaign,
  issueVoucher,
  listVouchers,
  listRules,
  saveRule,
  testRule,
  loadCampaignDetail,
  loadCampaignsDesk,
  moveCampaign,
  updateCampaign,
} from '@/lib/campaigns-ops/builder-server';

/**
 * The campaigns desk and builder (J-campaigns-16).
 *
 *   GET                         every campaign the operator list holds and the calendar
 *   GET ?id=<campaign id>       one campaign with the activation gate's answer for its stored revision
 *   POST { op: 'create', definition }                    a draft; the name is its business key
 *   POST { op: 'update', id, revision, definition }      a draft's whole definition, over the revision read
 *   POST { op: 'move', id, action, revision }            submit, approve (a second founder), activate, pause, resume, end, archive
 *   GET ?rules=library                                   every rule name's latest revision in the library
 *   POST { op: 'rule-test', tree, fixture }              a rule tried on a TEST fixture account; stores nothing
 *   POST { op: 'rule-save', name, tree }                 the name's next revision in the rule library
 *   GET ?vouchers=<campaign id>                          a voucher campaign's vouchers, each with the revision it keeps
 *   POST { op: 'voucher-issue', campaignId, code }       a voucher under the live revision; the code is its key
 *
 * Founder-only. svc-campaigns records the founder from their own token and refuses an approval by whoever wrote or asked.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

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
  const disabled = moduleDisabledResponse('more-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const params = new URL(request.url).searchParams;
  if (params.get('rules') === 'library') {
    const { status, reply } = await listRules(session);
    return Response.json(reply, { status, headers: NO_STORE });
  }
  const vouchers = params.get('vouchers');
  if (vouchers !== null) {
    const checked = checkVoucherList({ campaignId: vouchers });
    if (!checked.ok) return incomplete(checked.why);
    const { status, reply } = await listVouchers(session, checked.input);
    return Response.json(reply, { status, headers: NO_STORE });
  }
  const id = params.get('id');
  if (id !== null) {
    if (!ID.test(id)) return incomplete('Which campaign?');
    return Response.json(await loadCampaignDetail(session, id), { headers: NO_STORE });
  }
  return Response.json(await loadCampaignsDesk(session), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('more-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    const send = ({ status, reply }: { status: number; reply: unknown }) => Response.json(reply, { status, headers: NO_STORE });
    switch (body.op) {
      case 'create': {
        const checked = checkCreate(body.definition);
        if (!checked.ok) return incomplete(checked.why);
        return send(await createCampaign(session, checked.input));
      }
      case 'update': {
        const checked = checkUpdate({ id: body.id, revision: body.revision, definition: body.definition });
        if (!checked.ok) return incomplete(checked.why);
        return send(await updateCampaign(session, checked.input));
      }
      case 'move': {
        const checked = checkMove({ id: body.id, action: body.action, revision: body.revision });
        if (!checked.ok) return incomplete(checked.why);
        return send(await moveCampaign(session, checked.input));
      }
      case 'rule-test': {
        const checked = checkRuleTest({ tree: body.tree, fixture: body.fixture });
        if (!checked.ok) return incomplete(checked.why);
        return send(await testRule(session, checked.input));
      }
      case 'rule-save': {
        const checked = checkRuleSave({ name: body.name, tree: body.tree });
        if (!checked.ok) return incomplete(checked.why);
        return send(await saveRule(session, checked.input));
      }
      case 'voucher-issue': {
        const checked = checkVoucherIssue({ campaignId: body.campaignId, code: body.code });
        if (!checked.ok) return incomplete(checked.why);
        return send(await issueVoucher(session, checked.input));
      }
      default:
        return incomplete('Unknown action.');
    }
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
