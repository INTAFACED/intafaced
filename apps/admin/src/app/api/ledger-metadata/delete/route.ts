import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { handleStep } from '@/lib/desk/step-route';
import { decodeMetadataDelete } from '@/lib/ledger/account-metadata-delete';
import { postTreasury, treasuryParked } from '@/lib/ledger/reconciliation-server';

/**
 * Delete one metadata key on a ledger account (J-ops-console-03 #6, #7, OPS-ledger-desk-01).
 *
 * A TWO-FOUNDER request like a reconciliation run: one founder proposes the delete bound to the account, the key, the
 * reason and the key's revision; a different founder approves exactly that; the delete step goes to svc-edge on the
 * treasury transport and svc-ledger spends the approval once. Under the posting freeze svc-ledger refuses
 * `ledger.frozen` before identity spends anything, so the same approval deletes the key after the unfreeze.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;

  return handleStep(request, session, {
    kinds: ['ledger.account_metadata.delete'],
    check() {
      const parked = treasuryParked();
      if (!parked) return null;
      return { refusal: { ...explainRefusal('admin.ledger_unconfigured', 503, false), body: parked }, status: 503 };
    },
    async execute(req, ids) {
      if (req.kind !== 'ledger.account_metadata.delete') return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
      const answer = await postTreasury(`/admin/ledger/accounts/${req.accountId}/metadata/delete`, {
        key: req.key,
        reason: req.reason,
        revision: Number(req.version),
        approvalId: ids.approvalId,
        operationId: ids.operationId,
      });
      return decodeMetadataDelete(answer, req.accountId, req.key);
    },
  });
}
