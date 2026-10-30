// hand-declared-ok: svc-trade's developer-portal answers have no browser-safe schema in packages/contracts; these mirror
// services/svc-trade/src/developer-portal-rest.ts exactly
/**
 * The owner's published developer values, read from svc-trade (`/api/trade/developer-portal/*`, signed out): the API
 * hosts per protocol and environment, and the market data terms per product. A blank setting refuses with its one
 * code, and the page shows every row as not set with that code; the front end never holds a host or a term itself.
 */
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { DATA_PRODUCTS, DATA_TERMS, ENVIRONMENTS, PROTOCOLS, type Environment, type Protocol } from './developers-model';
import type { Read } from './use-read';

export const DEVELOPER_HOSTS_UNSET = 'trade.developer_hosts_unset';
export const DEVELOPER_DATA_TERMS_UNSET = 'trade.developer_data_terms_unset';
export const DEVELOPER_REGIONAL_RULE_UNSET = 'trade.developer_regional_rule_unset';

const hostsSchema = z.object({
  hosts: z.array(z.object({ protocol: z.enum(PROTOCOLS), environment: z.enum(ENVIRONMENTS), host: z.string().min(1).nullable() })),
});
const termsSchema = z.object({
  products: z.array(
    z.object({
      product: z.enum(DATA_PRODUCTS),
      terms: z.object(Object.fromEntries(DATA_TERMS.map((term) => [term, z.string().min(1)])) as Record<Term, z.ZodString>).nullable(),
    }),
  ),
});
const regionalRuleSchema = z.object({ rule: z.string().min(1) });
type Term = (typeof DATA_TERMS)[number];
export type DataProduct = (typeof DATA_PRODUCTS)[number];
export type ProductTerms = Record<Term, string> | null;

export const readDeveloperHosts = (api: ApiClient, signal: AbortSignal): Promise<ApiResult<z.infer<typeof hostsSchema>>> =>
  api.plain('trade', '/developer-portal/hosts', hostsSchema, { signal });

export const readDataTerms = (api: ApiClient, signal: AbortSignal): Promise<ApiResult<z.infer<typeof termsSchema>>> =>
  api.plain('trade', '/developer-portal/data-terms', termsSchema, { signal });

/**
 * What a hosts read lets the page draw: the published hosts, or every host unset with the code that says why. Any
 * other failure (the service unreachable) is not "not set": the page shows the failure instead of a table.
 */
export function hostsView(
  read: Read<z.infer<typeof hostsSchema>>,
):
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'table'; read: (protocol: Protocol, environment: Environment) => string | null; unsetCode: string | null } {
  if (read.status === 'loading') return { kind: 'loading' };
  if (read.status === 'failed') {
    return read.code === DEVELOPER_HOSTS_UNSET ? { kind: 'table', read: () => null, unsetCode: read.code } : { kind: 'failed' };
  }
  const { hosts } = read.data;
  return {
    kind: 'table',
    read: (protocol, environment) => hosts.find((row) => row.protocol === protocol && row.environment === environment)?.host ?? null,
    unsetCode: null,
  };
}

/** The same for the data terms: each product's terms, or every product unset with the code. */
export function termsView(
  read: Read<z.infer<typeof termsSchema>>,
): { kind: 'loading' } | { kind: 'failed' } | { kind: 'table'; termsOf: (product: DataProduct) => ProductTerms; unsetCode: string | null } {
  if (read.status === 'loading') return { kind: 'loading' };
  if (read.status === 'failed') {
    return read.code === DEVELOPER_DATA_TERMS_UNSET ? { kind: 'table', termsOf: () => null, unsetCode: read.code } : { kind: 'failed' };
  }
  const { products } = read.data;
  return { kind: 'table', termsOf: (product) => products.find((row) => row.product === product)?.terms ?? null, unsetCode: null };
}

export const readRegionalRule = (api: ApiClient, signal: AbortSignal): Promise<ApiResult<z.infer<typeof regionalRuleSchema>>> =>
  api.plain('trade', '/developer-portal/regional-rule', regionalRuleSchema, { signal });

/** The regional host rule: the owner's text, or unset with the code that says why; any other failure is not "unset". */
export function regionalRuleView(
  read: Read<z.infer<typeof regionalRuleSchema>>,
): { kind: 'loading' } | { kind: 'failed' } | { kind: 'set'; rule: string } | { kind: 'unset'; code: string } {
  if (read.status === 'loading') return { kind: 'loading' };
  if (read.status === 'failed') {
    return read.code === DEVELOPER_REGIONAL_RULE_UNSET ? { kind: 'unset', code: read.code } : { kind: 'failed' };
  }
  return { kind: 'set', rule: read.data.rule };
}
