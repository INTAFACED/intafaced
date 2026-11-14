import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import {
  checkAlert,
  checkDeactivate,
  checkDownload,
  checkExport,
  checkGenerate,
  checkImport,
  checkPublish,
  checkWatchCampaign,
  deactivateVoucher,
  downloadExport,
  generateCodes,
  importCodes,
  loadOverview,
  loadWatchCampaign,
  publishBatch,
  requestExport,
  setAlert,
} from '@/lib/campaigns-ops/watch-server';

/**
 * The campaign watch desk (J-campaigns-17).
 *
 *   GET                                               every running campaign's KPIs, trend, top campaigns and alerts
 *   GET ?id=<campaign id>                             one campaign: participation, vouchers, redemptions, publications
 *   GET ?export=<job id>                              the export's CSV while its link is valid; after it, a refusal
 *   POST { op: 'alert', kind, enabled }               an alert on or off; on refuses while its threshold is blank
 *   POST { op: 'generate', campaignId, reference, count }  a batch; its plain codes are in this answer only
 *   POST { op: 'import', campaignId, reference, codes }    a CSV's codes, stored as hashes and last four characters
 *   POST { op: 'publish', batchId }                   a batch's codes, claimable by customers
 *   POST { op: 'deactivate', voucherId }              one voucher: its claim and every later use refuse
 *   POST { op: 'export', campaignId, dataset, fields } an export; the same one again returns its job
 *
 * Founder-only. svc-campaigns records the founder from their own token.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

const incomplete = (body: string) =>
  Response.json(
    { ok: false, title: 'That request is not complete', body, next: 'Nothing was changed. Correct it and try again.', code: null },
    { status: 400, headers: NO_STORE },
  );

const send = ({ status, reply }: { status: number; reply: unknown }) => Response.json(reply, { status, headers: NO_STORE });

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('more-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const params = new URL(request.url).searchParams;
  const exportId = params.get('export');
  if (exportId !== null) {
    const checked = checkDownload({ id: exportId });
    if (!checked.ok) return incomplete(checked.why);
    const answer = await downloadExport(session, checked.input);
    if (!answer.reply.ok) return send(answer);
    const file = answer.reply.data;
    return new Response(file.body, {
      status: 200,
      headers: {
        ...NO_STORE,
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${file.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      },
    });
  }
  const id = params.get('id');
  if (id !== null) {
    const checked = checkWatchCampaign({ id });
    if (!checked.ok) return incomplete(checked.why);
    return send(await loadWatchCampaign(session, checked.input));
  }
  return send(await loadOverview(session));
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('more-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    // An import carries its CSV's codes: at most 20,000 of up to 32 characters each.
    const body = await readAdminJson(request, 1_048_576);
    switch (body.op) {
      case 'alert': {
        const checked = checkAlert({ kind: body.kind, enabled: body.enabled });
        return checked.ok ? send(await setAlert(session, checked.input)) : incomplete(checked.why);
      }
      case 'generate': {
        const checked = checkGenerate({ campaignId: body.campaignId, reference: body.reference, count: body.count });
        return checked.ok ? send(await generateCodes(session, checked.input)) : incomplete(checked.why);
      }
      case 'import': {
        const checked = checkImport({ campaignId: body.campaignId, reference: body.reference, codes: body.codes });
        return checked.ok ? send(await importCodes(session, checked.input)) : incomplete(checked.why);
      }
      case 'publish': {
        const checked = checkPublish({ batchId: body.batchId });
        return checked.ok ? send(await publishBatch(session, checked.input)) : incomplete(checked.why);
      }
      case 'deactivate': {
        const checked = checkDeactivate({ voucherId: body.voucherId });
        return checked.ok ? send(await deactivateVoucher(session, checked.input)) : incomplete(checked.why);
      }
      case 'export': {
        const checked = checkExport({ campaignId: body.campaignId, dataset: body.dataset, fields: body.fields });
        return checked.ok ? send(await requestExport(session, checked.input)) : incomplete(checked.why);
      }
      default:
        return incomplete('Unknown action.');
    }
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
