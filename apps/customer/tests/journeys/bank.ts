import { principalHeaders, type Claims } from './identity';
import { stack } from './env';

export type BankResult = { status: number; body: string; data?: unknown };

/** A call to the bank as the edge makes it: a tRPC door with the signed principal of the session that asks. */
export async function bankCall(procedure: string, input: unknown, claims: Claims): Promise<BankResult> {
  const headers = { accept: 'application/json', ...principalHeaders(claims) };
  const response = await fetch(`${stack.bank()}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`, { headers });
  const body = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(body).result?.data;
  } catch {
    /* a refusal is not always JSON */
  }
  return { status: response.status, body, data };
}
