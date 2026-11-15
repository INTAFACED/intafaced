/**
 * The strategy API's endpoints as the reference publishes them (J-algo-dev-14). The quant rows mirror svc-quant's
 * `QUANT_KEY_API` (services/svc-quant/src/key-api/key-api.ts; both sides assert the same table); the live rows are
 * svc-trade's live-run routes (services/svc-trade/src/quant/live-run/rest.ts), under the key plane's trade scopes.
 */
export type QuantApiEndpoint = {
  method: 'GET' | 'POST';
  path: string;
  /** The svc-quant procedure, for a quant row. */
  procedure?: string;
  scope: 'quant:read' | 'quant:run' | 'trade:read' | 'trade:write';
  what: 'epList' | 'epGet' | 'epHistory' | 'epResult' | 'epReport' | 'epStart' | 'epLiveRuns' | 'epStop' | 'epLiquidate';
};

const quant = (method: 'GET' | 'POST', procedure: string, scope: 'quant:read' | 'quant:run', what: QuantApiEndpoint['what']) => ({
  method,
  path: `/api/quant/trpc/${procedure}`,
  procedure,
  scope,
  what,
});

export const QUANT_API_ENDPOINTS: readonly QuantApiEndpoint[] = [
  quant('GET', 'studio.list', 'quant:read', 'epList'),
  quant('GET', 'studio.get', 'quant:read', 'epGet'),
  quant('GET', 'backtest.history', 'quant:read', 'epHistory'),
  quant('GET', 'backtest.result', 'quant:read', 'epResult'),
  quant('GET', 'backtest.report', 'quant:read', 'epReport'),
  quant('POST', 'backtest.start', 'quant:run', 'epStart'),
  { method: 'GET', path: '/api/v1/quant/live-runs', scope: 'trade:read', what: 'epLiveRuns' },
  { method: 'POST', path: '/api/v1/quant/live-runs/:id/stop', scope: 'trade:write', what: 'epStop' },
  { method: 'POST', path: '/api/v1/quant/live-runs/:id/liquidate', scope: 'trade:write', what: 'epLiquidate' },
];
