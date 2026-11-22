import { useEffect, useState, type FormEvent } from 'react';
import { Button, Field, Select } from '@intafaced/ui/lit';
import type { RoomState } from '@intafaced/ui/lit/templates';
import { useSession } from '../../session';
import { CATEGORY_CHANNELS } from '../../../screens/notifications/notify-api';
import { useCategoryPrefs } from '../../../screens/notifications/use-category-prefs';
import { useBankRead, useSpaces } from '../components';
import { reminderLeadChoices, rulesWrites, type ReminderRule } from '../contracts';
import { BankSettingsRoom } from '../bank-settings/BankSettingsRoom';
import { Failure, Loading, Panel, useRoomRefusal } from '../bank-settings/parts';
import { choiceWords } from '../Rules';
import { rulesCopy } from '../rules-copy';

/**
 * `/bank/rules` (J-bank-06 #6, BK-acct-10): the person's payment reminder rule (how long before each standing order
 * runs they hear about it, saved under its business key `reminder:<person>`), the failure notices that need no rule, and
 * the account's own notification choices those notices follow, read from the notification service and changed there.
 * Rules that move money by themselves are on the screen in full and refused by the bank until the owner publishes their
 * terms (`bank.rule_terms_unset`).
 */

type Copy = ReturnType<typeof rulesCopy.useCopy>['t'];
type Lead = (typeof reminderLeadChoices)[number];

const leadWords = (t: Copy, lead: Lead | null) => (lead === null ? t('lead_off') : t(`lead_${lead}`));
const isLead = (value: number): value is Lead => (reminderLeadChoices as readonly number[]).includes(value);

type Said = { kind: 'saved' | 'error'; words: string } | null;

/**
 * The reminder rule. What a save said is held by the page (`said`), not here: a save reloads the rule, and the panel is
 * drawn again from the answer, so its message must outlive this panel.
 */
function ReminderPanel({
  rule,
  choices,
  said,
  setSaid,
  onSaved,
}: {
  rule: ReminderRule | null;
  choices: readonly number[];
  said: Said;
  setSaid: (said: Said) => void;
  onSaved: () => void;
}) {
  const { t } = rulesCopy.useCopy();
  const { api } = useSession();
  const [choice, setChoice] = useState<string>(rule?.leadHours ? String(rule.leadHours) : 'off');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  useEffect(() => setChoice(rule?.leadHours ? String(rule.leadHours) : 'off'), [rule?.leadHours, rule?.revision]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaid(null);
    const leadHours = choice === 'off' ? null : (Number(choice) as Lead);
    const answer = await api.mutate(
      'bank',
      'rules.setReminder',
      // One id per attempt at one choice: a retry of a lost answer is the same write, and another choice is a new one.
      { leadHours, expectedRevision: rule?.revision ?? 0, clientRequestId: `reminder:${rule?.revision ?? 0}:${choice}:${requestId}` },
      rulesWrites.setReminder,
    );
    setBusy(false);
    if (!answer.ok) {
      const words =
        answer.code === 'bank.reminder_revision_conflict'
          ? t('remindConflict')
          : answer.code === 'bank.reminder_lead_invalid'
            ? t('remindInvalid')
            : answer.message;
      setSaid({ kind: 'error', words: answer.code ? `${words} ${t('reference', { code: answer.code })}` : words });
      if (answer.code === 'bank.reminder_revision_conflict') onSaved();
      return;
    }
    setRequestId(crypto.randomUUID());
    setSaid({ kind: 'saved', words: t('ruleSaved', { key: answer.data.ruleKey, revision: String(answer.data.revision) }) });
    onSaved();
  }

  return (
    <Panel id="rules-reminders" title={t('remindTitle')} lead={t('remindLead')}>
      <form onSubmit={(event) => void save(event)} data-testid="rules-reminder">
        <Select
          label={t('remindLabel')}
          value={choice}
          onChange={setChoice}
          options={[
            { value: 'off', label: t('lead_off') },
            ...choices.filter(isLead).map((lead) => ({ value: String(lead), label: t(`lead_${lead}`) })),
          ]}
        />
        <p className="lt-hint" data-testid="rules-reminder-current" data-rule-key={rule?.ruleKey ?? ''}>
          {rule
            ? t('ruleCurrent', { key: rule.ruleKey, revision: String(rule.revision), choice: leadWords(t, rule.leadHours) })
            : t('ruleNone')}
        </p>
        <div className="lt-actions">
          <Button type="submit" tone="primary" disabled={busy}>
            {busy ? t('saving') : t('save')}
          </Button>
        </div>
        {said && <p role={said.kind === 'error' ? 'alert' : 'status'}>{said.words}</p>}
      </form>
    </Panel>
  );
}

/** The account's `orders` choices, as the notification service holds them: the bank's notices are sent under them. */
function ChoicesPanel() {
  const { t } = rulesCopy.useCopy();
  const { load, reload } = useCategoryPrefs();
  const choices = load.status === 'ready' ? { status: 'ready' as const, rows: load.rows.filter((row) => row.category === 'orders') } : load;
  return (
    <Panel id="rules-choices" title={t('choicesTitle')} lead={t('choicesLead', { category: t('category') })}>
      {choices.status === 'loading' && <Loading />}
      {choices.status === 'failed' && (
        <p role="alert">
          {t('choicesFailed')}{' '}
          <Button tone="quiet" onClick={reload}>
            {t('choicesRetry')}
          </Button>
        </p>
      )}
      {choices.status === 'ready' && (
        <div>
          <table className="lt-table" data-testid="rules-choices">
            <thead>
              <tr>
                <th scope="col">{t('colChannel')}</th>
                <th scope="col">{t('colChoice')}</th>
              </tr>
            </thead>
            <tbody>
              {CATEGORY_CHANNELS.map((channel) => {
                const row = choices.rows.find((one) => one.channel === channel);
                const live = !!row && !row.notConnected && row.configured;
                return (
                  <tr key={channel} data-testid={`rules-choice-${channel}`} data-enabled={String(live && !!row?.enabled)}>
                    <td>{t(`channel_${channel}`)}</td>
                    <td>{choiceWords(t, row)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p>
        <a className="lt-link" href="/notifications?view=settings">
          {t('choicesChange')}
        </a>
      </p>
    </Panel>
  );
}

/** The money rule editor: every field there, and saving is the bank's own refusal while the terms are unpublished. */
function MoneyRulePanel({ code }: { code: string }) {
  const { t } = rulesCopy.useCopy();
  const { api } = useSession();
  const spaces = useSpaces(50);
  const [form, setForm] = useState({ name: '', from: '', to: '', trigger: 'date', cadence: 'monthly', above: '', amount: '' });
  const [requestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((now) => ({ ...now, [key]: event.target.value }));
  const decimal = /^\d+(\.\d{1,18})?$/;
  const complete =
    form.name.trim() !== '' &&
    form.from !== '' &&
    form.to !== '' &&
    form.from !== form.to &&
    decimal.test(form.amount) &&
    (form.trigger === 'date' || decimal.test(form.above));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!complete) return setSaid(t('moneyIncomplete'));
    setBusy(true);
    setSaid(null);
    const answer = await api.mutate(
      'bank',
      'rules.createMoneyRule',
      {
        name: form.name.trim(),
        fromSpaceId: form.from,
        toSpaceId: form.to,
        trigger: form.trigger === 'date' ? { kind: 'date', cadence: form.cadence } : { kind: 'balance', above: form.above },
        amount: form.amount,
        clientRequestId: `money-rule:${requestId}`,
      },
      rulesWrites.createMoneyRule,
    );
    setBusy(false);
    if (answer.ok) return;
    const words = answer.code === 'bank.rule_terms_unset' ? t('moneyRefused') : answer.message;
    setSaid(answer.code ? `${words} ${t('reference', { code: answer.code })}` : words);
  }

  const options = spaces.resource.status === 'ready' ? spaces.resource.data : [];
  return (
    <Panel id="rules-money" title={t('moneyTitle')} lead={t('moneyLead')}>
      <p role="note" data-testid="rules-money-not-set">
        {t('moneyNotSet')} <small className="lt-hint">{t('reference', { code })}</small>
      </p>
      {spaces.resource.status === 'failed' && <Failure result={spaces.resource.failure} retry={spaces.reload} />}
      <form onSubmit={(event) => void save(event)} noValidate data-testid="rules-money">
        <Field label={t('moneyName')} value={form.name} maxLength={60} onChange={set('name')} />
        <label className="lt-field">
          <span>{t('moneyFrom')}</span>
          <select value={form.from} onChange={set('from')}>
            <option value="">{t('pickSpace')}</option>
            {options.map((space) => (
              <option key={space.id} value={space.id} lang="und">
                {space.name} ({space.assetId})
              </option>
            ))}
          </select>
        </label>
        <label className="lt-field">
          <span>{t('moneyTo')}</span>
          <select value={form.to} onChange={set('to')}>
            <option value="">{t('pickSpace')}</option>
            {options.map((space) => (
              <option key={space.id} value={space.id} lang="und">
                {space.name} ({space.assetId})
              </option>
            ))}
          </select>
        </label>
        <Select
          label={t('moneyTrigger')}
          value={form.trigger}
          onChange={(value) => set('trigger')({ target: { value } })}
          options={[
            { value: 'date', label: t('trigger_date') },
            { value: 'balance', label: t('trigger_balance') },
          ]}
        />
        {form.trigger === 'date' ? (
          <Select
            label={t('moneyCadence')}
            value={form.cadence}
            onChange={(value) => set('cadence')({ target: { value } })}
            options={[
              { value: 'daily', label: t('cadence_daily') },
              { value: 'weekly', label: t('cadence_weekly') },
              { value: 'monthly', label: t('cadence_monthly') },
            ]}
          />
        ) : (
          <Field label={t('moneyAbove')} value={form.above} inputMode="decimal" onChange={set('above')} />
        )}
        <Field label={t('moneyAmount')} value={form.amount} inputMode="decimal" onChange={set('amount')} />
        <div className="lt-actions">
          <Button type="submit" tone="primary" disabled={busy}>
            {t('moneySave')}
          </Button>
        </div>
        {said && <p role="alert">{said}</p>}
      </form>
    </Panel>
  );
}

/** The room's sections, each a link to its part of the page. */
const SECTIONS = [
  ['rules-reminders', 'remindTitle'],
  ['rules-failed', 'failedTitle'],
  ['rules-choices', 'choicesTitle'],
  ['rules-money', 'moneyTitle'],
] as const;

/** `/bank/rules`: payment reminders, failure notices, notification choices and money rules, inside Transfers (J-bank-06 #6). */
export function RulesRoom() {
  const { t } = rulesCopy.useCopy();
  const refusalOf = useRoomRefusal();
  const view = useBankRead('rules.get', undefined);
  const [said, setSaid] = useState<Said>(null);
  let state: RoomState = { kind: 'ready' };
  let retry: (() => void) | undefined;
  if (view.resource.status === 'loading') state = { kind: 'loading' };
  else if (view.resource.status === 'failed') {
    const failed = refusalOf(view.resource.failure);
    state = { kind: 'refused', refusal: failed.refusal };
    if (failed.retry) retry = view.reload;
  }
  const data = view.resource.status === 'ready' ? view.resource.data : null;
  return (
    <BankSettingsRoom
      room="Transfers"
      title={t('title')}
      description={t('description')}
      state={state}
      retry={retry}
      sectionsLabel={t('sectionsLabel')}
      sections={SECTIONS.map(([id, key]) => [id, t(key)] as const)}
      index={
        <a className="lt-link" href="/bank/transfers">
          {t('back')}
        </a>
      }
      explain={t('explain')}
    >
      {data ? (
        <>
          <ReminderPanel rule={data.reminder} choices={data.leadChoices} said={said} setSaid={setSaid} onSaved={view.reload} />
          <Panel id="rules-failed" title={t('failedTitle')} lead={t('failedLead')}>
            {null}
          </Panel>
          <ChoicesPanel />
          <MoneyRulePanel code={data.moneyRules.code} />
        </>
      ) : null}
    </BankSettingsRoom>
  );
}
