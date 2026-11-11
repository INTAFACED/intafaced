/**
 * The explorer's route table (DV-console-01): each request it can build, from the public API reference. A read runs
 * with any key; a write is sent only as a write, and the edge refuses it with a live key
 * (`edge.explorer_live_write_refused`). Nothing here holds a key.
 */
export const EXPLORER_HEADER = 'x-api-explorer';
export const SANDBOX_KEY_PREFIX = 'ifc_test_';

export type ExplorerRoute = {
  id: 'balance' | 'payments' | 'payment-create';
  method: 'GET' | 'POST';
  path: string;
  /** The request needs the business id (`merchantId`). */
  merchant: boolean;
  /** The body a write starts from; the person edits it. */
  body?: (merchantId: string) => Record<string, unknown>;
};

export const EXPLORER_ROUTES: readonly ExplorerRoute[] = [
  { id: 'balance', method: 'GET', path: '/api/v1/account/balance', merchant: false },
  { id: 'payments', method: 'GET', path: '/api/pay/v1/payments?merchantId={merchantId}&limit=10', merchant: true },
  {
    id: 'payment-create',
    method: 'POST',
    path: '/api/pay/v1/payments',
    merchant: true,
    body: (merchantId) => ({
      merchantId,
      amount: '10',
      assetId: 'USD',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: '' },
    }),
  },
];

export const isSandboxKey = (key: string) => key.trim().startsWith(SANDBOX_KEY_PREFIX);

/** The request's path with the business id filled in. */
export function pathOf(route: ExplorerRoute, merchantId: string): string {
  return route.path.replace('{merchantId}', encodeURIComponent(merchantId));
}

/** A shell command that sends the same request; the key is shown as a variable, never written out. */
export function curlOf(route: ExplorerRoute, base: string, merchantId: string, body: string | null): string {
  const lines = [`curl -X ${route.method} '${base}${pathOf(route, merchantId)}'`, `  -H "Authorization: Bearer $INTAFACED_API_KEY"`];
  if (body !== null) {
    lines.push(`  -H 'Content-Type: application/json'`, `  -H 'Idempotency-Key: <a business key for this payment>'`);
    lines.push(`  -d '${body.replace(/'/g, "'\\''")}'`);
  }
  return lines.join(' \\\n');
}

/** The typed code an answer carries, in either dialect the edge speaks (REST or tRPC). */
export function codeOfAnswer(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { code?: unknown; error?: { code?: unknown; data?: { intafacedCode?: unknown; code?: unknown } } };
  for (const c of [b.code, b.error?.data?.intafacedCode, b.error?.code, b.error?.data?.code]) {
    if (typeof c === 'string' && /^[a-z_]+\.[a-z0-9_.]+$/.test(c)) return c;
  }
  return null;
}
