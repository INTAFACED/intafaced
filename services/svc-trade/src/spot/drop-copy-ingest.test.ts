import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyServiceHeaders } from '@intafaced/contracts';
import { HOUSE_MM_API_KEY_ID } from './auth-attribution.js';
import {
  DROP_COPY_INGEST_PATH,
  DROP_COPY_SOURCE_LIQUIDATION,
  DROP_COPY_SOURCE_REST,
  DROP_COPY_SOURCE_RFQ,
  createDropCopyIngestClient,
  dropCopySourceForBookOrder,
  encodeDropCopyFillJson,
  fireDropCopyFill,
  NoopDropCopyIngest,
  type DropCopyFillWire,
  type DropCopyIngestPort,
} from './drop-copy-ingest.js';
import { tradeServiceSource } from './trade-service/source.testkit.js';

const SECRET = 'test-internal-service-secret-32ch!!';
const here = dirname(fileURLToPath(import.meta.url));

const restFill = (): DropCopyFillWire => ({
  fillId: 'fill-7',
  orderId: 'ord-1',
  userId: 'user-1',
  marketId: 'BTC/USDT',
  side: 'buy',
  price: '100.25',
  qty: '1.50',
  quoteAmount: '150.375',
  feeAsset: 'USDT',
  feeAmount: '0.15',
  sequence: 11,
  ts: '2026-09-18T00:00:00.000Z',
  source: DROP_COPY_SOURCE_REST,
});

describe('dropCopySourceForBookOrder', () => {
  it('API-key place is rest; session-only is omitted; house-mm is not rest', () => {
    expect(dropCopySourceForBookOrder({ apiKeyId: 'key-7' })).toBe(DROP_COPY_SOURCE_REST);
    expect(dropCopySourceForBookOrder({ apiKeyId: 'key-7' })).not.toBe('ui');
    expect(dropCopySourceForBookOrder({ apiKeyId: 'key-7' })).not.toBe('ws');
    expect(dropCopySourceForBookOrder({ apiKeyId: null })).toBeNull();
    expect(dropCopySourceForBookOrder({ apiKeyId: '   ' })).toBeNull();
    expect(dropCopySourceForBookOrder({ apiKeyId: HOUSE_MM_API_KEY_ID })).toBeNull();
    expect(dropCopySourceForBookOrder({ apiKeyId: 'key-7' })).not.toBe(DROP_COPY_SOURCE_LIQUIDATION);
    expect(dropCopySourceForBookOrder({ apiKeyId: 'key-7' })).not.toBe(DROP_COPY_SOURCE_RFQ);
  });
});

describe('encodeDropCopyFillJson', () => {
  it('serialises money as decimal strings and never JSON numbers', () => {
    const body = encodeDropCopyFillJson(restFill());
    expect(body).not.toBeNull();
    const parsed = JSON.parse(body!) as Record<string, unknown>;
    expect(parsed.source).toBe('rest');
    expect(parsed.price).toBe('100.25');
    expect(parsed.qty).toBe('1.50');
    expect(parsed.quoteAmount).toBe('150.375');
    expect(parsed.feeAmount).toBe('0.15');
    expect(typeof parsed.price).toBe('string');
    expect(typeof parsed.qty).toBe('string');
    expect(typeof parsed.quoteAmount).toBe('string');
    expect(typeof parsed.feeAmount).toBe('string');
    expect(body).not.toMatch(/"price"\s*:\s*\d/);
    expect(body).not.toMatch(/"qty"\s*:\s*\d/);
    expect(body).not.toMatch(/"quoteAmount"\s*:\s*\d/);
    expect(body).not.toMatch(/"feeAmount"\s*:\s*\d/);
  });

  it('refuses IEEE money and forbidden sources rather than posting them', () => {
    expect(encodeDropCopyFillJson({ ...restFill(), price: 100.25 as unknown as string })).toBeNull();
    expect(encodeDropCopyFillJson({ ...restFill(), source: 'ui' as DropCopyFillWire['source'] })).toBeNull();
    expect(encodeDropCopyFillJson({ ...restFill(), source: 'ws' as DropCopyFillWire['source'] })).toBeNull();
    expect(encodeDropCopyFillJson({ ...restFill(), source: 'fix' as DropCopyFillWire['source'] })).toBeNull();
    expect(encodeDropCopyFillJson({ ...restFill(), source: 'algo' as DropCopyFillWire['source'] })).toBeNull();
    expect(encodeDropCopyFillJson({ ...restFill(), source: 'broker' as DropCopyFillWire['source'] })).toBeNull();
  });

  it('rfq and liquidation encode when money is strings', () => {
    expect(JSON.parse(encodeDropCopyFillJson({ ...restFill(), source: DROP_COPY_SOURCE_RFQ })!).source).toBe('rfq');
    expect(JSON.parse(encodeDropCopyFillJson({ ...restFill(), source: DROP_COPY_SOURCE_LIQUIDATION })!).source).toBe('liquidation');
  });
});

describe('createDropCopyIngestClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('blank URL does not fetch', async () => {
    let fetched = 0;
    vi.stubGlobal('fetch', async () => {
      fetched += 1;
      return new Response('nope', { status: 500 });
    });
    for (const url of ['', '   ']) {
      const client = createDropCopyIngestClient(url, SECRET);
      await expect(client.postFill(restFill())).resolves.toBeUndefined();
    }
    expect(fetched).toBe(0);
  });

  it('POSTs HMAC-bound raw JSON to /internal/drop-copy/fills', async () => {
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const body = String(init.body);
      const headers = init.headers as Record<string, string>;
      calls.push({ url: String(url), body, headers });
      expect(init.method).toBe('POST');
      const verified = verifyServiceHeaders(headers, SECRET, {
        rawBody: { retained: true, bytes: Buffer.from(body, 'utf8') },
        mode: 'require',
      });
      expect(verified.service).toBe('svc-trade');
      expect(verified.scheme).toBe('v2');
      expect(verified.rejected).toBeNull();
      return new Response('{"ok":true}', { status: 200 });
    });
    const client = createDropCopyIngestClient('http://svc-fix.example:8080', SECRET);
    await client.postFill(restFill());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`http://svc-fix.example:8080${DROP_COPY_INGEST_PATH}`);
    expect(calls[0]!.body).toBe(encodeDropCopyFillJson(restFill()));
    expect(JSON.parse(calls[0]!.body).source).toBe('rest');
    expect(calls[0]!.body).not.toContain('"ui"');
  });

  it('does not fetch when encode refuses IEEE money', async () => {
    let fetched = 0;
    vi.stubGlobal('fetch', async () => {
      fetched += 1;
      return new Response('ok', { status: 200 });
    });
    const client = createDropCopyIngestClient('http://svc-fix.example:8080', SECRET);
    await client.postFill({ ...restFill(), qty: 1.5 as unknown as string });
    expect(fetched).toBe(0);
  });
});

describe('fireDropCopyFill', () => {
  it('swallows ingest failure so settle is not unwound', async () => {
    const port: DropCopyIngestPort = {
      postFill: async () => {
        throw new Error('fix down');
      },
    };
    await expect(fireDropCopyFill(port, restFill())).resolves.toBeUndefined();
    await expect(fireDropCopyFill(new NoopDropCopyIngest(), restFill())).resolves.toBeUndefined();
  });
});

describe('spot settle and convert hitch sources (call-site pin)', () => {
  it('fillSettled hitch uses book-order rest; convert hitch is rfq; ui/ws/fix/algo/broker never sent', () => {
    const tradeSrc = tradeServiceSource();
    const indexSrc = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    const envSrc = readFileSync(join(here, '..', 'env.ts'), 'utf8');
    expect(tradeSrc).toMatch(/notifyDropCopyFill/);
    expect(tradeSrc).toMatch(/dropCopySourceForBookOrder/);
    expect(tradeSrc).toMatch(/DROP_COPY_SOURCE_RFQ/);
    expect(tradeSrc).not.toMatch(/source:\s*'ui'/);
    expect(tradeSrc).not.toMatch(/source:\s*'ws'/);
    expect(tradeSrc).not.toMatch(/source:\s*'fix'/);
    expect(tradeSrc).not.toMatch(/source:\s*'algo'/);
    expect(tradeSrc).not.toMatch(/source:\s*'broker'/);
    expect(tradeSrc).not.toMatch(/DROP_COPY_SOURCE_LIQUIDATION/);
    expect(indexSrc).toMatch(/createDropCopyIngestClient/);
    expect(indexSrc).toMatch(/TRADE_FIX_DROPCOPY_INGEST_URL/);
    expect(envSrc).toMatch(/TRADE_FIX_DROPCOPY_INGEST_URL:[\s\S]*?\.default\(''\)/);
    expect(envSrc).not.toMatch(/TRADE_FIX_DROPCOPY_INGEST_URL:[\s\S]{0,200}localhost/);
  });
});
