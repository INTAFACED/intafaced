import { quantMonteCarloSchema, type QuantMonteCarlo } from '@intafaced/contracts/quant-research';
import { useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { Button, DataTable, Failure, Field } from '../../shared/ui';
import { useApi } from '../session/session';
import { researchCopy } from './research-copy';
import { refusalCode } from './StrategyTeam';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const PERCENTILES = ['p5', 'p25', 'p50', 'p75', 'p95'] as const;

/**
 * Monte Carlo on one finished backtest (RC-algo-dev-04; J-algo-dev-16 #3): the run's closed round trips resampled by the
 * service under the person's seed, with drawdown and final-equity percentiles and a ruin probability, labelled
 * simulated. A read: nothing is stored, and the same seed reads back the same figures.
 */
export function MonteCarloPanel({ runId }: { runId: string }) {
  const api = useApi();
  const { t } = researchCopy.useCopy();
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QuantMonteCarlo | null>(null);
  const [refused, setRefused] = useState<{ code: string; text: string } | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  const validSeed = /^\d{1,10}$/.test(seed) && Number(seed) <= 2_147_483_647;
  async function run() {
    if (busy || !validSeed) return;
    setBusy(true);
    setRefused(null);
    setFailure(null);
    const res = await api.query('quant', 'backtest.monteCarlo', { runId, seed: Number(seed) }, quantMonteCarloSchema);
    setBusy(false);
    if (res.ok) {
      setResult(res.data);
      return;
    }
    setResult(null);
    const code = refusalCode(res);
    const detail = res.message.replace(/^[a-z]+\.[a-z_]+ — /, '');
    if (code === 'quant.montecarlo_runs_unset') setRefused({ code, text: t('mcRunsUnset') });
    else if (code === 'quant.montecarlo_min_trades_unset') setRefused({ code, text: t('mcMinUnset') });
    else if (code === 'quant.montecarlo_trades_insufficient') setRefused({ code, text: t('mcTooFew', { detail }) });
    else setFailure(res);
  }
  return (
    <section aria-label={t('mcTitle')} data-testid="quant-montecarlo">
      <h4>{t('mcTitle')}</h4>
      <p className="muted">{t('mcIntro')}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Field
          label={t('mcSeed')}
          value={seed}
          onChange={(e) => setSeed(e.target.value.trim())}
          inputMode="numeric"
          hint={seed && !validSeed ? t('mcSeedInvalid') : undefined}
        />
        <Button type="submit" disabled={busy || !validSeed}>
          {t('mcRun')}
        </Button>
      </form>
      {refused && (
        <p role="alert" data-testid="quant-montecarlo-refusal" data-code={refused.code}>
          {refused.text}
        </p>
      )}
      {failure && <Failure result={failure} />}
      {result && (
        <div data-testid="quant-montecarlo-result" data-runs={result.runs} data-seed={result.seed} data-trips={result.roundTrips}>
          <p className="more-badge" data-testid="quant-montecarlo-label">
            {result.claimLabel}
          </p>
          <p>{t('mcPaths', { runs: result.runs, trips: result.roundTrips, seed: result.seed, cash: result.startCash })}</p>
          <DataTable label={t('mcTitle')} headers={[t('mcPercentile'), t('mcDrawdown'), t('mcFinal')]}>
            {PERCENTILES.map((p) => (
              <tr
                key={p}
                data-testid="quant-montecarlo-row"
                data-percentile={p}
                data-drawdown={result.maxDrawdownPercent[p]}
                data-final={result.finalEquity[p]}
              >
                <th scope="row" lang="zxx">
                  {p.toUpperCase()}
                </th>
                <td lang="zxx">{result.maxDrawdownPercent[p]}</td>
                <td lang="zxx">{result.finalEquity[p]}</td>
              </tr>
            ))}
          </DataTable>
          <p data-testid="quant-montecarlo-ruin" data-percent={result.ruinProbabilityPercent ?? ''} data-level={result.ruinLevel ?? ''}>
            {result.ruinProbabilityPercent === null
              ? t('mcRuinUnset')
              : t('mcRuin', { percent: result.ruinProbabilityPercent, level: result.ruinLevel ?? '' })}
          </p>
        </div>
      )}
    </section>
  );
}
