import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import {
  checkCase,
  checkDecide,
  checkRevoke,
  checkWithhold,
  decideAppeal,
  loadRiskCase,
  loadRiskQueue,
  revokeRewards,
  withholdReward,
} from '@/lib/campaigns-ops/risk-server';

/**
 * The risk review desk (J-campaigns-18).
 *
 *   GET                                              the queue: every account with a signal or a reward withheld for its status
 *   GET ?account=<id>                                one account's case: signals, rewards, decisions and appeal
 *   POST { op: 'withhold', rewardKey, reason }       a reward held for review stays held; no ledger call
 *   POST { op: 'revoke', accountId, reason }         owed rewards cancelled once, paid ones recorded, the account flagged
 *   POST { op: 'decide', accountId, outcome, reason } the appeal, by a person other than the one who revoked
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
  const account = new URL(request.url).searchParams.get('account');
  if (account !== null) {
    const checked = checkCase({ accountId: account });
    if (!checked.ok) return incomplete(checked.why);
    return send(await loadRiskCase(session, checked.input));
  }
  return send(await loadRiskQueue(session));
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('more-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request, 16_384);
    switch (body.op) {
      case 'withhold': {
        const checked = checkWithhold({ rewardKey: body.rewardKey, reason: body.reason });
        return checked.ok ? send(await withholdReward(session, checked.input)) : incomplete(checked.why);
      }
      case 'revoke': {
        const checked = checkRevoke({ accountId: body.accountId, reason: body.reason });
        return checked.ok ? send(await revokeRewards(session, checked.input)) : incomplete(checked.why);
      }
      case 'decide': {
        const checked = checkDecide({ accountId: body.accountId, outcome: body.outcome, reason: body.reason });
        return checked.ok ? send(await decideAppeal(session, checked.input)) : incomplete(checked.why);
      }
      default:
        return incomplete('Unknown action.');
    }
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
