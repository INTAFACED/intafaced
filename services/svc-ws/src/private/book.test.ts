import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { HttpPrivateBookPort, parseOpenOrder, parseOpenPosition, PrivateBookError } from './book.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('private book parse', () => {
  it('maps CCXT open-order rows onto private delta shape with decimal strings', () => {
    const row = parseOpenOrder(
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        clientOrderId: 'cli-1',
        symbol: 'BTC/USDT',
        type: 'limit',
        side: 'buy',
        status: 'open',
        price: '64000.5',
        amount: '1.5',
        filled: '0',
        datetime: '2026-07-31T00:00:00.000Z',
      },
      USER,
    );
    expect(row.orderId).toBe('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect(row.qty).toBe('1.5');
    expect(row.filledQty).toBe('0');
    expect(row.price).toBe('64000.5');
    expect(row.userId).toBe(USER);
  });

  it('refuses a JSON-number price (no fabricated mids)', () => {
    expect(() =>
      parseOpenOrder(
        {
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          symbol: 'BTC/USDT',
          type: 'limit',
          side: 'buy',
          status: 'open',
          price: 64000.5,
          amount: '1',
          filled: '0',
        },
        USER,
      ),
    ).toThrow(PrivateBookError);
  });

  it('refuses a JSON-number mark on positions', () => {
    expect(() =>
      parseOpenPosition(
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          symbol: 'BTC/USDT:USDT',
          side: 'long',
          status: 'open',
          contracts: '1',
          entryPrice: '100',
          markPrice: 101,
          notional: '101',
        },
        USER,
      ),
    ).toThrow(PrivateBookError);
  });

  it('refuses a blank or unrecognized position status and keeps the four known statuses', () => {
    const row = (status: unknown) => ({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      symbol: 'BTC/USDT:USDT',
      side: 'long',
      status,
      contracts: '1',
      entryPrice: '100',
      notional: '101',
    });
    expect(() => parseOpenPosition(row(''), USER)).toThrow(PrivateBookError);
    expect(() => parseOpenPosition(row(undefined), USER)).toThrow(PrivateBookError);
    expect(() => parseOpenPosition(row('mystery'), USER)).toThrow(PrivateBookError);
    for (const status of ['open', 'closing', 'closed', 'liquidated'] as const) {
      expect(parseOpenPosition(row(status), USER).status).toBe(status);
    }
  });

  it('keeps a missing or null fundingPaid null and parses a decimal-string funding figure', () => {
    const row = (fundingPaid?: unknown) => {
      const base: Record<string, unknown> = {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        symbol: 'BTC/USDT:USDT',
        side: 'long',
        status: 'open',
        contracts: '1',
        entryPrice: '100',
        notional: '101',
      };
      if (fundingPaid !== undefined) base.fundingPaid = fundingPaid;
      return base;
    };
    expect(parseOpenPosition(row(), USER).fundingPaid).toBeNull();
    expect(parseOpenPosition(row(null), USER).fundingPaid).toBeNull();
    expect(parseOpenPosition(row('0'), USER).fundingPaid).toBe('0');
    expect(parseOpenPosition(row('-0.004'), USER).fundingPaid).toBe('-0.004');
  });
});

describe('HttpPrivateBookPort', () => {
  it('forwards the access token to GET /api/v1/orders/open', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            symbol: 'btc-usdt',
            type: 'limit',
            side: 'buy',
            status: 'open',
            price: '100',
            amount: '1',
            filled: '0',
            datetime: '2026-07-31T00:00:00.000Z',
          },
        ]),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const port = new HttpPrivateBookPort({ baseUrl: `http://127.0.0.1:${addr.port}` });
    const orders = await port.listOpenOrders({ accessToken: 'tok', userId: USER });
    expect(orders).toHaveLength(1);
    expect(orders[0]!.qty).toBe('1');
    expect(seen[0]).toContain('GET /api/v1/orders/open Bearer tok');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns [] when trade REST is down — not a fabricated book', async () => {
    const port = new HttpPrivateBookPort({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 50 });
    await expect(port.listOpenOrders({ accessToken: 'tok', userId: USER })).resolves.toEqual([]);
  });

  it('returns [] when a row carries a numeric mid', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            symbol: 'btc-usdt',
            type: 'limit',
            side: 'buy',
            status: 'open',
            price: 64000.5,
            amount: '1',
            filled: '0',
          },
        ]),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const port = new HttpPrivateBookPort({ baseUrl: `http://127.0.0.1:${addr.port}` });
    await expect(port.listOpenOrders({ accessToken: 'tok', userId: USER })).resolves.toEqual([]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
