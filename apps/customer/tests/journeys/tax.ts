import { principalHeaders, type Claims } from './identity';
import { stack } from './env';

export type TaxResult = { status: number; body: string; data?: unknown };

/** A call to tax as the edge makes it: a tRPC door with the signed principal of the session that asks. */
export async function taxCall(procedure: string, input: unknown, claims: Claims): Promise<TaxResult> {
  const headers = { accept: 'application/json', ...principalHeaders(claims) };
  const response = await fetch(`${stack.tax()}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`, { headers });
  const body = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(body).result?.data;
  } catch {
    /* a refusal is not always JSON */
  }
  return { status: response.status, body, data };
}
