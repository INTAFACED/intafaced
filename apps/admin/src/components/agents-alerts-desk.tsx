'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CHOICE_WORD,
  CHOICES,
  CLASS_WORD,
  DATA_CLASSES,
  MEASURE_WORD,
  MEASURES,
  valueWords,
  type Choice,
  type DataClass,
  type Measure,
} from '@/lib/agents-alerts/model';

/**
 * The agent alert desk (AG-analytics-02, AG-guardrails-02): alert rules over every agent action svc-agents records, the
 * evaluator's last answer per window, the alerts it kept with their delivery state, and the managed policy baseline with
 * this environment's overrides. Every figure is svc-agents' own, re-read after each action; a window with no actions
 * shows that it has no rows, never a 0% rate.
 */

interface Rule {
  readonly id: string;
  readonly name: string;
  readonly measure: Measure;
  readonly threshold: string;
  readonly windowMinutes: number;
  readonly agentId: string | null;
}

interface Alert {
  readonly id: string;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly measure: Measure;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly actionRows: number;
  readonly value: string;
  readonly threshold: string;
  readonly delivery: 'pending' | 'handed_off';
}

interface Window {
  readonly ruleId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly actionRows: number;
  readonly value: string | null;
  readonly breached: boolean;
  readonly alertWritten: boolean;
}

interface PolicyClass {
  readonly dataClass: DataClass;
  readonly baseline: Choice | null;
  readonly override: Choice | null;
  readonly overrideSetAt: string | null;
  readonly effective: Choice | null;
}

const WORDS: Record<string, string> = {
  'agents.alert_threshold_required': 'Threshold is required. Type a number; 0 is a value.',
  'agents.alert_threshold_invalid': 'Threshold must be a decimal number; a rate is a percent from 0 to 100.',
  'agents.alert_rule_name_taken': 'A rule with this name is already stored.',
  'agents.baseline_value_unset': 'The owner has not set the baseline for this tool class, so nothing can rely on it yet.',
  'agents.baseline_loosen_refused': 'An override cannot loosen the baseline.',
  'agents.rule_invalid': 'A live-write tool never acts without asking.',
  'admin.agents_alerts_input': 'Fill in every field of this form.',
};
const say = (code: string): string => `${WORDS[code] ?? 'The service refused this.'} (${code})`;
const when = (iso: string): string => iso.replace('T', ' ').replace(/:\d\d\.\d{3}Z$/, ' UTC');
const span = (start: string, end: string): string => `${when(start)} to ${when(end)}`;

type Answer = { ok: true; data: unknown } | { ok: false; code: string };

export function AgentsAlertsDesk({ csrf }: { csrf: string }) {
  const [rules, setRules] = useState<readonly Rule[]>([]);
  const [alerts, setAlerts] = useState<readonly Alert[]>([]);
  const [windows, setWindows] = useState<readonly Window[] | null>(null);
  const [policy, setPolicy] = useState<readonly PolicyClass[] | null>(null);
  const [notifications, setNotificationsState] = useState<'on' | 'down' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [ruleProblem, setRuleProblem] = useState<string | null>(null);
  const [ruleNotice, setRuleNotice] = useState<string | null>(null);
  const [overrideProblem, setOverrideProblem] = useState<string | null>(null);
  const [overrideNotice, setOverrideNotice] = useState<string | null>(null);
  const [checkVerdict, setCheckVerdict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [measure, setMeasure] = useState<Measure>('refusal_rate');
  const [threshold, setThreshold] = useState('');
  const [windowMinutes, setWindowMinutes] = useState('60');
  const [agentId, setAgentId] = useState('');
  const [overrideClass, setOverrideClass] = useState<DataClass>('own_data');
  const [overrideChoice, setOverrideChoice] = useState<Choice>('ask_before');
  const [checkClass, setCheckClass] = useState<DataClass>('own_data');
  const [checkChoice, setCheckChoice] = useState<Choice>('ask_before');

  const post = useCallback(
    async (body: Record<string, unknown>): Promise<Answer> => {
      const response = await fetch('/api/agents-alerts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-intafaced-csrf': csrf },
        body: JSON.stringify(body),
      }).catch(() => null);
      if (!response) return { ok: false, code: 'admin.upstream_unavailable' };
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) return { ok: false, code: (data as { code?: string } | null)?.code ?? `http.${response.status}` };
      return { ok: true, data };
    },
    [csrf],
  );

  const read = useCallback(async () => {
    const [desk, baseline] = await Promise.all([post({ action: 'desk' }), post({ action: 'policy' })]);
    if (!desk.ok) setProblem(say(desk.code));
    else {
      const data = desk.data as { rules: Rule[]; alerts: Alert[]; notifications: { state: 'on' | 'down' } };
      setNotificationsState(data.notifications.state);
      setRules(data.rules);
      setAlerts(data.alerts);
    }
    if (!baseline.ok) setProblem(say(baseline.code));
    else setPolicy((baseline.data as { classes: PolicyClass[] }).classes);
    if (desk.ok && baseline.ok) setProblem(null);
  }, [post]);

  useEffect(() => {
    void read();
  }, [read]);

  async function saveRule() {
    setRuleNotice(null);
    const minutes = /^\d{1,4}$/.test(windowMinutes.trim()) ? Number(windowMinutes.trim()) : null;
    if (minutes === null || minutes < 1 || minutes > 1440) {
      setRuleProblem('Window must be a whole number of minutes from 1 to 1440.');
      return;
    }
    setBusy(true);
    const answer = await post({ action: 'createRule', name, measure, threshold, windowMinutes: minutes, agentId });
    setBusy(false);
    if (!answer.ok) setRuleProblem(say(answer.code));
    else {
      setRuleProblem(null);
      setRuleNotice(`Rule stored: ${(answer.data as Rule).name}.`);
    }
    await read();
  }

  async function evaluate() {
    setBusy(true);
    const answer = await post({ action: 'evaluate' });
    setBusy(false);
    if (!answer.ok) setProblem(say(answer.code));
    else setWindows((answer.data as { windows: Window[] }).windows);
    await read();
  }

  async function switchNotifications(state: 'on' | 'down') {
    setBusy(true);
    const answer = await post({ action: 'setNotifications', state });
    setBusy(false);
    if (!answer.ok) setProblem(say(answer.code));
    await read();
  }

  async function saveOverride() {
    setOverrideNotice(null);
    setBusy(true);
    const answer = await post({ action: 'setOverride', dataClass: overrideClass, choice: overrideChoice });
    setBusy(false);
    if (!answer.ok) setOverrideProblem(say(answer.code));
    else {
      setOverrideProblem(null);
      setPolicy((answer.data as { classes: PolicyClass[] }).classes);
      setOverrideNotice(`Override stored: ${CLASS_WORD[overrideClass]}, ${CHOICE_WORD[overrideChoice]}.`);
    }
  }

  async function check() {
    setBusy(true);
    const answer = await post({ action: 'checkRule', dataClass: checkClass, choice: checkChoice });
    setBusy(false);
    if (answer.ok) {
      const effective = (answer.data as { effective: Choice }).effective;
      setCheckVerdict(`Allowed: within the baseline (${CHOICE_WORD[effective]}).`);
    } else if (answer.code === 'agents.baseline_loosen_refused') setCheckVerdict('Refused: the baseline wins.');
    else setCheckVerdict(`Refused: ${say(answer.code)}`);
  }

  const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
  const choiceOrUnset = (choice: Choice | null): string => (choice ? CHOICE_WORD[choice] : 'not set');

  return (
    <div className="dk-stack" data-testid="agents-alerts">
      <h1>Agent alerts</h1>
      <p className="dk-muted">
        Get alerted when agents fail, refuse or cost too much. The evaluator reads each rule&rsquo;s current and previous window once a
        minute, and when you ask; it keeps one alert per rule and window.
      </p>
      <section role="region" aria-label="Alert notifications">
        <h2>Alert notifications</h2>
        <p role="note" className="adm-callout" data-tone="info">
          While notifications are on, each alert is handed to notifications: an inbox row for the operator who stored the rule, sent by
          email and push where vendor.email and vendor.push are set. While they are down, each alert is still kept here and shows delivery
          pending until they are back.
        </p>
        {notifications && (
          <p data-testid="notifications-state">{notifications === 'on' ? 'Notifications are on.' : 'Notifications are down.'}</p>
        )}
        {notifications === 'on' && (
          <button type="button" className="adm-btn" disabled={busy} onClick={() => void switchNotifications('down')}>
            Take notifications down
          </button>
        )}
        {notifications === 'down' && (
          <button type="button" className="adm-btn" disabled={busy} onClick={() => void switchNotifications('on')}>
            Bring notifications back
          </button>
        )}
      </section>
      {problem && (
        <p role="alert" className="adm-callout" data-tone="warn">
          {problem}
        </p>
      )}

      <form
        aria-label="New alert rule"
        className="dk-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void saveRule();
        }}
      >
        <h2>New alert rule</h2>
        <label>
          Rule name
          <input type="text" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Measure
          <select value={measure} onChange={(event) => setMeasure(event.target.value as Measure)}>
            {MEASURES.map((m) => (
              <option key={m} value={m}>
                {MEASURE_WORD[m]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Threshold ({measure === 'cost' ? 'fee asset, alert when above' : 'percent of the window’s actions, alert when above'})
          <input type="text" inputMode="decimal" value={threshold} onChange={(event) => setThreshold(event.target.value)} />
        </label>
        <label>
          Window (minutes)
          <input type="text" inputMode="numeric" value={windowMinutes} onChange={(event) => setWindowMinutes(event.target.value)} />
        </label>
        <label>
          Agent id (blank for every agent)
          <input type="text" value={agentId} maxLength={120} onChange={(event) => setAgentId(event.target.value)} />
        </label>
        {ruleProblem && (
          <p role="alert" className="adm-callout" data-tone="warn">
            {ruleProblem}
          </p>
        )}
        {ruleNotice && (
          <p role="status" className="adm-callout" data-tone="info">
            {ruleNotice}
          </p>
        )}
        <button type="submit" className="adm-btn" disabled={busy}>
          Save rule
        </button>
      </form>

      <section role="region" aria-label="Alert rules">
        <h2>Alert rules</h2>
        {rules.length === 0 ? (
          <p className="dk-muted">No rule is stored.</p>
        ) : (
          <div className="dk-table-wrap">
            <table className="dk-table">
              <thead>
                <tr>
                  <th scope="col">Rule</th>
                  <th scope="col">Measure</th>
                  <th scope="col">Alert when above</th>
                  <th scope="col">Window</th>
                  <th scope="col">Agent</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td>{rule.name}</td>
                    <td>{MEASURE_WORD[rule.measure]}</td>
                    <td data-testid="rule-threshold">{valueWords(rule.measure, rule.threshold)}</td>
                    <td>{rule.windowMinutes} min</td>
                    <td>{rule.agentId ?? 'Every agent'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div>
        <button type="button" className="adm-btn" disabled={busy} onClick={() => void evaluate()}>
          Evaluate now
        </button>
      </div>
      {windows && (
        <section role="region" aria-label="Last evaluation">
          <h2>Last evaluation</h2>
          <div className="dk-table-wrap">
            <table className="dk-table">
              <thead>
                <tr>
                  <th scope="col">Rule</th>
                  <th scope="col">Window</th>
                  <th scope="col">Actions</th>
                  <th scope="col">Value</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {windows.map((w) => {
                  const rule = ruleById.get(w.ruleId);
                  return (
                    <tr key={`${w.ruleId}:${w.windowStart}`}>
                      <td>{rule?.name ?? w.ruleId}</td>
                      <td>{span(w.windowStart, w.windowEnd)}</td>
                      <td>{w.actionRows}</td>
                      <td data-testid="window-rate">
                        {w.value === null ? 'No rows in this window' : rule ? valueWords(rule.measure, w.value) : w.value}
                      </td>
                      <td data-testid="window-result">
                        {w.value === null
                          ? 'Nothing fired'
                          : !w.breached
                            ? 'Within the threshold'
                            : w.alertWritten
                              ? 'Alert written'
                              : 'Alert already kept for this window'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section role="region" aria-label="Alerts">
        <h2>Alerts</h2>
        {alerts.length === 0 ? (
          <p className="dk-muted">No alert has fired.</p>
        ) : (
          <div className="dk-table-wrap">
            <table className="dk-table">
              <thead>
                <tr>
                  <th scope="col">Rule</th>
                  <th scope="col">Window</th>
                  <th scope="col">Actions</th>
                  <th scope="col">Value</th>
                  <th scope="col">Alert when above</th>
                  <th scope="col">Delivery</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((alert) => (
                  <tr key={alert.id} data-alert-id={alert.id}>
                    <td>{alert.ruleName}</td>
                    <td data-testid="alert-window">{span(alert.windowStart, alert.windowEnd)}</td>
                    <td>{alert.actionRows}</td>
                    <td>{valueWords(alert.measure, alert.value)}</td>
                    <td>{valueWords(alert.measure, alert.threshold)}</td>
                    <td data-testid="alert-delivery">{alert.delivery === 'pending' ? 'Delivery pending' : 'Handed to notifications'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section role="region" aria-label="Managed policy baseline">
        <h2>Managed policy baseline</h2>
        <p className="dk-muted">
          The owner&rsquo;s baseline per tool class: the loosest standing choice an override or a person&rsquo;s rule may take. An override
          for this environment may only narrow it, and every tool call meets the stricter of the two.
        </p>
        {policy && (
          <dl className="dk-row">
            {policy.map((entry) => (
              <div key={entry.dataClass} data-class={entry.dataClass}>
                <dt>{CLASS_WORD[entry.dataClass]}</dt>
                <dd data-testid="baseline-choice">Baseline: {choiceOrUnset(entry.baseline)}</dd>
                <dd data-testid="override-choice">Override: {entry.override ? CHOICE_WORD[entry.override] : 'none'}</dd>
                <dd data-testid="effective-choice">Applies: {choiceOrUnset(entry.effective)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <form
        aria-label="Environment override"
        className="dk-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void saveOverride();
        }}
      >
        <h2>Environment override</h2>
        <label>
          Requirement
          <select value={overrideClass} onChange={(event) => setOverrideClass(event.target.value as DataClass)}>
            {DATA_CLASSES.map((c) => (
              <option key={c} value={c}>
                {CLASS_WORD[c]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Value
          <select value={overrideChoice} onChange={(event) => setOverrideChoice(event.target.value as Choice)}>
            {CHOICES.map((c) => (
              <option key={c} value={c}>
                {CHOICE_WORD[c]}
              </option>
            ))}
          </select>
        </label>
        {overrideProblem && (
          <p role="alert" className="adm-callout" data-tone="warn">
            {overrideProblem}
          </p>
        )}
        {overrideNotice && (
          <p role="status" className="adm-callout" data-tone="info">
            {overrideNotice}
          </p>
        )}
        <button type="submit" className="adm-btn" disabled={busy}>
          Save override
        </button>
      </form>

      <form
        aria-label="Check a rule"
        className="dk-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void check();
        }}
      >
        <h2>Check a rule</h2>
        <p className="dk-muted">
          A person&rsquo;s standing rule for a tool class, checked against the baseline and this environment&rsquo;s override. Nothing is
          stored.
        </p>
        <label>
          Tool class
          <select value={checkClass} onChange={(event) => setCheckClass(event.target.value as DataClass)}>
            {DATA_CLASSES.map((c) => (
              <option key={c} value={c}>
                {CLASS_WORD[c]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Rule
          <select value={checkChoice} onChange={(event) => setCheckChoice(event.target.value as Choice)}>
            {CHOICES.map((c) => (
              <option key={c} value={c}>
                {CHOICE_WORD[c]}
              </option>
            ))}
          </select>
        </label>
        {checkVerdict && <p role="status">{checkVerdict}</p>}
        <button type="submit" className="adm-btn" disabled={busy}>
          Check
        </button>
      </form>
    </div>
  );
}
