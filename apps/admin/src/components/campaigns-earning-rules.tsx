'use client';

import { useState } from 'react';
import { EARNING_TRIGGERS, type EarningRule, type EarningTrigger } from '@intafaced/contracts/campaigns-catalogue';
import type { CampaignDeskReply } from '@/lib/campaigns-ops/builder-model';

/**
 * THE EARNING RULES TAB (CM-rewards-hub-05, J-campaigns-16 #6).
 *
 * Each rule names a trigger from the catalogue (an event the platform already publishes), a condition on the event's
 * amount and an incentive formula from the closed grammar. Adding or removing a rule saves the campaign's definition:
 * the draft, or the next revision of a live campaign. svc-campaigns refuses a formula outside the grammar, a trigger
 * outside the catalogue and two rules with one name, each by its code. Rewards from these rules are the next slice: until
 * then nothing is paid from them, and the tab says so.
 */

const TRIGGERS = Object.entries(EARNING_TRIGGERS) as [EarningTrigger, (typeof EARNING_TRIGGERS)[EarningTrigger]][];

type Refusal = Extract<CampaignDeskReply, { ok: false }>;

export function EarningRules({
  rules,
  asset,
  disabled,
  onSave,
}: {
  rules: readonly EarningRule[];
  asset: string | null;
  disabled: boolean;
  onSave: (rules: EarningRule[]) => Promise<CampaignDeskReply>;
}) {
  const [name, setName] = useState(`Rule ${rules.length + 1}`);
  const [trigger, setTrigger] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [formula, setFormula] = useState('');
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const names = trigger ? EARNING_TRIGGERS[trigger as EarningTrigger]?.names : undefined;

  const save = async (next: EarningRule[]) => {
    setBusy(true);
    const answer = await onSave(next);
    setRefused(answer.ok ? null : answer);
    if (answer.ok) {
      setName(`Rule ${next.length + 1}`);
      setFormula('');
      setMinAmount('');
    }
    setBusy(false);
  };

  const add = () => {
    if (!trigger) {
      setRefused({
        ok: false,
        title: 'Pick a trigger',
        body: 'An earning rule starts from an event in the catalogue.',
        next: 'Nothing was saved.',
        code: null,
        changed: 'no',
      });
      return;
    }
    void save([...rules, { name: name.trim(), trigger, minAmount: minAmount.trim() || null, formula: formula.trim() }]);
  };

  return (
    <section aria-label="Earning rules of this campaign" data-testid="campaign-earning">
      <p className="dk-muted">
        Paying from these rules is not built yet (the next slice: one reward per event, kept once even if the event arrives twice). Until
        then they are part of the campaign&apos;s definition and its revisions, and nothing is paid from them.
      </p>
      {rules.length === 0 ? (
        <p className="dk-muted">No earning rule yet.</p>
      ) : (
        <ul aria-label="Earning rules">
          {rules.map((r, i) => (
            <li key={r.name} data-testid="earning-rule">
              {r.name}: when {EARNING_TRIGGERS[r.trigger as EarningTrigger]?.label.toLowerCase() ?? r.trigger}
              {r.minAmount ? ` of at least ${r.minAmount}` : ''}, give {r.formula} {asset ?? '(the reward asset is not set)'}{' '}
              <button
                type="button"
                className="adm-btn"
                disabled={disabled || busy}
                onClick={() => void save(rules.filter((_, j) => j !== i))}
              >
                Remove {r.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div role="form" aria-label="Earning rule" className="dk-stack">
        {refused && (
          <div className="adm-callout" role="alert" data-tone="danger" data-code={refused.code ?? ''}>
            <strong>{refused.title}</strong>
            <p>{refused.body}</p>
            <p className="dk-muted">{refused.next}</p>
            {refused.code && <p className="dk-muted">Code: {refused.code}</p>}
          </div>
        )}
        <div className="adm-field">
          <label htmlFor="earn-name">Earning rule name</label>
          <input id="earn-name" value={name} maxLength={80} disabled={disabled || busy} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="adm-field">
          <label htmlFor="earn-trigger">Trigger</label>
          <select id="earn-trigger" value={trigger} disabled={disabled || busy} onChange={(e) => setTrigger(e.target.value)}>
            <option value="">Pick a trigger</option>
            {TRIGGERS.map(([id, t]) => (
              <option key={id} value={id}>
                {t.label} ({id})
              </option>
            ))}
          </select>
        </div>
        <div className="adm-field">
          <label htmlFor="earn-min">Condition: the event&apos;s amount is at least</label>
          <input
            id="earn-min"
            inputMode="decimal"
            value={minAmount}
            disabled={disabled || busy}
            onChange={(e) => setMinAmount(e.target.value)}
          />
          <p className="dk-muted">Blank: any amount.</p>
        </div>
        <div className="adm-field">
          <label htmlFor="earn-formula">Incentive formula</label>
          <input
            id="earn-formula"
            value={formula}
            maxLength={200}
            disabled={disabled || busy}
            onChange={(e) => setFormula(e.target.value)}
          />
          <p className="dk-muted">
            A number for a fixed incentive, or a formula: decimal numbers, {names ? names.join(', ') : 'the names of the trigger you pick'},{' '}
            + − × ÷ (written + - * /), brackets, min(a, b) and max(a, b). Paid in the campaign&apos;s reward asset, never below zero.
          </p>
        </div>
        <div className="dk-row">
          <button type="button" className="adm-btn" disabled={disabled || busy} onClick={add}>
            Add rule
          </button>
        </div>
      </div>
    </section>
  );
}
