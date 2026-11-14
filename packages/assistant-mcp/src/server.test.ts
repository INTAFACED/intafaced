import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGENT_ORDERS_ROUTE,
  PLACE_ORDER_TOOL,
  configFromEnv,
  createAssistantServer,
  orderArgumentsProblem,
  signedHeaders,
  type AssistantConfig,
} from './server.js';

const CONFIG: AssistantConfig = { apiUrl: 'https://edge.test', agentKey: 'ifc_agent_TEST', signingSecret: 'TEST-secret' };
const ORDER = {
  clientOrderId: 'spot-buy',
  symbol: 'BTC-USDC',
  side: 'buy',
  type: 'market',
  amount: '0.0005',
  price: '60100',
  timeInForce: 'IOC',
};

interface Seen {
  url: string;
  init: RequestInit;
}
function fakeApi(status: number, body: unknown, seen: Seen[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
const call = (args: unknown) => ({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'place_order', arguments: args } });

describe('the assistant MCP server', () => {
  it('answers initialize with its tools capability and the protocol revision asked for, and the newest for any other', async () => {
    const handle = createAssistantServer(CONFIG, fakeApi(200, {}));
    const known = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    expect(known?.result).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'intafaced-assistant' },
    });
    const other = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(other?.result).toMatchObject({ protocolVersion: '2025-06-18' });
  });

  it('never answers a notification, and refuses an unknown method or tool', async () => {
    const handle = createAssistantServer(CONFIG, fakeApi(200, {}));
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect((await handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' }))?.error?.code).toBe(-32601);
    const tool = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'withdraw', arguments: {} } });
    expect(tool?.error).toMatchObject({ code: -32602, message: 'no tool named withdraw' });
    expect((await handle({ id: 5, method: 'ping' }))?.error?.code).toBe(-32600);
  });

  it('lists the one order tool, its amounts as decimal strings', async () => {
    const handle = createAssistantServer(CONFIG, fakeApi(200, {}));
    const listed = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))?.result as { tools: (typeof PLACE_ORDER_TOOL)[] };
    expect(listed.tools.map((t) => t.name)).toEqual(['place_order']);
    expect(listed.tools[0]!.inputSchema.properties.amount.type).toBe('string');
    expect(listed.tools[0]!.inputSchema.properties.price.type).toBe('string');
  });

  it('sends the order once to the assistant route, with the agent key and the request signature our API checks', async () => {
    const seen: Seen[] = [];
    const answer = { state: 'accepted', origin: 'agent:00000000-0000-4000-8000-000000000000', order: { status: 'filled' } };
    const handle = createAssistantServer(CONFIG, fakeApi(200, answer, seen));
    const res = await handle(call(ORDER));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`https://edge.test${AGENT_ORDERS_ROUTE}`);
    expect(seen[0]!.init.method).toBe('POST');
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer ifc_agent_TEST');
    // No Origin: the assistant is an outside client, not a page.
    expect(headers.origin).toBeUndefined();
    const body = String(seen[0]!.init.body);
    expect(JSON.parse(body)).toEqual(ORDER);
    const canonical = [
      'INTAFACED-REQ-V1',
      'POST',
      AGENT_ORDERS_ROUTE,
      headers['x-intafaced-request-timestamp'],
      headers['x-intafaced-request-nonce'],
      createHash('sha256').update(body).digest('hex'),
    ].join('\n');
    expect(headers['x-intafaced-request-signature']).toBe(createHmac('sha256', 'TEST-secret').update(canonical).digest('hex'));
    expect(res?.result).toMatchObject({ isError: false, structuredContent: answer });
  });

  it('sends no signature for a key made without a signing secret', async () => {
    const seen: Seen[] = [];
    await createAssistantServer({ ...CONFIG, signingSecret: null }, fakeApi(200, {}, seen))(call(ORDER));
    expect(Object.keys(seen[0]!.init.headers as object)).toEqual(['authorization', 'content-type']);
  });

  it('hands back our typed refusal as the tool error, words and code as our API said them', async () => {
    const refusal = {
      code: 'InvalidOrder',
      intafacedCode: 'agents.order_size_cap_exceeded',
      cap: '50',
      message: 'over the per-order size cap of 50 USDC',
    };
    const res = await createAssistantServer(CONFIG, fakeApi(422, refusal))(call(ORDER));
    expect(res?.result).toMatchObject({ isError: true, structuredContent: refusal });
    const revoked = await createAssistantServer(CONFIG, fakeApi(401, { intafacedCode: 'auth.api_key_revoked' }))(call(ORDER));
    expect(revoked?.result).toMatchObject({ isError: true, structuredContent: { intafacedCode: 'auth.api_key_revoked' } });
  });

  it('refuses before sending anything: a number amount, an unknown argument, a missing field, a blank configuration', async () => {
    const seen: Seen[] = [];
    const handle = createAssistantServer(CONFIG, fakeApi(200, {}, seen));
    for (const [args, words] of [
      [{ ...ORDER, amount: 0.0005 }, 'amount must be a string'],
      [{ ...ORDER, amount: '1e-4' }, 'amount must be a decimal string such as "0.001"'],
      [{ ...ORDER, destination: '0xabc' }, 'destination is not an argument of place_order'],
      [{ ...ORDER, side: 'short' }, 'side must be one of buy, sell'],
      [{ ...ORDER, clientOrderId: undefined }, 'clientOrderId is required'],
      ['buy', 'arguments must be an object'],
    ] as const) {
      const res = await handle(call(args));
      expect(res?.result, words).toMatchObject({
        isError: true,
        structuredContent: { code: 'assistant.invalid_arguments', message: words },
      });
    }
    const unset = await createAssistantServer({ missing: ['INTAFACED_AGENT_KEY'] }, fakeApi(200, {}, seen))(call(ORDER));
    expect(unset?.result).toMatchObject({ isError: true, structuredContent: { code: 'assistant.config_unset' } });
    expect(seen).toEqual([]);
  });

  it('says an unreachable API is unknown, to retry under the same clientOrderId', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const res = await createAssistantServer(CONFIG, down)(call(ORDER));
    expect(res?.result).toMatchObject({ isError: true, structuredContent: { code: 'assistant.api_unreachable' } });
  });

  it('reads its configuration from the environment, naming what is blank', () => {
    expect(
      configFromEnv({ INTAFACED_API_URL: 'https://edge.test/', INTAFACED_AGENT_KEY: 'k', INTAFACED_AGENT_SIGNING_SECRET: '' }),
    ).toEqual({
      apiUrl: 'https://edge.test',
      agentKey: 'k',
      signingSecret: null,
    });
    expect(configFromEnv({})).toEqual({ missing: ['INTAFACED_API_URL', 'INTAFACED_AGENT_KEY'] });
  });

  it('signs exactly as INTAFACED-REQ-V1 for a fixed time and nonce', () => {
    const h = signedHeaders('s', { method: 'post', path: '/p', body: '' }, '1700000000', 'n');
    const canonical = ['INTAFACED-REQ-V1', 'POST', '/p', '1700000000', 'n', createHash('sha256').update('').digest('hex')].join('\n');
    expect(h['x-intafaced-request-signature']).toBe(createHmac('sha256', 's').update(canonical).digest('hex'));
  });

  it('checks orderArgumentsProblem passes a whole perpetual order', () => {
    expect(orderArgumentsProblem({ ...ORDER, symbol: 'BTC-PERP', leverage: '2', reduceOnly: false })).toBeNull();
  });

  it('runs as its own process over stdio from its source, one answer per line', async () => {
    const hits: { path: string; auth: string; body: string }[] = [];
    const api = createServer((req: IncomingMessage, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        hits.push({ path: req.url ?? '', auth: String(req.headers.authorization), body });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ state: 'accepted' }));
      });
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    const port = (api.address() as AddressInfo).port;
    const child = spawn(process.execPath, [fileURLToPath(new URL('./server.ts', import.meta.url))], {
      env: { PATH: process.env.PATH, INTAFACED_API_URL: `http://127.0.0.1:${port}`, INTAFACED_AGENT_KEY: 'ifc_agent_TEST' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const lines: string[] = [];
      let buffer = '';
      const answered = (n: number) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`no answer ${n}: ${lines.join(' | ')}`)), 10_000);
          const check = () => {
            if (lines.length >= n) {
              clearTimeout(timer);
              resolve();
            } else setTimeout(check, 20);
          };
          check();
        });
      child.stdout.on('data', (c: Buffer) => {
        buffer += c.toString();
        let at: number;
        while ((at = buffer.indexOf('\n')) >= 0) {
          lines.push(buffer.slice(0, at));
          buffer = buffer.slice(at + 1);
        }
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      child.stdin.write(`${JSON.stringify(call(ORDER))}\n`);
      await answered(2);
      const [init, placed] = lines.map((l) => JSON.parse(l));
      expect(init).toMatchObject({ id: 1, result: { serverInfo: { name: 'intafaced-assistant' } } });
      expect(placed).toMatchObject({ id: 7, result: { isError: false, structuredContent: { state: 'accepted' } } });
      expect(hits).toEqual([{ path: AGENT_ORDERS_ROUTE, auth: 'Bearer ifc_agent_TEST', body: JSON.stringify(ORDER) }]);
    } finally {
      child.kill();
      api.close();
    }
  });
});
