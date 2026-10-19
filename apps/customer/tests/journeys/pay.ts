import { principalHeaders, type Claims } from './identity';
import { stack } from './env';

export type PayResult = { status: number; body: string; data?: unknown };

/** A call to the payments core as the edge makes it: a tRPC door with the signed principal of the session that asks. */
export async function payCall(
  procedure: string,
  input: unknown,
  claims: Claims,
  kind: 'mutation' | 'query' = 'mutation',
): Promise<PayResult> {
  const headers = { 'content-type': 'application/json', accept: 'application/json', ...principalHeaders(claims) };
  const response =
    kind === 'mutation'
      ? await fetch(`${stack.pay()}/trpc/${procedure}`, { method: 'POST', headers, body: JSON.stringify(input ?? {}) })
      : await fetch(`${stack.pay()}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`, { headers });
  const body = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(body).result?.data;
  } catch {
    /* a refusal is not always JSON */
  }
  return { status: response.status, body, data };
}
