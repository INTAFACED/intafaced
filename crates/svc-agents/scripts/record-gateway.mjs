// Records, from the TypeScript svc-agents in this checkout, what the Rust gateway slice is held to
// (`tests/gateway_parity.rs`), into `tests/fixtures/gateway-parity.golden.json`:
//
// - `tables`: `parseRoutingTable` on a set of configured tables: the table it returns, or that it refuses.
// - `mock`: the deterministic mock's completion (text, token counts, stop reason) and embedding for a set of requests,
//   and `digestOf` the gateway's request built from each (the route's ceiling clamping the caller's).
// - `upstream`: the HTTP upstream adapter through the gateway, its `fetch` replaced: the request it sends (URL, headers,
//   body), and for each answer the result or the gateway's refusal (code, copy key, message), with its health after.
// - `ready`: `agentsReadiness` as `/ready` builds it (the boot's product agents, the fleet card, the live planes) for a
//   set of providers and tables.
// - `list`: `routes.list` through the router for a set of tables, providers and metering switches.
//
// Run from the repository root, with the workspace packages built (`pnpm --filter "@intafaced/svc-agents^..." build`):
//   TZ=UTC node --import tsx crates/svc-agents/scripts/record-gateway.mjs          writes the file
//   TZ=UTC node --import tsx crates/svc-agents/scripts/record-gateway.mjs --check  fails when it is stale
//
// It stops being runnable when the TypeScript service is deleted, and from then on what it wrote is the reference.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CRATE = fileURLToPath(new URL('../', import.meta.url));
const SVC = `${ROOT}services/svc-agents/src/`;
const NAME = 'record-gateway';
if (!existsSync(SVC)) {
  console.error(`${NAME}: services/svc-agents no longer exists; the file it wrote is the reference now.`);
  process.exit(2);
}
const CHECK = process.argv.includes('--check');
if (process.env.TZ !== 'UTC') {
  console.error(`${NAME}: run with TZ=UTC`);
  process.exit(2);
}
process.env.INTAFACED_UNSIGNED_SANCTIONS_ROWS = 'off';
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';
process.env.INTAFACED_SCREENING_FAIL_CLOSED = 'off';

const { parseRoutingTable, unpricedTable, DEFAULT_ROUTING_TABLE } = await import(`${SVC}gateway/routing.ts`);
const { ModelGateway, digestOf } = await import(`${SVC}gateway/gateway.ts`);
const { MockModelProvider } = await import(`${SVC}providers/mock.ts`);
const { UpstreamModelProvider } = await import(`${SVC}providers/upstream.ts`);
const { ProviderError, AgentError } = await import(`${SVC}errors.ts`);
const { agentsReadiness } = await import(`${SVC}readiness.ts`);
const { fleetMatrixBoardCard, FLEET_PRODUCT_AGENTS } = await import(`${SVC}fleet/matrix.ts`);
const { describeAgentsLivePlanes } = await import(`${SVC}live-planes.ts`);
const { createAgentsRouter } = await import(`${SVC}router.ts`);
const { NO_TIER_LAWS } = await import(`${SVC}tier-laws.ts`);
const fromService = createRequire(`${SVC}index.ts`);
const load = (name) => import(pathToFileURL(fromService.resolve(name)).href);
const { createEdgeContext, encodePrincipal, signPrincipalHeader } = await load('@intafaced/contracts');
const { formatAmount } = await load('@intafaced/ledger-client');

const tableView = (t) => ({
  routes: t.routes.map((r) => ({
    task: r.task,
    providerId: r.providerId,
    model: r.model,
    maxOutputTokens: r.maxOutputTokens,
    capability: r.capability,
    price: r.price
      ? { inputPerMillion: formatAmount(r.price.inputPerMillion), outputPerMillion: formatAmount(r.price.outputPerMillion) }
      : null,
  })),
  fallbackTask: t.fallbackTask ?? null,
});

// ── Tables ─────────────────────────────────────────────────────────────────

const route = (over = {}) => ({
  task: 'a.task',
  providerId: 'primary',
  model: 'reasoning-md',
  maxOutputTokens: 100,
  price: { inputPerMillion: '1', outputPerMillion: '5' },
  ...over,
});
const tableInputs = [
  { routes: [route()] },
  { routes: [route({ capability: 'embed', extra: true })], extra: 1 },
  {
    routes: [route(), route({ task: 'b.task', price: { inputPerMillion: '0.000000000000000001', outputPerMillion: '0' } })],
    fallbackTask: 'b.task',
  },
  { routes: [route({ maxOutputTokens: 1_000_000 })] },
  { routes: [route({ maxOutputTokens: 5.0 })] },
  { routes: [route({ task: 'x'.repeat(120) })] },
  { routes: [route({ task: '😀'.repeat(60) })] },
  { routes: [route({ task: '😀'.repeat(61) })] },
  { routes: [route({ task: 'x'.repeat(121) })] },
  { routes: [route({ providerId: '' })] },
  { routes: [route({ model: 'm'.repeat(201) })] },
  { routes: [route({ maxOutputTokens: 0 })] },
  { routes: [route({ maxOutputTokens: 1_000_001 })] },
  { routes: [route({ maxOutputTokens: 1.5 })] },
  { routes: [route({ maxOutputTokens: '10' })] },
  { routes: [route({ price: { inputPerMillion: '1.', outputPerMillion: '5' } })] },
  { routes: [route({ price: { inputPerMillion: '-1', outputPerMillion: '5' } })] },
  { routes: [route({ price: { inputPerMillion: '1e3', outputPerMillion: '5' } })] },
  { routes: [route({ price: { inputPerMillion: '0.1234567890123456789', outputPerMillion: '5' } })] },
  { routes: [route({ price: { inputPerMillion: 1, outputPerMillion: '5' } })] },
  { routes: [route({ price: null })] },
  { routes: [route({ capability: 'chat' })] },
  { routes: [route({ capability: null })] },
  { routes: [route(), route()] },
  { routes: [route()], fallbackTask: 'nope' },
  { routes: [route()], fallbackTask: '' },
  { routes: [route()], fallbackTask: null },
  { routes: [] },
  { routes: {} },
  {},
  [],
  'text',
];
const tables = tableInputs.map((input) => {
  const text = JSON.stringify(input);
  try {
    return { text, table: tableView(parseRoutingTable(JSON.parse(text))) };
  } catch {
    return { text, table: null };
  }
});

// ── The mock and the request digest ─────────────────────────────────────────

const mockRequests = [
  { task: 'own.run', request: { messages: [{ role: 'user', content: 'hello' }] } },
  {
    task: 'own.run',
    request: {
      system: 'You are terse.',
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ],
    },
  },
  {
    task: 'support.classify',
    request: { system: '', messages: [{ role: 'user', content: 'Grüße 😀 — “quoted”\n\ttab' }], maxOutputTokens: 9999 },
  },
  {
    task: 'support.classify',
    request: {
      messages: [{ role: 'user', content: 'x'.repeat(4001) }],
      maxOutputTokens: 3,
      temperature: 0.7,
      stopSequences: ['END', '\u0000'],
    },
  },
  { task: 'navigator.plan', request: { messages: [], maxOutputTokens: 1 } },
  { task: 'index.embed', request: { messages: [{ role: 'user', content: 'embed me' }] } },
];
const mock = [];
for (const { task, request } of mockRequests) {
  const provider = new MockModelProvider({ id: 'primary' });
  const gateway = new ModelGateway([provider], DEFAULT_ROUTING_TABLE);
  const r = gateway.routeFor(task);
  const built = {
    model: r.model,
    ...(request.system ? { system: request.system } : {}),
    messages: request.messages,
    maxOutputTokens: request.maxOutputTokens === undefined ? r.maxOutputTokens : Math.min(request.maxOutputTokens, r.maxOutputTokens),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.stopSequences ? { stopSequences: request.stopSequences } : {}),
  };
  const { result } = await gateway.complete(task, request);
  const inputs = request.messages.map((m) => m.content);
  const embedded = await provider.embed({ model: r.model, inputs });
  mock.push({ task, request, digest: digestOf(built), result, embed: { inputs, vectors: embedded.vectors, usage: embedded.usage } });
}

// ── The upstream through the gateway ────────────────────────────────────────

const upstreamConfig = {
  id: 'primary',
  baseUrl: 'https://engine.test/',
  apiKey: 'placeholder-upstream-key',
  authHeader: 'authorization',
  authPrefix: 'Bearer ',
  headers: { 'x-protocol': '2', accept: 'application/json; v=2' },
  models: { 'reasoning-md': 'engine-model-7' },
  timeoutMs: 5000,
};
const answers = [
  {
    status: 200,
    body: {
      content: [{ type: 'text', text: 'Hi' }, { type: 'tool_use', text: 'no' }, { text: ' there' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 3 },
    },
  },
  {
    status: 200,
    body: { content: [{ type: 'text', text: 'x' }], stop_reason: 'length', usage: { prompt_tokens: 5, completion_tokens: 7 } },
  },
  { status: 200, body: { content: null, stop_reason: 'refusal', usage: { input_tokens: 0, output_tokens: 0 } } },
  { status: 200, body: { content: [], stop_reason: 'weird', usage: { input_tokens: 1, output_tokens: 1 } } },
  { status: 200, body: { content: [], usage: { input_tokens: 1 } } },
  { status: 200, body: { content: [], usage: { input_tokens: 1.5, output_tokens: 1 } } },
  { status: 200, body: { content: [], usage: { input_tokens: -1, output_tokens: 1 } } },
  { status: 200, body: { content: [] } },
  { status: 200, body: { content: 'text', usage: { input_tokens: 1, output_tokens: 1 } } },
  { status: 200, raw: 'not json' },
  { status: 429, body: { error: 'slow down' } },
  { status: 500, body: {} },
  { status: 400, body: {} },
  { throws: true },
];
const upstreamRequest = {
  system: 'Be exact.',
  messages: [{ role: 'user', content: 'What is 2+2?' }],
  maxOutputTokens: 64,
  temperature: 0.25,
  stopSequences: ['\n\n'],
};
const errorView = (err) =>
  err instanceof AgentError ? { code: err.code, userMessageKey: err.userMessageKey, message: err.message } : { other: String(err) };
const healthView = (h) => ({ healthy: h.healthy, reason: h.reason ?? null });
const upstream = [];
const realFetch = globalThis.fetch;
try {
  for (const answer of answers) {
    const sent = [];
    globalThis.fetch = async (url, init) => {
      sent.push({ url, headers: Object.entries(init.headers), body: init.body });
      if (answer.throws) throw new TypeError('fetch failed');
      const text = answer.raw ?? JSON.stringify(answer.body);
      return new Response(text, { status: answer.status, headers: { 'content-type': 'application/json' } });
    };
    const provider = new UpstreamModelProvider(upstreamConfig);
    const gateway = new ModelGateway([provider], DEFAULT_ROUTING_TABLE);
    let outcome;
    try {
      outcome = { result: (await gateway.complete('own.run', upstreamRequest)).result };
    } catch (err) {
      outcome = { error: errorView(err) };
    }
    upstream.push({ answer, sent, ...outcome, health: healthView(provider.health()) });
  }
  // Three failures in a row mark the upstream unhealthy; the gateway then refuses before it calls.
  {
    const sent = [];
    globalThis.fetch = async (url, init) => {
      sent.push({ url, headers: Object.entries(init.headers), body: init.body });
      return new Response('{}', { status: 503 });
    };
    const provider = new UpstreamModelProvider(upstreamConfig);
    const gateway = new ModelGateway([provider], DEFAULT_ROUTING_TABLE);
    const errors = [];
    for (let i = 0; i < 4; i++) {
      try {
        await gateway.complete('own.run', upstreamRequest);
      } catch (err) {
        errors.push(errorView(err));
      }
    }
    upstream.push({ outage: true, calls: sent.length, errors, health: healthView(provider.health()) });
  }
} finally {
  globalThis.fetch = realFetch;
}

// ── /ready ──────────────────────────────────────────────────────────────────

const livePlanesEnv = {
  TRADE_URL: 'http://trade',
  PAY_URL: '  ',
  ACADEMY_URL: 'http://academy',
  LIVE_TRADE_COPY_LEADER_PLANE_OPEN: ' true ',
  LIVE_TRADE_COPY_LEADER_IDS: ' a, ,b,c ',
};
const productAgentsRegistered = FLEET_PRODUCT_AGENTS.length;
const readyCases = [
  {
    name: 'mock, the unpriced default',
    mode: 'mock',
    providers: () => [new MockModelProvider({ id: 'primary' })],
    table: unpricedTable(DEFAULT_ROUTING_TABLE),
    metering: true,
  },
  {
    name: 'mock, metering off, no product agents',
    mode: 'mock',
    providers: () => [new MockModelProvider({ id: 'primary' })],
    table: DEFAULT_ROUTING_TABLE,
    metering: false,
    agents: 0,
  },
  {
    name: 'mock that is down',
    mode: 'mock',
    providers: () => [new MockModelProvider({ id: 'primary', failWith: new ProviderError('engine outage (test)', 'primary', true, 503) })],
    table: DEFAULT_ROUTING_TABLE,
    metering: true,
  },
  {
    name: 'upstream, unprobed',
    mode: 'upstream',
    providers: () => [new UpstreamModelProvider({ ...upstreamConfig, embeddingsPath: '/v1/embed' })],
    table: DEFAULT_ROUTING_TABLE,
    metering: true,
  },
  {
    name: 'a route naming an unregistered provider first',
    mode: 'mock',
    providers: () => [new MockModelProvider({ id: 'primary', capabilities: ['embed'] })],
    table: parseRoutingTable({ routes: [route({ task: 'z', providerId: 'elsewhere' }), route({ task: 'y' })] }),
    metering: true,
  },
  { name: 'no routes', mode: 'mock', providers: () => [], table: { routes: [] }, metering: true },
  {
    name: 'only an embedding route',
    mode: 'mock',
    providers: () => [new MockModelProvider({ id: 'primary' })],
    table: parseRoutingTable({ routes: [route({ capability: 'embed' })] }),
    metering: true,
  },
];
const ready = readyCases.map((c) => ({
  name: c.name,
  mode: c.mode,
  metering: c.metering,
  table: tableView(c.table),
  body: JSON.parse(
    JSON.stringify(
      agentsReadiness({
        providerMode: c.mode,
        providers: c.providers(),
        table: c.table,
        meteringEnabled: c.metering,
        productAgentsRegistered: c.agents ?? productAgentsRegistered,
        fleet: fleetMatrixBoardCard(),
        livePlanes: describeAgentsLivePlanes(livePlanesEnv),
      }),
    ),
  ),
}));

// ── routes.list through the router ──────────────────────────────────────────

const SECRET = 'placeholder-agents-record-gateway-edge-secret';
const ctx = () => {
  const raw = encodePrincipal({
    sub: '11111111-1111-4111-8111-111111111111',
    userId: '11111111-1111-4111-8111-111111111111',
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['agents:read'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  });
  return createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' })({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-record-gateway',
  });
};
const listCases = [
  { name: 'mock, the unpriced default, metering unset', provider: 'mock', table: unpricedTable(DEFAULT_ROUTING_TABLE) },
  { name: 'mock, the default rates, metering on', provider: 'mock', table: DEFAULT_ROUTING_TABLE, metering: true },
  { name: 'upstream, the default rates, metering off', provider: 'upstream', table: DEFAULT_ROUTING_TABLE, metering: false },
  {
    name: 'no provider for a route, a zero rate',
    provider: 'mock',
    table: parseRoutingTable({
      routes: [route({ providerId: 'elsewhere' }), route({ task: 'zero', price: { inputPerMillion: '0', outputPerMillion: '0' } })],
    }),
  },
];
const list = [];
for (const c of listCases) {
  const providers = c.provider === 'mock' ? [new MockModelProvider({ id: 'primary' })] : [new UpstreamModelProvider(upstreamConfig)];
  const router = createAgentsRouter({
    runtime: {},
    gateway: new ModelGateway(providers, c.table),
    meter: {},
    feeAssetId: 'USDC',
    tierLaws: NO_TIER_LAWS,
    ...(c.metering === undefined ? {} : { meteringEnabled: c.metering }),
  });
  list.push({
    name: c.name,
    provider: c.provider,
    metering: c.metering ?? null,
    table: tableView(c.table),
    answer: await router.createCaller(ctx()).routes.list(),
  });
}

const golden = {
  tables,
  mock,
  upstream: { config: upstreamConfig, request: upstreamRequest, cases: upstream },
  ready,
  list,
  livePlanesEnv,
};
const file = `${CRATE}tests/fixtures/gateway-parity.golden.json`;
const PRETTIER = fileURLToPath(new URL('../../../node_modules/.bin/prettier', import.meta.url));
const text = execFileSync(PRETTIER, ['--stdin-filepath', file], {
  input: `${JSON.stringify(golden)}\n`,
  encoding: 'utf8',
  maxBuffer: 1 << 26,
});
if (CHECK) {
  let was = '';
  try {
    was = readFileSync(file, 'utf8');
  } catch {}
  if (was !== text) {
    console.error(`stale: ${file.slice(ROOT.length)}`);
    process.exit(1);
  }
  console.log(`${NAME}: up to date`);
} else {
  writeFileSync(file, text);
  console.log(
    `${NAME}: ${tables.length} tables, ${mock.length} mock requests, ${upstream.length} upstream cases, ${ready.length} readiness cases, ${list.length} lists`,
  );
}
