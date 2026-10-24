import {
  customerDetailReviewSchema,
  customerDetailReviewsInputSchema,
  customerDetailsLookupInputSchema,
  customerDetailsResultSchema,
  customerDetailsStateSchema,
} from '@intafaced/contracts';
import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest, founderEdgeCall } from '@/lib/founder-session';
import { founderCall, parseWith } from '@/lib/desk/founder-call';
import { readEditForm } from '@/lib/accounts/details-forms';
import { detailsAnswer } from '@/lib/accounts/details-server';

/**
 * A customer's personal details (J-ops-console-04 #9). GET reads identity's record (`?id=`), its compliance reviews
 * (`?id=&view=reviews&limit=`) or its edit history (`?id=&view=history&limit=`). POST is one founder's edit of one detail:
 * identity applies an open detail at once and opens a compliance review for a name, date of birth or tax number.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const lookup = customerDetailsLookupInputSchema;
const listing = customerDetailReviewsInputSchema;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((key) => !['id', 'view', 'limit'].includes(key))) throw new AdminSessionError('admin.accounts_input', 400);
    const view = params.get('view') ?? 'state';
    const userId = params.get('id')?.toLowerCase();
    if (view === 'state') {
      const parsed = lookup.safeParse({ userId });
      if (!parsed.success || params.has('limit')) throw new AdminSessionError('admin.accounts_input', 400);
      const data = await founderEdgeCall(config, 'identity', 'accountControls.details', 'GET', parsed.data, session.accessToken);
      const state = data === null ? null : customerDetailsStateSchema.safeParse(data);
      if (state && (!state.success || state.data.userId !== parsed.data.userId)) throw new AdminSessionError('admin.upstream_invalid', 502);
      return Response.json(data, { headers: NO_STORE });
    }
    if (view !== 'reviews' && view !== 'history') throw new AdminSessionError('admin.accounts_input', 400);
    const parsed = listing.safeParse({ userId, limit: Number(params.get('limit')) });
    if (!parsed.success) throw new AdminSessionError('admin.accounts_input', 400);
    const data = await founderEdgeCall(
      config,
      'identity',
      view === 'reviews' ? 'accountControls.detailsReviews' : 'accountControls.detailsHistory',
      'GET',
      parsed.data,
      session.accessToken,
    );
    const rowSchema = view === 'reviews' ? customerDetailReviewSchema : customerDetailsResultSchema;
    const valid =
      Array.isArray(data) &&
      data.length <= parsed.data.limit &&
      data.every((row) => {
        const one = rowSchema.safeParse(row);
        return one.success && one.data.userId === parsed.data.userId;
      });
    if (!valid) throw new AdminSessionError('admin.upstream_invalid', 502);
    return Response.json(data, { headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}

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
  const form = readEditForm(raw, session.session.userId);
  if (!form)
    return Response.json(
      {
        ok: false,
        text: 'That edit was not accepted: check the detail, its value and a reason of 12 to 255 characters. Nothing was sent.',
      },
      { status: 400, headers: NO_STORE },
    );
  const result = await founderCall(
    session,
    'identity',
    'accountControls.detailsEdit',
    'POST',
    {
      requestId: form.requestId,
      userId: form.userId,
      expectedVersion: form.expectedVersion,
      reason: form.reason,
      changes: { [form.field]: form.value },
    },
    parseWith(customerDetailsResultSchema),
  );
  return detailsAnswer(result, form.userId);
}
