import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffGate, adminBffSession } from '@/lib/admin-bff-gate';
import { readFreeze, sendFreezeWithApproval } from '@/lib/control-plane-client';
import { readConsoleStatus } from '@/lib/console-status';
import { decodeFreezeExecute } from '@/lib/desk/execute-decode';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { handleStep } from '@/lib/desk/step-route';
import { describeUnconfigured } from '@/lib/console-status';

/**
 * The console's route to the switch that halts ALL value movement (§4.2, §14.6).
 *
 * Separate from `/api/kill-switch` because it is a separate authority. Module halts travel on
 * `ADMIN_OPERATOR_TOKEN` (`admin:write`); this travels on `ADMIN_TREASURY_TOKEN` (`admin:treasury`), and a console
 * configured with only the first cannot stop the money plane. `svc-edge` enforces the split independently.
 *
 * GET reads the posting record. POST runs one step of a TWO-FOUNDER request, exactly as `/api/kill-switch` does:
 * a freeze or unfreeze needs an identity-issued approval a different founder signed, bound to the ledger's own
 * version token, and svc-ledger spends it once. A freeze is a protective brake (any two operators); an unfreeze
 * needs two current founders, which identity checks at approve and again at consume.
 *
 * Every answer from below is passed through with its own status, including the failures. An operator told the
 * platform is halted when it is not walks away from a book that is still accepting writes.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  const gate = await adminBffGate(request);
  if (gate) return gate;
  const result = await readFreeze();
  return Response.json(result, { status: result.ok ? 200 : result.status });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;

  return handleStep(request, session, {
    kinds: ['ledger.freeze', 'ledger.unfreeze'],
    check() {
      const status = readConsoleStatus();
      if (status.treasury.configured) return null;
      return {
        refusal: { ...explainRefusal('admin.ledger_unconfigured', 503, false), body: describeUnconfigured(status.treasury) },
        status: 503,
      };
    },
    async execute(req, ids) {
      if (req.kind === 'ledger.freeze') return decodeFreezeExecute(await sendFreezeWithApproval(true, req.reason, ids), true);
      if (req.kind === 'ledger.unfreeze') return decodeFreezeExecute(await sendFreezeWithApproval(false, undefined, ids), false);
      return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    },
  });
}
