import { defineCopy } from '../../../shared/i18n';

// /developers/quant (J-algo-dev-14; AL-api-01): Algo dev's strategy API, driven from your own code with an API key. The
// procedures and scopes are svc-quant's (services/svc-quant/src/key-api/key-api.ts); the live stop is svc-trade's
// (services/svc-trade/src/quant/live-run/rest.ts).
export const quantApiCopy = defineCopy('developers-quant', {
  lead: 'List your projects, start a backtest, read its report and stop a live strategy from your own code, with an API key.',
  keyTitle: 'A key for the strategy API',
  keyBody:
    'Make a key at API keys and tick only what it needs: quant:read to list and read, quant:run to start a backtest, trade:write to stop a live strategy. quant:run does not include quant:read. A key sees only your own account’s projects and runs.',
  endpointsTitle: 'Endpoints',
  endpointsLead:
    'Send the key as Authorization: Bearer <key>. The quant endpoints take a tRPC input: a query as ?input=<JSON>, a mutation as a JSON body.',
  colMethod: 'Method',
  colPath: 'Path',
  colScope: 'Permission',
  colWhat: 'What it does',
  epList: 'Your projects (saved strategies), newest first; input { limit }',
  epGet: 'One project with its versions; input { id }',
  epHistory: 'Your backtest runs, newest first; input { limit }',
  epResult: 'One stored backtest run; input { runId }',
  epReport: 'A run’s report: its metrics and their labels; input { runId }',
  epStart: 'Start a backtest of one version; send an Idempotency-Key header',
  epLiveRuns: 'Your live strategy runs',
  epStop: 'Stop a live run: open orders are cancelled and the position is kept; the same seq again changes nothing',
  epLiquidate: 'Liquidate a live run: stop, then one reduce-only close per position',
  pyTitle: 'Python client',
  pyBody:
    'One Python module wraps these endpoints: list and read your projects and runs, start a backtest with your own Idempotency-Key, and stop or liquidate a live run. A refusal raises QuantApiError with the service’s code. Decimals stay strings, and a float in a request is refused. strategy_template() returns a Python strategy the sandbox runs. It needs Python 3.11 and nothing else.',
  pyInstall: 'Save it next to your code as intafaced_quant.py, then: from intafaced_quant import QuantClient, strategy_template',
  pyDownload: 'Download intafaced_quant.py',
  idemTitle: 'One run per Idempotency-Key',
  idemBody:
    'A backtest started with a key must carry an Idempotency-Key header: 1 to 128 visible characters with no spaces. The same key with the same request reads back the one stored run. The same key with a different request answers 409 quant.idempotency_key_reused and runs nothing. With no header it answers 400 quant.idempotency_key_required.',
  noDeployTitle: 'No deploy by key',
  noDeployBody:
    'There is no endpoint to deploy a strategy with an API key. A strategy goes live only from the screen, where you choose its account and your wallet signs. A key that asks answers 404 quant.key_no_such_endpoint, as does any quant endpoint not listed here, and nothing is stored.',
  rulesTitle: 'The same rules as the screen',
  rulesBody:
    'A stop or liquidate sent with a key goes through the same route as the Stop and Liquidate buttons, under the same sequence number, and reads back the venue’s own record of your account. Without trade:write the key is refused 403 scope.denied and nothing is sent. A quant endpoint the key lacks the permission for answers 403 scope.denied.',
  back: 'All developer docs',
});
