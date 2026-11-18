import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import {
  checkBoard,
  checkPlan,
  checkRun,
  loadDistributionPlan,
  loadPayoutBoard,
  runDistribution,
} from '@/lib/campaigns-ops/payouts-server';

/**
 * The payout board (J-campaigns-19).
 *
 *   GET [?campaign=<id>]                     intents by state: owed, pending funding, sending, paid, failed, other
 *   GET ?plan=<campaignId>                   an airdrop's plan, account by account, from its snapshot
 *   POST { op: 'run', campaignId, reason }   take the snapshot when due, or resume a run that stopped; nobody is paid twice
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
  const plan = params.get('plan');
  if (plan !== null) {
    const checked = checkPlan({ campaignId: plan });
    if (!checked.ok) return incomplete(checked.why);
    return send(await loadDistributionPlan(session, checked.input));
  }
  const campaign = params.get('campaign');
  const checked = checkBoard(campaign === null ? {} : { campaignId: campaign });
  if (!checked.ok) return incomplete(checked.why);
  return send(await loadPayoutBoard(session, checked.input));
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('more-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request, 16_384);
    switch (body.op) {
      case 'run': {
        const checked = checkRun({ campaignId: body.campaignId, reason: body.reason });
        return checked.ok ? send(await runDistribution(session, checked.input)) : incomplete(checked.why);
      }
      default:
        return incomplete('Unknown action.');
    }
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
