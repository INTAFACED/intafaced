import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { matchingOrderCommandSchema, parseMatchingOrderCommand } from './command.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const valid = {
  kind: 'new_order_single' as const,
  clOrdId: 'clid-1',
  beginString: 'FIX.4.4' as const,
  symbol: 'BTC/USDT',
  side: 'buy' as const,
  ordType: 'limit' as const,
  qty: '1.50',
  price: '100.25',
};

describe('matching order command — decimal strings, no book', () => {
  it('accepts decimal-string qty and price', () => {
    expect(parseMatchingOrderCommand(valid)).toEqual(valid);
  });

  it('refuses JS number qty', () => {
    const r = matchingOrderCommandSchema.safeParse({ ...valid, qty: 1.5 });
    expect(r.success).toBe(false);
  });

  it('refuses JS number price', () => {
    const r = matchingOrderCommandSchema.safeParse({ ...valid, price: 100.25 });
    expect(r.success).toBe(false);
  });

  it('refuses a limit new_order_single when price is null, blank, or whitespace', () => {
    for (const price of [null, '', ' ', '\t', '\n']) {
      const r = matchingOrderCommandSchema.safeParse({ ...valid, ordType: 'limit', price });
      expect(r.success, `price ${JSON.stringify(price)}`).toBe(false);
    }
  });

  it('refuses IEEE-looking exponent qty', () => {
    const r = matchingOrderCommandSchema.safeParse({ ...valid, qty: '1e-2' });
    expect(r.success).toBe(false);
  });

  it('market command keeps price null rather than a number', () => {
    const cmd = parseMatchingOrderCommand({ ...valid, ordType: 'market', price: null });
    expect(cmd.price).toBeNull();
    expect(typeof cmd.qty).toBe('string');
  });

  it('market command forwards an explicit protection price decimal string', () => {
    const cmd = parseMatchingOrderCommand({ ...valid, ordType: 'market', price: '101.50' });
    expect(cmd.price).toBe('101.50');
    expect(cmd.ordType).toBe('market');
  });

  it('refuses a blank or non-decimal price on a market command', () => {
    for (const price of ['', ' ', 'abc', '1e-2', '-1']) {
      const r = matchingOrderCommandSchema.safeParse({ ...valid, ordType: 'market', price });
      expect(r.success, JSON.stringify(price)).toBe(false);
    }
  });

  it('accepts optional senderCompId and tif without inventing them', () => {
    const cmd = parseMatchingOrderCommand({ ...valid, senderCompId: 'CLIENT', tif: 'GTC' });
    expect(cmd.senderCompId).toBe('CLIENT');
    expect(cmd.tif).toBe('GTC');
  });
});

describe('adapter boundary — not a ledger, not npm FIX', () => {
  it('package.json does not depend on ledger-client, ccxt, or node-quickfix', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    expect(names).not.toContain('@intafaced/ledger-client');
    expect(names.some((n) => n.toLowerCase().includes('ccxt'))).toBe(false);
    expect(names.some((n) => n.toLowerCase().includes('quickfix') && n.toLowerCase().includes('node'))).toBe(false);
  });

  it('pins QuickFIX/J 3.0.2 and does not declare Java balances', () => {
    const pom = readFileSync(join(root, 'pom.xml'), 'utf8');
    expect(pom).toContain('<quickfixj.version>3.0.2</quickfixj.version>');
    expect(pom).toContain('quickfixj-core');
    expect(pom).toContain('<mainClass>io.intafaced.fix.FixAcceptorMain</mainClass>');
    expect(pom).not.toContain('<mainClass>io.intafaced.fix.FixAdapterMain</mainClass>');
    expect(pom.toLowerCase()).not.toContain('memberwallet');
    expect(pom.toLowerCase()).not.toContain('ledger-client');
    const adapter = readFileSync(join(root, 'src/main/java/io/intafaced/fix/FixGatewayAdapter.java'), 'utf8');
    expect(adapter).not.toMatch(/\bgetDouble\s*\(/);
    expect(adapter).not.toMatch(/\bDoubleField\b/);
    expect(adapter).not.toMatch(/ledger-client/);
    expect(adapter).not.toMatch(/MemberWallet/);
    expect(adapter).not.toMatch(/\bsetBalance\s*\(/);
  });
});

describe('H1 compose — FixAcceptorMain, not stdin CLI', () => {
  it('compose and Dockerfiles run FixAcceptorMain with blank CompID map', () => {
    const compose = readFileSync(join(root, '../../docker-compose.apps.yml'), 'utf8');
    expect(compose).toMatch(/^  svc-fix:/m);
    expect(compose).toContain('io.intafaced.fix.FixAcceptorMain');
    expect(compose).not.toContain('io.intafaced.fix.FixAdapterMain');
    expect(compose).toContain('MATCHING_BASE_URL: http://svc-matching:4005');
    expect(compose).toContain('FIX_COMPID_ACCOUNT_JSON: ${FIX_COMPID_ACCOUNT_JSON:-}');
    expect(compose).not.toMatch(/FIX_COMPID_ACCOUNT_JSON:.*CLIENT/);
    const nginxSlice = compose.slice(compose.indexOf('vendor-shell:'));
    expect(nginxSlice).toContain('nginx proxies /api to the edge and /ws to the socket');
    const dockerfile = readFileSync(join(root, '../../Dockerfile'), 'utf8');
    expect(dockerfile).toContain('services/svc-fix/package.json');
    const fixImage = readFileSync(join(root, 'Dockerfile'), 'utf8');
    expect(fixImage).toContain('io.intafaced.fix.FixAcceptorMain');
    expect(fixImage).toContain('6334e2d288e5');
  });
});
