import { parseAmount } from '@intafaced/ledger-client/money';
import type { HttpPort, HttpResponse } from '../transport.js';
export const json = (status: number, body: unknown): HttpResponse => ({ status, body, header: () => null });
export class RecHttp implements HttpPort {
  posts: string[] = [];
  constructor(private book: unknown) {}
  async get() {
    return json(200, this.book);
  }
  async post(url: string) {
    this.posts.push(url);
    return json(500, { code: '1', retCode: 1, msg: 'x' });
  }
}
export const marketPostOnly = {
  symbol: 'BTC/USDT',
  side: 'buy' as const,
  type: 'market' as const,
  amount: parseAmount('1'),
  clientOrderId: 'abc',
  postOnly: true,
};
