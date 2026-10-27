import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { readPlaceForm } from '@/lib/accounts/holds';
import { placeHold } from '@/lib/accounts/holds-server';

/**
 * Place one staff hold on a customer's funds (J-ops-console-04 #2). One founder and a reason; svc-ops posts it in the ledger on
 * the treasury transport. The key is the account's place key (the newest hold the founder saw on it), so a retry, a reload or
 * a second tab before the list shows the hold returns the stored hold and never holds twice.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  let raw: Record<string, unknown>;
  try {
    raw = await readAdminJson(request);
  } catch (error) {
    return adminSessionErrorResponse(error instanceof AdminSessionError ? error : new AdminSessionError('admin.json_required', 400));
  }
  const form = readPlaceForm(raw);
  if (!form)
    return Response.json(
      {
        ok: false,
        refusal: {
          title: 'That hold was not accepted',
          body: 'Check the coin, the amount, the reason and the expiry.',
          next: 'Nothing was sent.',
          code: 'admin.request_invalid',
          changed: 'no',
        },
      },
      { status: 400, headers: NO_STORE },
    );
  const reply = await placeHold(session, form);
  const status = reply.ok ? 200 : reply.refusal.changed === 'unknown' ? 502 : 409;
  return Response.json(reply, { status, headers: NO_STORE });
}
