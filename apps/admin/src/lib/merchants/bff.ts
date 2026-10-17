import 'server-only';
import { explainRefusal } from './registry-model';
import type { PayCallResult } from './pay-call';

/**
 * Shared answers for the Merchants BFF routes (`/api/merchants/*`). Every answer is `no-store`, and every
 * refusal is explained in plain English by `explainRefusal`; the browser never receives a status number as
 * its only explanation or a raw service message.
 */
export const NO_STORE = { 'cache-control': 'no-store' } as const;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function refusal(code: string | null, message: string, status: number, requestId: string | null): Response {
  const plain = explainRefusal(code, message, status);
  return json({ ok: false, refusal: { ...plain, code, requestId } }, status >= 400 && status < 600 ? status : 502);
}

export function fromFailure<T>(
  result: Exclude<PayCallResult<T>, { kind: 'ok' }>,
  options: { notBuilt?: { title: string; body: string; next: string }; notFoundCode?: string } = {},
): Response {
  switch (result.kind) {
    case 'refused':
      return refusal(result.refusal.code, result.refusal.message, result.refusal.status, result.requestId);
    case 'forbidden':
      return refusal('operator.denied', '', 403, result.requestId);
    case 'not_built':
      return json(
        {
          ok: false,
          refusal: {
            ...(options.notBuilt ?? {
              title: 'This is not built yet',
              body: 'The service behind this action has not been switched on for this deployment.',
              next: 'Nothing was changed. This control is not connected here.',
            }),
            code: 'pay.not_built',
            requestId: result.requestId,
          },
        },
        501,
      );
    case 'not_found':
      return refusal(options.notFoundCode ?? 'registries.not_found', '', 404, result.requestId);
    case 'unavailable':
      return refusal(null, '', 503, result.requestId);
    default:
      return refusal(null, '', 502, result.requestId);
  }
}
