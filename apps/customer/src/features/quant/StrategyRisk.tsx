import {
  QUANT_EQUITY_STOP_POLICIES,
  QUANT_RISK_CAPS,
  type QuantRiskCap,
  type QuantRiskScreen,
  type QuantStrategyDetail,
} from '@intafaced/contracts/quant-algo';
import { QUANT_RISK_GET, QUANT_RISK_SET, QUANT_RISK_TRADING } from '@intafaced/contracts/quant-strategy-settings-procedures';
import { useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { useApi } from '../session';
import { riskCopy } from './risk-copy';
import { Button, Field } from '@intafaced/ui/lit';
import { SelectField } from '@intafaced/ui/lit/templates';
import { FailureNote, Read, Waiting } from './volt-parts';

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
    (signal) => api.call(QUANT_RISK_GET, { strategyId: strategy.id }, { signal }),
    `quant-risk:${strategy.id}:${revision}`,
  );
  return (
    <section aria-label={t('title')} data-testid="quant-risk-screen">
      <h3>{t('title')}</h3>
      <p>{t('intro')}</p>
      <p>{t('simulated')}</p>
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
    const res = await api.call(QUANT_RISK_SET, { strategyId: saved.strategyId, caps: draft, floorPolicy: policy });
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
    const res = await api.call(QUANT_RISK_TRADING, { strategyId: saved.strategyId, on });
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
      <div>
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
        <SelectField
          label={t('floorPolicy')}
          value={policy}
          onChange={setPolicy}
          options={QUANT_EQUITY_STOP_POLICIES.map((value) => ({ value, label: t(value) }))}
        />
      </div>
      <p data-testid="quant-risk-unset" data-unset={current.unset.join(',')}>
        {current.unset.length ? t('blankList', { caps: names(current.unset) }) : t('noneBlank')}
      </p>
      <Button tone="primary" onClick={() => void save()} disabled={busy}>
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
      {busy && <Waiting label={t('saving')} />}
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
      {failure && <FailureNote result={failure} retry={reload} />}
    </>
  );
}
