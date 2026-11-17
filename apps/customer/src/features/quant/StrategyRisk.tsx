import {
  QUANT_EQUITY_STOP_POLICIES,
  QUANT_RISK_CAPS,
  quantRiskScreenSchema,
  type QuantRiskCap,
  type QuantRiskScreen,
  type QuantStrategyDetail,
} from '@intafaced/contracts/quant-algo';
import { useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { Read, Select } from '../more/common';
import { useApi } from '../session/session';
import { riskCopy } from './risk-copy';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
/** `quant.risk_cap_unset — trading stays off — still blank: A, B`: the caps a refusal names. */
const blankOf = (message: string) => /^quant\.risk_cap_unset — .* still blank: (.*)$/.exec(message.trim())?.[1] ?? null;
/** `quant.risk_cap_invalid — <what> — <why>`: what was wrong. */
const invalidOf = (message: string) => /^quant\.risk_cap_invalid — (.*)$/.exec(message.trim())?.[1] ?? null;

type Draft = Record<QuantRiskCap, string>;
const draftOf = (screen: QuantRiskScreen): Draft =>
  Object.fromEntries(QUANT_RISK_CAPS.map((name) => [name, screen.caps[name] ?? ''])) as Draft;

/** A strategy's risk screen (AL-risk-01): the caps, the equity-stop floor's policy, and the trading switch. */
export function StrategyRisk({ strategy }: { strategy: QuantStrategyDetail }) {
  const api = useApi();
  const { t } = riskCopy.useCopy();
  const [revision, setRevision] = useState(0);
  const screen = useResource(
    (signal) => api.query('quant', 'risk.get', { strategyId: strategy.id }, quantRiskScreenSchema, { signal }),
    `quant-risk:${strategy.id}:${revision}`,
  );
  return (
    <section aria-label={t('title')} data-testid="quant-risk-screen">
      <h3>{t('title')}</h3>
      <p className="muted">{t('intro')}</p>
      <p className="muted">{t('simulated')}</p>
      <Read resource={screen.resource} retry={screen.reload}>
        {(saved) => <RiskForm key={`${saved.updatedAt}:${saved.trading.version}`} saved={saved} reload={() => setRevision((n) => n + 1)} />}
      </Read>
    </section>
  );
}

function RiskForm({ saved, reload }: { saved: QuantRiskScreen; reload: () => void }) {
  const api = useApi();
  const { t } = riskCopy.useCopy();
  const [draft, setDraft] = useState<Draft>(() => draftOf(saved));
  const [policy, setPolicy] = useState<string>(saved.floorPolicy);
  const [current, setCurrent] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  const names = (list: readonly QuantRiskCap[]) => list.map((name) => t(name)).join(', ');

  function clear() {
    setNote(null);
    setRefused(null);
    setFailure(null);
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    clear();
    const res = await api.mutate(
      'quant',
      'risk.set',
      { strategyId: saved.strategyId, caps: draft, floorPolicy: policy },
      quantRiskScreenSchema,
    );
    setBusy(false);
    if (res.ok) {
      setCurrent(res.data);
      setDraft(draftOf(res.data));
      setNote(t('saved'));
      return;
    }
    const detail = invalidOf(res.message);
    if (detail) setRefused(t('invalid', { detail }));
    else setFailure(res);
  }

  async function switchTrading(on: boolean) {
    if (busy) return;
    setBusy(true);
    clear();
    const res = await api.mutate('quant', 'risk.trading', { strategyId: saved.strategyId, on }, quantRiskScreenSchema);
    setBusy(false);
    if (res.ok) {
      setCurrent(res.data);
      return;
    }
    const blank = blankOf(res.message);
    if (blank) setRefused(t('refused', { caps: blank }));
    else setFailure(res);
  }

  const on = current.trading.on;
  return (
    <>
      <div className="quant-risk-caps">
        {QUANT_RISK_CAPS.map((name) => (
          <div key={name} data-testid="quant-risk-cap">
            <Field
              label={t(name)}
              hint={t(`${name}Hint`)}
              value={draft[name]}
              inputMode="decimal"
              maxLength={40}
              data-cap={name}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft((prev) => ({ ...prev, [name]: value }));
                setNote(null);
              }}
            />
          </div>
        ))}
        <Select
          label={t('floorPolicy')}
          value={policy}
          onChange={setPolicy}
          options={QUANT_EQUITY_STOP_POLICIES.map((value) => ({ value, label: t(value) }))}
        />
      </div>
      <p data-testid="quant-risk-unset" data-unset={current.unset.join(',')}>
        {current.unset.length ? t('blankList', { caps: names(current.unset) }) : t('noneBlank')}
      </p>
      <Button onClick={() => void save()} disabled={busy}>
        {t('save')}
      </Button>
      <Field
        type="checkbox"
        role="switch"
        label={t('trading')}
        checked={on}
        aria-checked={on}
        disabled={busy}
        onChange={(event) => void switchTrading(event.currentTarget.checked)}
      />
      <p data-testid="quant-risk-trading" data-on={on}>
        {on ? t('tradingOn', { version: current.latestVersion }) : t('tradingOff')}
      </p>
      {!on && current.trading.offByNewVersion && current.trading.version !== null && (
        <p role="status" data-testid="quant-risk-version-off">
          {t('offByNewVersion', { latest: current.latestVersion, version: current.trading.version })}
        </p>
      )}
      {busy && <Loading label={t('saving')} />}
      {note && (
        <p role="status" data-testid="quant-risk-note">
          {note}
        </p>
      )}
      {refused && (
        <p role="alert" data-testid="quant-risk-refusal">
          {refused}
        </p>
      )}
      {failure && <Failure result={failure} retry={reload} />}
    </>
  );
}
