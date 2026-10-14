import { useState } from 'react';
import { Lock } from 'lucide-react';
import { AmountInput, Checkbox, SegmentedControl, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@intafaced/ui';
import { fmtUsd } from '../../../data/format';
import { PreviewActionButton, PreviewChip } from '../../../preview';
import type { SampleAgent, SampleAgentMode, SampleLogEntry } from '../../../preview/fixtures/agents';
import { agentsCopy } from './copy';
import { agentIcons } from './icons';
import { draftOf, judge, sameDraft, usedBy, type Draft } from './model';

const MARKETS = ['BTC', 'ETH', 'SOL', 'USDT', 'XRP'] as const;

function Tester({ agent, draft, day }: { agent: SampleAgent; draft: Draft; day: readonly SampleLogEntry[] }) {
  const { t } = agentsCopy.useCopy();
  const rules = agent.guardrails.actions;
  const [actionId, setActionId] = useState(rules[0]?.id ?? '');
  const [amount, setAmount] = useState('400.00');
  const used = usedBy(day, agent.id);
  const verdict = judge({ agent, draft, actionId, amount, usedToday: used });
  const limits = draft.limits;
  const text =
    verdict.reason === 'inside'
      ? t('Verdict allowed inside')
      : verdict.reason === 'suggest'
        ? t('Verdict ask suggest')
        : verdict.reason === 'above'
          ? t('Verdict ask above', { limit: fmtUsd(limits?.askAbove) })
          : verdict.reason === 'action'
            ? t('Verdict blocked action')
            : verdict.reason === 'max'
              ? t('Verdict blocked max', { limit: fmtUsd(limits?.maxPerAction) })
              : verdict.reason === 'daily'
                ? t('Verdict blocked daily', { limit: fmtUsd(limits?.dailyLimit) })
                : t('Verdict blocked amount');
  return (
    <div className="ag-test" data-testid="agents-test">
      <h3 className="ag-h3">{t('Test heading')}</h3>
      <div className="ag-test__row">
        <div className="ag-field ag-field--select">
          <span className="ag-field__label" id="ag-test-action">
            {t('Test action')}
          </span>
          <Select
            items={Object.fromEntries(rules.map((rule) => [rule.id, rule.label]))}
            value={actionId}
            onValueChange={(next) => next && setActionId(next)}
          >
            <SelectTrigger aria-labelledby="ag-test-action" size={32} className="ag-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {rules.map((rule) => (
                <SelectItem key={rule.id} value={rule.id}>
                  {rule.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <AmountInput label={t('Test amount')} unit="USDT" precision={2} tick="50" value={amount} onValueChange={setAmount} />
      </div>
      <p className="ag-verdict" data-kind={verdict.kind} role="status">
        {text}
      </p>
      <p className="ag-fine">{t('Used today', { used: fmtUsd(used) })}</p>
    </div>
  );
}

/**
 * The guardrails editor for the picked agent: how much it may do alone, its limits, which actions are allowed and which coins it may
 * use. Edits stay on this page; Save opens the "nothing was sent" sheet. A small checker shows what the limits would decide.
 */
export function Guardrails({
  agent,
  draft,
  onChange,
  temperament,
  day,
}: {
  agent: SampleAgent;
  draft: Draft;
  onChange: (draft: Draft | null) => void;
  temperament: string;
  day: readonly SampleLogEntry[];
}) {
  const { t } = agentsCopy.useCopy();
  const Icon = agentIcons[agent.id];
  const dirty = !sameDraft(draft, draftOf(agent.guardrails));
  const limits = draft.limits;
  const setLimit = (key: keyof NonNullable<Draft['limits']>, value: string) =>
    limits && onChange({ ...draft, limits: { ...limits, [key]: value } });
  const modeLine = draft.mode === 'suggest' ? t('Mode suggest line') : draft.mode === 'ask' ? t('Mode ask line') : t('Mode act line');
  return (
    <section className="if-preview__panel ag-guard" aria-labelledby="ag-guard-h" data-testid="agents-guardrails" data-agent={agent.id}>
      <div className="if-preview__panel-head">
        <span className="ag-navigator__icon" aria-hidden="true">
          <Icon size={18} strokeWidth={1.75} />
        </span>
        <h2 className="if-preview__h2" id="ag-guard-h">
          {t('Guardrails for', { name: agent.name })}
        </h2>
        <PreviewChip />
      </div>
      <p className="ag-fine">{t('Blueprint note', { temperament })}</p>

      <h3 className="ag-h3">{t('Mode heading')}</h3>
      <SegmentedControl
        aria-label={t('Mode heading')}
        size={32}
        fullWidth
        value={draft.mode}
        onValueChange={(mode) => onChange({ ...draft, mode: mode as SampleAgentMode })}
        items={[
          { value: 'suggest', label: t('Mode suggest') },
          { value: 'ask', label: t('Mode ask') },
          { value: 'act', label: t('Mode act') },
        ]}
      />
      <p className="ag-fine ag-fine--tight">{modeLine}</p>

      {limits ? (
        <>
          <h3 className="ag-h3">{t('Limits heading')}</h3>
          <div className="ag-limits">
            <AmountInput
              label={t('Max per action')}
              unit="USDT"
              precision={2}
              tick="25"
              value={limits.maxPerAction}
              onValueChange={(v) => setLimit('maxPerAction', v)}
            />
            <AmountInput
              label={t('Daily limit')}
              unit="USDT"
              precision={2}
              tick="100"
              value={limits.dailyLimit}
              onValueChange={(v) => setLimit('dailyLimit', v)}
            />
            <AmountInput
              label={t('Ask above')}
              unit="USDT"
              precision={2}
              tick="25"
              value={limits.askAbove}
              onValueChange={(v) => setLimit('askAbove', v)}
              disabled={draft.mode !== 'ask'}
            />
            <AmountInput
              label={t('Stop at loss')}
              unit="%"
              precision={0}
              tick="1"
              value={limits.stopAtLoss}
              onValueChange={(v) => setLimit('stopAtLoss', v)}
            />
          </div>
        </>
      ) : (
        <p className="ag-note">{t('Reads only body')}</p>
      )}

      <h3 className="ag-h3">{t('Actions heading')}</h3>
      <ul className="ag-actions">
        {agent.guardrails.actions.map((rule) => (
          <li key={rule.id}>
            <label className="ag-action" data-locked={rule.locked || undefined}>
              <Checkbox
                checked={draft.actions[rule.id] === true}
                disabled={rule.locked === true}
                onCheckedChange={(checked) => onChange({ ...draft, actions: { ...draft.actions, [rule.id]: checked } })}
              />
              <span className="ag-action__text">
                <span>{rule.label}</span>
                {rule.why ? (
                  <span className="ag-action__why">
                    {rule.locked ? <Lock size={12} strokeWidth={2} aria-label={t('Locked')} /> : null}
                    {rule.why}
                  </span>
                ) : null}
              </span>
            </label>
          </li>
        ))}
      </ul>

      {limits ? (
        <>
          <h3 className="ag-h3">{t('Markets heading')}</h3>
          <ul className="ag-markets">
            {MARKETS.map((coin) => (
              <li key={coin}>
                <label className="ag-market">
                  <Checkbox
                    checked={draft.markets.includes(coin)}
                    onCheckedChange={(checked) =>
                      onChange({ ...draft, markets: checked ? [...draft.markets, coin] : draft.markets.filter((m) => m !== coin) })
                    }
                  />
                  {coin}
                </label>
              </li>
            ))}
          </ul>
          <Tester key={agent.id} agent={agent} draft={draft} day={day} />
        </>
      ) : null}

      <div className="ag-guard__foot">
        {dirty ? <span className="ag-guard__dirty">{t('Unsaved')}</span> : <span />}
        <button type="button" className="ag-link" onClick={() => onChange(null)} disabled={!dirty}>
          {t('Reset')}
        </button>
        <PreviewActionButton product="agents" variant="primary" size={40}>
          {t('Save')}
        </PreviewActionButton>
      </div>
      <p className="ag-fine">{t('Save note')}</p>
    </section>
  );
}
