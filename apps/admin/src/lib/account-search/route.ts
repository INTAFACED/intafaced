import 'server-only';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { moduleDisabledResponse } from '@/lib/modules';
import { loadRead } from '@/lib/ops-desk/server';
import { accountSearchSpec, searchCursor, searchTerm } from './search';

const NO_STORE = { 'cache-control': 'no-store' } as const;

/** GET `?q=<email or handle start>[&cursor=<identity's marker>]`: one page of identity's account search, as the signed-in founder. */
export async function accountSearchGet(request: Request): Promise<Response> {
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return Response.json({ error: 'not_same_origin' }, { status: 403, headers: NO_STORE });
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => key !== 'q' && key !== 'cursor')) {
    return Response.json({ error: 'search_request_invalid' }, { status: 400, headers: NO_STORE });
  }
  const term = searchTerm(params.get('q') ?? '');
  const cursor = searchCursor(params.get('cursor'));
  if ('error' in term || cursor === undefined) {
    return Response.json(
      { error: 'search_request_invalid', message: 'error' in term ? term.error : 'Bad page marker.' },
      { status: 400, headers: NO_STORE },
    );
  }
  const spec = accountSearchSpec(term, cursor);
  return Response.json({ spec, outcome: await loadRead(session, spec) }, { headers: NO_STORE });
}
