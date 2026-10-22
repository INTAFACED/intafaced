import { QUANT_BAR_SIZES, quantCompileOutputSchema, type QuantSignalRules } from '@intafaced/contracts/quant-algo';
import { useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { Select } from '../more/common';
import { useApi } from '../session/session';
import { builderCopy } from './builder-copy';
import { ruleRefusal, trimSignalRules, type RuleInputName, type RuleRefusal } from './signal-rules';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * The no-code builder (AL-editor-02): typed inputs for one moving-average cross with a sizing rule and optional exits.
 * Build source asks the service to check the inputs and write the source for them; a blank or out-of-range input
 * comes back named, next to its field, and nothing runs.
 */
export function SignalBuilder({ value, onChange }: { value: QuantSignalRules; onChange: (next: QuantSignalRules) => void }) {
  const api = useApi();
  const { t } = builderCopy.useCopy();
  const [busy, setBusy] = useState(false);
  const [built, setBuilt] = useState<{ rules: string; source: string } | null>(null);
  const [refusal, setRefusal] = useState<RuleRefusal | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  const current = JSON.stringify(trimSignalRules(value));
  const label: Record<RuleInputName, string> = {
    symbol: t('symbol'),
    'signal.fast': t('fast'),
    'signal.slow': t('slow'),
    'sizing.value': t('sizingValue'),
    'exit.stopLossPercent': t('stopLoss'),
    'exit.takeProfitPercent': t('takeProfit'),
  };
  const errorFor = (input: RuleInputName) =>
    refusal?.input === input
      ? refusal.kind === 'outOfRange'
        ? t('outOfRange', { input: label[input], detail: refusal.detail })
        : t(refusal.kind, { input: label[input] })
      : undefined;
  const set = (patch: (rules: QuantSignalRules) => QuantSignalRules) => onChange(patch(value));

  async function build() {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    setFailure(null);
    const rules = trimSignalRules(value);
    const res = await api.query('quant', 'studio.compile', { modules: rules }, quantCompileOutputSchema);
    setBusy(false);
    if (res.ok) {
      setBuilt({ rules: JSON.stringify(rules), source: res.data.source });
      return;
    }
    setBuilt(null);
    const named = ruleRefusal(res.message);
    if (named) setRefusal(named);
    else setFailure(res);
  }

  return (
    <fieldset className="quant-builder" data-testid="quant-signal-builder">
      <legend>{t('title')}</legend>
      <p className="muted">{t('intro')}</p>
      <Field
        label={label.symbol}
        value={value.symbol}
        onChange={(e) => set((r) => ({ ...r, symbol: e.target.value }))}
        maxLength={32}
        error={errorFor('symbol')}
      />
      <Select
        label={t('barSize')}
        value={value.barSize}
        onChange={(v) => set((r) => ({ ...r, barSize: v as QuantSignalRules['barSize'] }))}
        options={QUANT_BAR_SIZES}
      />
      <Select
        label={t('average')}
        value={value.signal.average}
        onChange={(v) => set((r) => ({ ...r, signal: { ...r.signal, average: v as 'sma' | 'ema' } }))}
        options={[
          { value: 'sma', label: t('sma') },
          { value: 'ema', label: t('ema') },
        ]}
      />
      <Field
        label={label['signal.fast']}
        value={value.signal.fast}
        onChange={(e) => set((r) => ({ ...r, signal: { ...r.signal, fast: e.target.value } }))}
        inputMode="numeric"
        maxLength={12}
        error={errorFor('signal.fast')}
      />
      <Field
        label={label['signal.slow']}
        value={value.signal.slow}
        onChange={(e) => set((r) => ({ ...r, signal: { ...r.signal, slow: e.target.value } }))}
        inputMode="numeric"
        maxLength={12}
        error={errorFor('signal.slow')}
      />
      <Select
        label={t('sizingKind')}
        value={value.sizing.kind}
        onChange={(v) => set((r) => ({ ...r, sizing: { ...r.sizing, kind: v as QuantSignalRules['sizing']['kind'] } }))}
        options={[
          { value: 'quantity', label: t('quantity') },
          { value: 'cash', label: t('cash') },
          { value: 'percent_equity', label: t('percent_equity') },
        ]}
      />
      <Field
        label={label['sizing.value']}
        value={value.sizing.value}
        onChange={(e) => set((r) => ({ ...r, sizing: { ...r.sizing, value: e.target.value } }))}
        inputMode="decimal"
        maxLength={40}
        error={errorFor('sizing.value')}
      />
      <Field
        label={label['exit.stopLossPercent']}
        value={value.exit.stopLossPercent}
        onChange={(e) => set((r) => ({ ...r, exit: { ...r.exit, stopLossPercent: e.target.value } }))}
        inputMode="decimal"
        maxLength={40}
        error={errorFor('exit.stopLossPercent')}
      />
      <Field
        label={label['exit.takeProfitPercent']}
        value={value.exit.takeProfitPercent}
        onChange={(e) => set((r) => ({ ...r, exit: { ...r.exit, takeProfitPercent: e.target.value } }))}
        inputMode="decimal"
        maxLength={40}
        error={errorFor('exit.takeProfitPercent')}
      />
      <Button type="button" variant="secondary" onClick={() => void build()} disabled={busy} data-testid="quant-build-source">
        {t('build')}
      </Button>
      {busy && <Loading label={t('building')} />}
      {refusal && (
        <p role="alert" className="error-text" data-testid="quant-rule-refusal">
          {errorFor(refusal.input)}
        </p>
      )}
      {failure && <Failure result={failure} retry={() => void build()} />}
      {built && (
        <section aria-label={t('sourceTitle')} data-testid="quant-generated-source">
          <h4>{t('sourceTitle')}</h4>
          {built.rules !== current && <p className="muted">{t('staleSource')}</p>}
          <pre lang="zxx" tabIndex={0}>
            <code>{built.source}</code>
          </pre>
          <p className="muted">{t('sourceNote')}</p>
        </section>
      )}
    </fieldset>
  );
}
