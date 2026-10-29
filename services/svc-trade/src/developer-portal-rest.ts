/**
 * The developer portal's published values (J-developer-01 #2, #3, #6): the API hosts per protocol and environment, the
 * rule for the regional hosts, and the market data terms per product. All three are the owner's to publish; nothing
 * here holds a default.
 *
 *   GET /developer-portal/hosts       (through the edge: /api/trade/developer-portal/hosts)
 *   GET /developer-portal/data-terms  (through the edge: /api/trade/developer-portal/data-terms)
 *   GET /developer-portal/regional-rule (through the edge: /api/trade/developer-portal/regional-rule)
 *
 * Plain JSON, signed-out readable. Blank setting → 503 with its one code (`trade.developer_hosts_unset`,
 * `trade.developer_data_terms_unset`, `trade.developer_regional_rule_unset`). A published hosts or data terms setting
 * answers every row, with `null` where the owner left that host or product out; a published rule answers its text. A malformed setting stops the service at boot instead of serving a guess.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export const DEVELOPER_HOSTS_PATH = '/developer-portal/hosts';
export const DEVELOPER_DATA_TERMS_PATH = '/developer-portal/data-terms';
export const DEVELOPER_REGIONAL_RULE_PATH = '/developer-portal/regional-rule';

export const DEVELOPER_PROTOCOLS = ['rest', 'websocket', 'fix'] as const;
export const DEVELOPER_ENVIRONMENTS = ['production', 'sandbox', 'regional'] as const;
export const DATA_PRODUCTS = ['ticker', 'depth_l1', 'depth_l2', 'candles', 'trades', 'index'] as const;
export const DATA_TERMS = ['entitlement', 'redistribution', 'retention', 'privacy', 'commercial'] as const;

export const DEVELOPER_HOSTS_UNSET = 'trade.developer_hosts_unset';
export const DEVELOPER_DATA_TERMS_UNSET = 'trade.developer_data_terms_unset';
export const DEVELOPER_REGIONAL_RULE_UNSET = 'trade.developer_regional_rule_unset';
const REGIONAL_RULE_MAX = 1000;

/** A host name with an optional port (1 to 65535), lower case; never a scheme or a path. */
const HOST = /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;
const hostText = z
  .string()
  .regex(HOST)
  .refine((host) => {
    const port = host.split(':')[1];
    return port === undefined || (Number(port) >= 1 && Number(port) <= 65535);
  }, 'port out of range');

const hostsSchema = z
  .partialRecord(z.enum(DEVELOPER_PROTOCOLS), z.partialRecord(z.enum(DEVELOPER_ENVIRONMENTS), hostText))
  .refine((value) => Object.values(value).some((environments) => Object.keys(environments ?? {}).length > 0), 'names no host');
const termText = z.string().trim().min(1).max(500);
const productTerms = z
  .object({ entitlement: termText, redistribution: termText, retention: termText, privacy: termText, commercial: termText })
  .strict();
const termsSchema = z
  .partialRecord(z.enum(DATA_PRODUCTS), productTerms)
  .refine((value) => Object.keys(value).length > 0, 'names no product');

export type DeveloperHostRow = {
  protocol: (typeof DEVELOPER_PROTOCOLS)[number];
  environment: (typeof DEVELOPER_ENVIRONMENTS)[number];
  host: string | null;
};
export type DataTermsRow = {
  product: (typeof DATA_PRODUCTS)[number];
  terms: Record<(typeof DATA_TERMS)[number], string> | null;
};

function parseJsonSetting<T>(name: string, raw: string, schema: z.ZodType<T>): T | null {
  if (raw.trim() === '') return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not JSON. Leave it blank until the owner publishes it.`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(`${name} is malformed: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  return parsed.data;
}

/** `TRADE_DEVELOPER_HOSTS`: blank → null; else one row per protocol and environment, in that order. */
export function parseDeveloperHosts(raw: string): DeveloperHostRow[] | null {
  const hosts = parseJsonSetting('TRADE_DEVELOPER_HOSTS', raw, hostsSchema);
  if (!hosts) return null;
  return DEVELOPER_PROTOCOLS.flatMap((protocol) =>
    DEVELOPER_ENVIRONMENTS.map((environment) => ({ protocol, environment, host: hosts[protocol]?.[environment] ?? null })),
  );
}

/** `TRADE_DEVELOPER_DATA_TERMS`: blank → null; else one row per product, every term or none. */
export function parseDataTerms(raw: string): DataTermsRow[] | null {
  const terms = parseJsonSetting('TRADE_DEVELOPER_DATA_TERMS', raw, termsSchema);
  if (!terms) return null;
  return DATA_PRODUCTS.map((product) => ({ product, terms: terms[product] ?? null }));
}

/** `TRADE_DEVELOPER_REGIONAL_RULE`: blank → null; else the owner's text, trimmed. Too long stops boot. */
export function parseRegionalRule(raw: string): string | null {
  const rule = raw.trim();
  if (rule === '') return null;
  if ([...rule].length > REGIONAL_RULE_MAX) {
    throw new Error(`TRADE_DEVELOPER_REGIONAL_RULE is malformed: longer than ${REGIONAL_RULE_MAX} characters`);
  }
  return rule;
}

export interface DeveloperPortalDeps {
  hosts: DeveloperHostRow[] | null;
  dataTerms: DataTermsRow[] | null;
  regionalRule: string | null;
}

export function registerDeveloperPortalRest(app: FastifyInstance, deps: DeveloperPortalDeps): void {
  app.get(DEVELOPER_HOSTS_PATH, async (_req, reply) => {
    if (!deps.hosts) {
      return reply.code(503).send({ code: DEVELOPER_HOSTS_UNSET, message: 'The API hosts are not published yet.' });
    }
    return reply.code(200).send({ hosts: deps.hosts });
  });
  app.get(DEVELOPER_DATA_TERMS_PATH, async (_req, reply) => {
    if (!deps.dataTerms) {
      return reply.code(503).send({ code: DEVELOPER_DATA_TERMS_UNSET, message: 'The market data terms are not published yet.' });
    }
    return reply.code(200).send({ products: deps.dataTerms });
  });
  app.get(DEVELOPER_REGIONAL_RULE_PATH, async (_req, reply) => {
    if (deps.regionalRule === null) {
      return reply.code(503).send({ code: DEVELOPER_REGIONAL_RULE_UNSET, message: 'The regional host rule is not published yet.' });
    }
    return reply.code(200).send({ rule: deps.regionalRule });
  });
}
