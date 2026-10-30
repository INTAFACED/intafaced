/**
 * The developer portal's published values: blank refuses with its one code, a published value answers every row with
 * null where the owner left a host or product out, and a malformed value stops boot.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  DEVELOPER_DATA_TERMS_PATH,
  DEVELOPER_HOSTS_PATH,
  DEVELOPER_REGIONAL_RULE_PATH,
  parseDataTerms,
  parseDeveloperHosts,
  parseRegionalRule,
  registerDeveloperPortalRest,
} from './developer-portal-rest.js';

const TERMS = { entitlement: 'e', redistribution: 'r', retention: 'k', privacy: 'p', commercial: 'c' };

async function served(hostsRaw: string, termsRaw: string, ruleRaw = '') {
  const app = Fastify();
  registerDeveloperPortalRest(app, {
    hosts: parseDeveloperHosts(hostsRaw),
    dataTerms: parseDataTerms(termsRaw),
    regionalRule: parseRegionalRule(ruleRaw),
  });
  await app.ready();
  const hosts = await app.inject({ method: 'GET', url: DEVELOPER_HOSTS_PATH });
  const terms = await app.inject({ method: 'GET', url: DEVELOPER_DATA_TERMS_PATH });
  const rule = await app.inject({ method: 'GET', url: DEVELOPER_REGIONAL_RULE_PATH });
  await app.close();
  return { hosts, terms, rule };
}

describe('developer portal values', () => {
  it('blank settings refuse 503 with their one code each', async () => {
    const { hosts, terms, rule } = await served('', '  ', ' \n ');
    expect(hosts.statusCode).toBe(503);
    expect(hosts.json().code).toBe('trade.developer_hosts_unset');
    expect(terms.statusCode).toBe(503);
    expect(terms.json().code).toBe('trade.developer_data_terms_unset');
    expect(rule.statusCode).toBe(503);
    expect(rule.json().code).toBe('trade.developer_regional_rule_unset');
  });

  it('a published regional rule answers its own text, trimmed', async () => {
    const { rule } = await served('', '', '  Regional hosts serve accounts in their region.  ');
    expect(rule.statusCode).toBe(200);
    expect(rule.json()).toEqual({ rule: 'Regional hosts serve accounts in their region.' });
  });

  it('a published setting answers all nine hosts and all six products, null where left out', async () => {
    const { hosts, terms } = await served(
      JSON.stringify({ rest: { production: 'api.a.test', sandbox: 'api.b.test' }, fix: { production: 'fix.a.test:9878' } }),
      JSON.stringify({ ticker: TERMS }),
    );
    expect(hosts.statusCode).toBe(200);
    const rows = hosts.json().hosts as { protocol: string; environment: string; host: string | null }[];
    expect(rows).toHaveLength(9);
    expect(rows.filter((row) => row.host !== null)).toEqual([
      { protocol: 'rest', environment: 'production', host: 'api.a.test' },
      { protocol: 'rest', environment: 'sandbox', host: 'api.b.test' },
      { protocol: 'fix', environment: 'production', host: 'fix.a.test:9878' },
    ]);
    expect(terms.statusCode).toBe(200);
    const products = terms.json().products as { product: string; terms: unknown }[];
    expect(products.map((row) => row.product)).toEqual(['ticker', 'depth_l1', 'depth_l2', 'candles', 'trades', 'index']);
    expect(products[0]!.terms).toEqual(TERMS);
    expect(products.slice(1).every((row) => row.terms === null)).toBe(true);
  });

  it('a malformed setting stops boot instead of serving a guess', () => {
    expect(() => parseDeveloperHosts('{not json')).toThrow(/TRADE_DEVELOPER_HOSTS is not JSON/);
    expect(() => parseDeveloperHosts('{}')).toThrow(/names no host/);
    expect(() => parseDeveloperHosts(JSON.stringify({ rest: {} }))).toThrow(/names no host/);
    expect(() => parseDeveloperHosts(JSON.stringify({ fix: { production: 'fix.a.test:99999' } }))).toThrow(/port out of range/);
    expect(() => parseDeveloperHosts(JSON.stringify({ fix: { production: 'fix.a.test:0' } }))).toThrow(/port out of range/);
    expect(() => parseDeveloperHosts(JSON.stringify({ rest: { production: 'https://api.a.test/v1' } }))).toThrow(/malformed/);
    expect(() => parseDeveloperHosts(JSON.stringify({ grpc: { production: 'api.a.test' } }))).toThrow(/malformed/);
    expect(() => parseDataTerms(JSON.stringify({ ticker: { ...TERMS, retention: ' ' } }))).toThrow(/malformed/);
    expect(() => parseDataTerms(JSON.stringify({ ticker: { entitlement: 'e' } }))).toThrow(/malformed/);
    expect(() => parseDataTerms(JSON.stringify({ ticker: { ...TERMS, extra: 'x' } }))).toThrow(/malformed/);
    expect(() => parseRegionalRule('x'.repeat(1001))).toThrow(/TRADE_DEVELOPER_REGIONAL_RULE is malformed/);
    expect(parseRegionalRule('x'.repeat(1000))).toBe('x'.repeat(1000));
    expect(parseRegionalRule('\u{1F310}'.repeat(1000))).toBe('\u{1F310}'.repeat(1000));
  });
});
