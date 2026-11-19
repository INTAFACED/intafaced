#!/usr/bin/env node
/**
 * The MCP server for a person's own outside assistant (DV-tools-02, J-agents-21 #7). The assistant runs it on its own
 * machine over stdio, with the person's agent key, and calls its tools; each tool is one call to our API through Edge,
 * signed with the key's signing secret exactly as any API client signs it (INTAFACED-REQ-V1). It holds no state and no
 * money: what an agent key may do is decided by our services, never here.
 *
 *   INTAFACED_API_URL=<Edge base URL> INTAFACED_AGENT_KEY=<key> INTAFACED_AGENT_SIGNING_SECRET=<secret> \
 *     node packages/assistant-mcp/src/server.ts
 *
 * One file with only Node's own modules and erasable types, so Node runs the source as it is (type stripping) and the
 * build only adds the compiled copy.
 *
 * Tools:
 *   place_order   the assistant's spot or perpetual order on its own agent account (POST /api/v1/venue/agent/orders):
 *                 the agent key reaches that route and no other (a move, withdrawal, bank, card or other-account call
 *                 refuses `auth.scope_denied` at our API, J-agents-21 #9). An order past the person's caps, or one the
 *                 venue refuses, comes back as the tool's error with our typed code and words.
 *
 * Protocol: MCP over stdio, one JSON-RPC 2.0 message per line (initialize, ping, tools/list, tools/call). Amounts are
 * decimal strings, never numbers. Nothing here prints the key or its secret; a refusal carries only what our API said.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const SERVER_NAME = 'intafaced-assistant';
export const SERVER_VERSION = '0.0.0';
/** The protocol revisions this server speaks, newest first; a client asking for another gets the newest. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const AGENT_ORDERS_ROUTE = '/api/v1/venue/agent/orders';

export interface AssistantConfig {
  /** Edge's base URL, e.g. `https://api.example`; no trailing path. */
  readonly apiUrl: string;
  readonly agentKey: string;
  /** The key's signing secret, shown once with the key; `null` for a key made without one. */
  readonly signingSecret: string | null;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}
export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/** JSON-RPC's own error codes. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const DECIMAL = '^(0|[1-9][0-9]*)(\\.[0-9]+)?$';
const DECIMAL_RE = new RegExp(DECIMAL);

/** The one tool: its name, words and input schema, as tools/list shows them. */
export const PLACE_ORDER_TOOL = {
  name: 'place_order',
  title: 'Place an order on your agent account',
  description:
    'Places one spot or perpetual order on the agent account this key trades, and only there. Amounts and prices are decimal strings. ' +
    'An opening perpetual names its leverage and opens isolated; a spot order takes no leverage. The same clientOrderId is the same order: ' +
    'sending it again never places a second one. Orders past the account owner’s caps, or that the venue refuses, are refused with a reason.',
  inputSchema: {
    type: 'object',
    properties: {
      clientOrderId: { type: 'string', minLength: 1, maxLength: 64, description: 'Your own id for this order; reuse it to retry.' },
      symbol: { type: 'string', minLength: 1, description: 'The market, e.g. BTC-USDC (spot) or BTC-PERP (perpetual).' },
      side: { type: 'string', enum: ['buy', 'sell'] },
      type: { type: 'string', enum: ['market', 'limit'] },
      amount: { type: 'string', pattern: DECIMAL, description: 'Size in the base asset, as a decimal string.' },
      price: { type: 'string', pattern: DECIMAL, description: 'Limit price, or a market order’s worst price, as a decimal string.' },
      timeInForce: { type: 'string', enum: ['GTC', 'IOC', 'ALO'] },
      leverage: { type: 'string', pattern: DECIMAL, description: 'An opening perpetual’s leverage, e.g. "2". Not taken on spot.' },
      reduceOnly: { type: 'boolean', description: 'A perpetual order that only closes. Not taken on spot.' },
    },
    required: ['clientOrderId', 'symbol', 'side', 'type', 'amount', 'price', 'timeInForce'],
    additionalProperties: false,
  },
} as const;

const ORDER_FIELDS = Object.keys(PLACE_ORDER_TOOL.inputSchema.properties);

/** Why an order's arguments can't be sent, in words, or `null` when they can. */
export function orderArgumentsProblem(args: unknown): string | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'arguments must be an object';
  const a = args as Record<string, unknown>;
  for (const key of Object.keys(a)) if (!ORDER_FIELDS.includes(key)) return `${key} is not an argument of place_order`;
  for (const key of PLACE_ORDER_TOOL.inputSchema.required) if (a[key] === undefined) return `${key} is required`;
  const props = PLACE_ORDER_TOOL.inputSchema.properties;
  for (const key of ['clientOrderId', 'symbol', 'side', 'type', 'amount', 'price', 'timeInForce', 'leverage'] as const) {
    const value = a[key];
    if (value === undefined) continue;
    // Never a number: an amount travels as a decimal string, so nothing is rounded on the way.
    if (typeof value !== 'string') return `${key} must be a string`;
    const prop = props[key] as { enum?: readonly string[]; pattern?: string; minLength?: number; maxLength?: number };
    if (prop.enum && !prop.enum.includes(value)) return `${key} must be one of ${prop.enum.join(', ')}`;
    if (prop.pattern && !DECIMAL_RE.test(value)) return `${key} must be a decimal string such as "0.001"`;
    if (prop.minLength !== undefined && value.length < prop.minLength) return `${key} must not be empty`;
    if (prop.maxLength !== undefined && value.length > prop.maxLength) return `${key} is longer than ${prop.maxLength} characters`;
  }
  if (a.reduceOnly !== undefined && typeof a.reduceOnly !== 'boolean') return 'reduceOnly must be true or false';
  return null;
}

/** The request-signing headers our API checks on a key with a signing secret (INTAFACED-REQ-V1). */
export function signedHeaders(
  secret: string,
  req: { method: string; path: string; body: string },
  timestamp: string = String(Math.floor(Date.now() / 1000)),
  nonce: string = randomUUID(),
): Record<string, string> {
  const digest = createHash('sha256').update(req.body).digest('hex');
  const canonical = ['INTAFACED-REQ-V1', req.method.toUpperCase(), req.path, timestamp, nonce, digest].join('\n');
  return {
    'x-intafaced-request-timestamp': timestamp,
    'x-intafaced-request-nonce': nonce,
    'x-intafaced-request-signature': createHmac('sha256', secret).update(canonical).digest('hex'),
  };
}

/** The server's configuration from its environment; a blank one refuses in words, naming what is missing. */
export function configFromEnv(env: Record<string, string | undefined>): AssistantConfig | { readonly missing: readonly string[] } {
  const apiUrl = (env.INTAFACED_API_URL ?? '').trim().replace(/\/+$/, '');
  const agentKey = (env.INTAFACED_AGENT_KEY ?? '').trim();
  const secret = (env.INTAFACED_AGENT_SIGNING_SECRET ?? '').trim();
  const missing = [...(apiUrl === '' ? ['INTAFACED_API_URL'] : []), ...(agentKey === '' ? ['INTAFACED_AGENT_KEY'] : [])];
  if (missing.length > 0) return { missing };
  return { apiUrl, agentKey, signingSecret: secret === '' ? null : secret };
}

interface ToolResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent?: { [key: string]: Json };
  readonly isError: boolean;
}

const textResult = (value: Json, isError: boolean): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  ...(typeof value === 'object' && value !== null && !Array.isArray(value) ? { structuredContent: value } : {}),
  isError,
});

/**
 * The server: one handler per JSON-RPC message, its answer or `null` for a notification. `fetchImpl` is the network,
 * so a test can stand in for our API.
 */
export function createAssistantServer(config: AssistantConfig | { readonly missing: readonly string[] }, fetchImpl: typeof fetch = fetch) {
  async function placeOrder(args: unknown): Promise<ToolResult> {
    if ('missing' in config) {
      return textResult({ code: 'assistant.config_unset', message: `set ${config.missing.join(' and ')} before calling a tool` }, true);
    }
    const problem = orderArgumentsProblem(args);
    if (problem) return textResult({ code: 'assistant.invalid_arguments', message: problem }, true);
    const body = JSON.stringify(args);
    let res: Response;
    try {
      res = await fetchImpl(`${config.apiUrl}${AGENT_ORDERS_ROUTE}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.agentKey}`,
          'content-type': 'application/json',
          ...(config.signingSecret ? signedHeaders(config.signingSecret, { method: 'POST', path: AGENT_ORDERS_ROUTE, body }) : {}),
        },
        body,
      });
    } catch {
      // Unknown, not refused: the same clientOrderId sent again is the same order, never a second one.
      return textResult(
        { code: 'assistant.api_unreachable', message: 'our API did not answer; send the same clientOrderId again to retry' },
        true,
      );
    }
    const text = await res.text();
    let answer: Json;
    try {
      answer = JSON.parse(text) as Json;
    } catch {
      answer = { code: 'assistant.unreadable_answer', status: res.status, message: text.slice(0, 500) };
    }
    return textResult(answer, !res.ok);
  }

  return async function handle(message: unknown): Promise<JsonRpcResponse | null> {
    const req = message as Partial<JsonRpcRequest> | null;
    const id = req && (typeof req.id === 'string' || typeof req.id === 'number') ? req.id : null;
    if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return { jsonrpc: '2.0', id, error: { code: INVALID_REQUEST, message: 'not a JSON-RPC 2.0 request' } };
    }
    // A notification (no id) is never answered.
    const notification = req.id === undefined;
    const reply = (result: unknown): JsonRpcResponse | null => (notification ? null : { jsonrpc: '2.0', id, result });
    const fail = (code: number, text: string): JsonRpcResponse | null =>
      notification ? null : { jsonrpc: '2.0', id, error: { code, message: text } };
    const params = (req.params ?? {}) as Record<string, unknown>;
    switch (req.method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        return reply({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            'Trades only on the agent account your key is connected to. It cannot move money, withdraw, bank, pay or use cards.',
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: [PLACE_ORDER_TOOL] });
      case 'tools/call': {
        if (params.name !== PLACE_ORDER_TOOL.name) return fail(INVALID_PARAMS, `no tool named ${String(params.name)}`);
        return reply(await placeOrder(params.arguments ?? {}));
      }
      default:
        return fail(METHOD_NOT_FOUND, `no method ${req.method}`);
    }
  };
}

/** Run over stdio: one message per line in, one answer per line out; what goes wrong goes to stderr. */
export function serveStdio(handle: ReturnType<typeof createAssistantServer>): void {
  const lines = createInterface({ input: process.stdin });
  const out = (response: JsonRpcResponse) => process.stdout.write(`${JSON.stringify(response)}\n`);
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      out({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'not JSON' } });
      return;
    }
    void handle(message).then(
      (response) => {
        if (response) out(response);
      },
      (error: unknown) => process.stderr.write(`${SERVER_NAME}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configFromEnv(process.env);
  if ('missing' in config)
    process.stderr.write(`${SERVER_NAME}: set ${config.missing.join(' and ')}; every tool call refuses until then\n`);
  serveStdio(createAssistantServer(config));
}
