'use client';

import { useState } from 'react';
import {
  EARNING_TRIGGERS,
  type EarningEffect,
  type EarningEvaluation,
  type EarningEvaluationResult,
  type EarningRule,
  type EarningTrigger,
} from '@intafaced/contracts/campaigns-catalogue';
import { postRuleAction, type RuleAnswer } from '@/lib/campaigns-ops/builder-browser';
import type { CampaignDeskReply } from '@/lib/campaigns-ops/builder-model';

/**
 * THE EARNING RULES TAB (CM-rewards-hub-05, J-campaigns-16 #6).
 *
 * Each rule names a trigger from the catalogue (an event the platform already publishes), a condition on the event's
 * amount and an incentive formula from the closed grammar. Adding or removing a rule saves the campaign's definition:
 * the draft, or the next revision of a live campaign. svc-campaigns refuses a formula outside the grammar, a trigger
 * outside the catalogue and two rules with one name, each by its code, and pays each rule once per event.
 *
 * A rule's effect is an incentive in the reward asset, or points (CM-rewards-hub-04, J-campaigns-15 #5). A points effect
 * saves, but it waits for the owner's answer to whether INTAFACED runs a points programme whose points have value or
 * convert to cash: evaluating the rules on a TEST event refuses `owner.decision` for that rule alone, while the others say
 * what they would give, and nothing is written.
 */

const TRIGGERS = Object.entries(EARNING_TRIGGERS) as [EarningTrigger, (typeof EARNING_TRIGGERS)[EarningTrigger]][];

type Refusal = Extract<CampaignDeskReply, { ok: false }>;

export function EarningRules({
  campaignId,
  rules,
  asset,
  disabled,
  onSave,
}: {
  campaignId: string;
  rules: readonly EarningRule[];
  asset: string | null;
  disabled: boolean;
  onSave: (rules: EarningRule[]) => Promise<CampaignDeskReply>;
}) {
  const [name, setName] = useState(`Rule ${rules.length + 1}`);
  const [trigger, setTrigger] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [formula, setFormula] = useState('');
  const [effect, setEffect] = useState<EarningEffect>('incentive');
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
      setEffect('incentive');
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
    const rule: EarningRule = { name: name.trim(), trigger, minAmount: minAmount.trim() || null, formula: formula.trim() };
    void save([...rules, effect === 'points' ? { ...rule, effect: 'points' } : rule]);
  };

  return (
    <section aria-label="Earning rules of this campaign" data-testid="campaign-earning">
      <p className="dk-muted">
        While the campaign is live, each event of a rule&apos;s trigger by a customer who joined before it gives one reward, once even if
        the event arrives twice, paid through the reward saga. A formula that reads the event&apos;s amounts pays only for events in the
        reward asset. No reward goes past the budget left or the customer&apos;s reward per person; a paused campaign gives none.
      </p>
      {rules.length === 0 ? (
        <p className="dk-muted">No earning rule yet.</p>
      ) : (
        <ul aria-label="Earning rules">
          {rules.map((r, i) => (
            <li key={r.name} data-testid="earning-rule">
              {r.name}: when {EARNING_TRIGGERS[r.trigger as EarningTrigger]?.label.toLowerCase() ?? r.trigger}
              {r.minAmount ? ` of at least ${r.minAmount}` : ''}, give {r.formula}{' '}
              {r.effect === 'points' ? 'points (waits for an owner decision)' : (asset ?? '(the reward asset is not set)')}{' '}
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
          <label htmlFor="earn-effect">Effect</label>
          <select
            id="earn-effect"
            value={effect}
            disabled={disabled || busy}
            onChange={(e) => setEffect(e.target.value === 'points' ? 'points' : 'incentive')}
          >
            <option value="incentive">An incentive in the reward asset</option>
            <option value="points">Points of the points programme</option>
          </select>
          {effect === 'points' && (
            <p className="dk-muted" data-testid="earn-effect-points-note">
              A points effect saves, but it waits for an owner decision: whether INTAFACED runs a points programme whose points have value
              or convert to cash. Until then evaluating it refuses, and no point is given or stored.
            </p>
          )}
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
      <EvaluatePanel campaignId={campaignId} asset={asset} hasRules={rules.length > 0} />
    </section>
  );
}

const REASON: Record<Extract<EarningEvaluationResult, { outcome: 'nothing' }>['reason'], string> = {
  other_trigger: 'it answers another event',
  below_condition: 'the amount is under its condition',
  zero: 'it works out to nothing',
};

/**
 * Evaluate the saved rules on one TEST event the founder types (CM-rewards-hub-05 preview and test). svc-campaigns reads
 * the stored rules and writes nothing; a lost reply changes nothing, so pressing again is safe.
 */
function EvaluatePanel({ campaignId, asset, hasRules }: { campaignId: string; asset: string | null; hasRules: boolean }) {
  const [trigger, setTrigger] = useState<EarningTrigger>(TRIGGERS[0]![0]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [answer, setAnswer] = useState<RuleAnswer<EarningEvaluation> | null>(null);
  const [busy, setBusy] = useState(false);
  const names: readonly string[] = EARNING_TRIGGERS[trigger].names;

  const evaluate = async () => {
    setBusy(true);
    const typed = Object.fromEntries(names.map((n) => [n, (values[n] ?? '').trim()]).filter(([, v]) => v !== ''));
    setAnswer(await postRuleAction<EarningEvaluation>({ op: 'earning-evaluate', id: campaignId, trigger, values: typed }));
    setBusy(false);
  };

  return (
    <div role="form" aria-label="Evaluate on a TEST event" className="dk-stack" data-testid="earning-evaluate">
      <h3>Evaluate on a TEST event</h3>
      <p className="dk-muted">
        Type a TEST event and see what each saved rule would give for it. Nothing is written: no reward, no point, no record.
      </p>
      <div className="adm-field">
        <label htmlFor="eval-trigger">TEST event</label>
        <select
          id="eval-trigger"
          value={trigger}
          disabled={busy}
          onChange={(e) => {
            setTrigger(e.target.value as EarningTrigger);
            setValues({});
            setAnswer(null);
          }}
        >
          {TRIGGERS.map(([id, t]) => (
            <option key={id} value={id}>
              {t.label} ({id})
            </option>
          ))}
        </select>
      </div>
      {names.map((n) => (
        <div className="adm-field" key={n}>
          <label htmlFor={`eval-${n}`}>TEST {n}</label>
          <input
            id={`eval-${n}`}
            inputMode="decimal"
            value={values[n] ?? ''}
            disabled={busy}
            onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))}
          />
        </div>
      ))}
      <div className="dk-row">
        <button type="button" className="adm-btn" disabled={busy || !hasRules} onClick={() => void evaluate()}>
          Evaluate rules
        </button>
      </div>
      {!hasRules && <p className="dk-muted">Save a rule first: there is nothing to evaluate yet.</p>}
      {answer && !answer.ok && (
        <div className="adm-callout" role="alert" data-tone="danger" data-code={answer.code ?? ''}>
          <strong>{answer.title}</strong>
          <p>{answer.body}</p>
          <p className="dk-muted">{answer.next}</p>
          {answer.code && <p className="dk-muted">Code: {answer.code}</p>}
        </div>
      )}
      {answer && answer.ok && (
        <ul aria-label="Evaluation" data-testid="earning-evaluation">
          {answer.data.results.map((r) => (
            <li key={r.rule} data-testid="earning-evaluation-rule" data-rule={r.rule} data-outcome={r.outcome} data-effect={r.effect}>
              {r.outcome === 'gives' ? (
                <>
                  {r.rule}: would give {r.amount} {r.asset ?? asset ?? '(the reward asset is not set)'}
                </>
              ) : r.outcome === 'nothing' ? (
                <>
                  {r.rule}: gives nothing, {REASON[r.reason]}
                </>
              ) : (
                <>
                  <strong>{r.rule}: Waiting for an owner decision.</strong> {r.question} Code: {r.code}. Nothing was given or stored.
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
